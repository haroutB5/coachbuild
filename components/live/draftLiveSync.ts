// ─────────────────────────────────────────────────────────────────────────────
// draftLiveSync.ts — pure "should /draft auto-fill from the companion" decision,
// split out of app/draft/page.tsx the same way champSelectFollow.ts was split
// out of app/page.tsx: no React, no fetch, unit-testable without mounting
// anything (plan §6c / §8).
//
// /draft consumes CompanionProvider READ-ONLY (see CompanionProvider.tsx) —
// it never writes back to champSelectFollowState.ts's singleton or calls any
// companion POST (plan §7 compliance: /draft never auto-picks or applies
// anything). This module only decides WHAT the live session implies the
// draft inputs (lane/enemies/hover) should be, and whether that implication
// should currently win over the user's own manual edits.
//
// Manual-override "dirty latch": once the user edits lane/enemies/hover by
// hand, live auto-fill stops overwriting their work until they explicitly
// tap "Reset to live" (or a NEW champ-select entry starts, at the caller's
// discretion — this module doesn't own that policy, it just answers
// "should live values apply right now" for whatever `dirty` the caller
// passes in).
// ─────────────────────────────────────────────────────────────────────────────

import type { CompanionChampSelectSnapshot } from "./companionClient";
import type { LaneId } from "@/components/hextech/heroContracts";
import { roleIdToLane, type LiveRoleId } from "./deepLink";
import { resolveCurrentChampSelectChampionId } from "./champSelectFollow";

const VALID_ROLES: readonly LiveRoleId[] = [0, 1, 2, 3, 4];

/** Max enemies /draft's picker + the recommend API care about — a full
 *  enemy team is 5; anything beyond that in a malformed/garbage theirTeam
 *  array is dropped rather than silently growing the picker past what the
 *  UI (5 chip slots) or the API (plan §4) expect. */
export const MAX_DRAFT_ENEMIES = 5;

/** Dedupe + cap a raw championId list to at most MAX_DRAFT_ENEMIES, dropping
 *  non-positive/duplicate entries. Order-preserving (first occurrence wins)
 *  — no functional dependency on the order today (audit P2-1 removed the
 *  index-based lane-opponent inference that used to rely on it), kept
 *  stable anyway so the enemy chip list doesn't visually reshuffle on
 *  every poll tick. */
export function normalizeDraftEnemyIds(ids: readonly number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_DRAFT_ENEMIES) break;
  }
  return out;
}

export interface DraftLiveSyncInput {
  phase: string | null;
  champSelect: CompanionChampSelectSnapshot | null;
  /** False when the phase/snapshot is no longer backed by a recent poll. */
  statusFresh?: boolean;
  /** True once the user has manually edited lane/enemies/hover since the
   *  last live sync (or since mount) — the caller owns exactly when this
   *  flips true/false (see "Reset to live"); this module only reacts to it. */
  dirty: boolean;
}

export interface DraftLiveTarget {
  /** undefined when champ-select never resolved a role (blank/unmapped
   *  assignedPosition) — same role-less contract as deepLink.ts/
   *  champSelectFollow.ts. Caller keeps whatever lane is already selected. */
  lane: LaneId | undefined;
  /** Deduped, order-preserved, capped at MAX_DRAFT_ENEMIES. */
  enemies: number[];
  /** The local player's own champion resolution (cellChampionId ->
   *  pickIntent -> actionChampionId), for the hover-your-champ picker. Null
   *  when nothing has resolved yet. */
  hover: number | null;
}

/** Returns the live target `/draft` should apply, or null when nothing
 *  should be auto-filled right now (not in ChampSelect, no snapshot yet, or
 *  the user has dirtied their own manual edits).
 *
 * AUDIT P2-1 FIX (2026-07-21, REMOVED): this used to also return a
 * `laneOpponentIndex`, inferring the direct-lane opponent as
 * `theirTeam[localPlayerRoleId]` — that assumed theirTeam's slot order
 * mirrors display position, but companion.ps1's Get-TheirTeamChampionIds
 * (and this module's own normalizeDraftEnemyIds) COMPACTS the array —
 * unresolved enemies are omitted entirely, not left as holes — so by the
 * companion's own SelfTest fixture, 3 real theirTeam slots can decode to a
 * 2-element array ([45, 91]). Index no longer equals role the moment any
 * earlier enemy is unresolved, which is the common case mid-draft (not an
 * edge case). Live mode now sends `enemies` with NO laneOpp at all and
 * relies entirely on the server's statistical inference
 * (meta.laneOppInferred, lib/draft/recommend.ts) plus the user's own chip
 * tap (handleToggleLaneOpponent in app/draft/page.tsx) for manual mode —
 * both already work correctly without any index-based guessing here. */
export function resolveDraftLiveTarget(input: DraftLiveSyncInput): DraftLiveTarget | null {
  if (input.statusFresh === false) return null;
  if (input.dirty) return null;
  if (input.phase !== "ChampSelect") return null;
  if (!input.champSelect) return null;

  const rawRole = input.champSelect.roleId;
  const roleId = rawRole !== null && VALID_ROLES.includes(rawRole as LiveRoleId) ? (rawRole as LiveRoleId) : undefined;
  const lane = roleId !== undefined ? roleIdToLane(roleId) : undefined;
  const enemies = normalizeDraftEnemyIds(input.champSelect.theirTeam);
  const hover = resolveCurrentChampSelectChampionId(input.champSelect);

  return { lane, enemies, hover };
}

/** Whether /draft should currently show its "Reset to live" affordance —
 *  only meaningful once the user has actually dirtied their manual edits
 *  AND there's a live champ-select to reset back to (showing the button
 *  with nothing live behind it would be a dead-end control). */
export function shouldShowResetToLive(
  dirty: boolean,
  phase: string | null,
  champSelect: CompanionChampSelectSnapshot | null,
  statusFresh = true
): boolean {
  return statusFresh && dirty && phase === "ChampSelect" && champSelect !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Champ-select ENTRY detection (v0.40.0 — user-reported P0: live pickup
// permanently died after any manual edit). Root cause: `dirty` (app/draft/
// page.tsx) is latched by every manual handler, including handleClearHover,
// and was previously cleared ONLY by an explicit "Reset to live" tap — so
// one Clear tap in game 1's champ select silently detached the page from
// EVERY subsequent champ select the user ever entered (a real live repro:
// game 1 fresh page -> hover auto-filled -> user tapped Clear -> dirty
// latched -> game 2's champ select -> hover filled NOTHING).
//
// Fix: auto-reset `dirty` on the champ-select ENTRY transition (previous
// real phase != "ChampSelect", new phase == "ChampSelect") — never on the
// steady state (repeated "ChampSelect" ticks), so manual edits still win
// within the SAME champ select (preserves the "follow fights user" lesson).
// This module only detects the transition; app/draft/page.tsx's live-sync
// effect is the one that actually calls setDirty(false) on isEntry.
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks the last REAL (non-null) phase seen, across poll ticks, so entry
 *  detection can ignore transient null blips entirely rather than
 *  mistaking one for a genuine phase change. `lastRealPhase: null` means
 *  "no real phase observed yet" (fresh mount, or every tick so far has been
 *  null/no-session). */
export interface ChampSelectEntryState {
  lastRealPhase: string | null;
}

/** Starting state for a freshly-mounted /draft page — no phase observed
 *  yet, so the very first "ChampSelect" tick (if the user opens /draft
 *  already mid-champ-select) correctly counts as an entry too. */
export const INITIAL_CHAMP_SELECT_ENTRY_STATE: ChampSelectEntryState = { lastRealPhase: null };

export interface ChampSelectEntryResult {
  /** True exactly on the tick where `phase` is "ChampSelect" AND the most
   *  recently observed REAL phase (nulls skipped entirely) was something
   *  else. The caller should reset the manual-dirty latch on this tick only
   *  — never on repeated "ChampSelect" ticks (the steady state). */
  isEntry: boolean;
  /** Feed this back in as `prev` on the next tick's call. */
  next: ChampSelectEntryState;
}

/** Pure state-machine step (companion.tick-driven — see CompanionProvider's
 *  doc comment for why every tick, not just phase-identity changes, must be
 *  evaluated). `phase` is this tick's raw companion phase: a real phase
 *  string, or null on a transient /status poll failure — companion polling
 *  can flicker null between otherwise-real ticks (network blip, not a real
 *  LCU phase), and that blip must never be mistaken for "the user left
 *  champ select" or "the user entered champ select":
 *
 *    ChampSelect -> null -> ChampSelect   =>  NOT an entry. The null tick
 *      leaves `lastRealPhase` at "ChampSelect" (untouched), so the following
 *      real "ChampSelect" tick sees no transition — a single-tick blip mid-
 *      champ-select must never re-fire the dirty reset.
 *
 *    Lobby -> null -> ChampSelect         =>  IS an entry. `lastRealPhase`
 *      was "Lobby" going into the null tick (the null itself changes
 *      nothing) and is still "Lobby" when the real "ChampSelect" tick
 *      arrives, so the transition is correctly detected despite the blip
 *      sitting in between.
 *
 *  A null tick therefore ALWAYS returns `isEntry: false` and passes `prev`
 *  through unchanged — it carries no information, so it must not overwrite
 *  `lastRealPhase` with null (that would make the very next real phase,
 *  whatever it is, look like a fresh transition into it). */
export function resolveChampSelectEntry(prev: ChampSelectEntryState, phase: string | null): ChampSelectEntryResult {
  if (phase === null) return { isEntry: false, next: prev };
  const isEntry = phase === "ChampSelect" && prev.lastRealPhase !== "ChampSelect";
  return { isEntry, next: { lastRealPhase: phase } };
}
