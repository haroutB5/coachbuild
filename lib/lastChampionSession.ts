// ─────────────────────────────────────────────────────────────────────────────
// lib/lastChampionSession.ts — the mount/persist lifecycle rules behind
// "open on the champion YOU last looked at", extracted from app/page.tsx so
// they can actually be tested.
//
// ── Why this module exists (P0, 2026-07-26) ─────────────────────────────────
// The rules used to live inline in two `useEffect`s. One of them guarded on
// `lastChampHydrated` but NOT on `champChosen`, so on a brand-new device the
// persist effect ran with `champ` still sitting on the Viktor seed and wrote
// it to storage with no user action at all. The pick prompt therefore rendered
// correctly exactly ONCE per device: one reload later the page opened on
// VIKTOR MID — precisely the behaviour user directive 2026-07-25 ("stop
// showing viktor by default") removed.
//
// It shipped to production and survived 1,632 passing tests, because the bug
// is invisible on the visit that CREATES it. Nothing was observably wrong
// until the NEXT page load, and nothing in the suite loaded the page twice.
// That is the gap this module closes: the rules are now plain data-in/data-out
// functions with no React in them, so a test can drive visit 1 -> visit 2
// against real storage and assert on what a returning user actually sees.
//
// ── The invariant, stated once ─────────────────────────────────────────────
// PERSIST A SELECTION THE USER MADE, NEVER THE SEED THAT STANDS IN FOR ONE.
//
// `app/page.tsx` seeds `champ` with STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE]
// (Viktor) purely so SSR/first paint has something concrete to render. That
// seed is scaffolding, not a choice — it must never reach storage, because
// storage is read back as "what the user last looked at" and rendering it
// asserts a champion they never picked.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import type { LastChampion } from "@/lib/lastChampion";

/** What one page visit resolves to at mount, before any user interaction. */
export interface VisitSession {
  /** Always non-null so no downstream component has to learn a nullable
   *  contract — it is the SEED when nothing was stored. Pair it with `chosen`
   *  before treating it as a real selection. */
  champ: ChampionRef;
  lane: LaneId;
  /** True only when this champ came from an actual user selection (here: a
   *  restored one). False means `champ` is the seed and the page owes the user
   *  a pick prompt rather than a build. */
  chosen: boolean;
}

/** Resolve the landing state for a visit: the stored selection when there is
 *  one, otherwise the seed flagged as NOT chosen.
 *
 *  `stored` is whatever `readLastChampion()` returned — already shape-validated
 *  and null on absent/corrupt, so this function stays a pure branch. */
export function resolveVisitSession(
  seedChamp: ChampionRef,
  seedLane: LaneId,
  stored: LastChampion | null
): VisitSession {
  if (stored) return { champ: stored.champ, lane: stored.lane, chosen: true };
  return { champ: seedChamp, lane: seedLane, chosen: false };
}

/** Whether the page may write the current champion/lane to storage.
 *
 *  BOTH conditions are load-bearing and neither is redundant:
 *   - `hydrated` — writing before the mount read completes would clobber the
 *     stored value with the seed on first paint (the original guard).
 *   - `chosen`  — hydration COMPLETING does not mean the user has a selection.
 *     When nothing was stored, the effect still runs with the seed in hand.
 *     This is the condition whose absence caused the P0; see the module header
 *     before you consider it redundant with `hydrated`. */
export function shouldPersistLastChampion(state: { hydrated: boolean; chosen: boolean }): boolean {
  return state.hydrated && state.chosen;
}
