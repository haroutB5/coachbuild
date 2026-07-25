// ─────────────────────────────────────────────────────────────────────────────
// lib/lastChampion.ts — remembers the champion/lane you last looked at.
//
// WHY (2026-07-25, user directive): the Builds page opened on VIKTOR for
// everyone, forever. Not a preference and not a recommendation — `app/page.tsx`
// seeded its state with `STATIC_FALLBACK_LANE_CHAMPIONS.mid` purely so the
// first paint would pixel-match the original design mockup. The app was
// asserting a champion you never picked, exactly the way ironflow's Home used
// to assert a program you never chose.
//
// Restoring YOUR last champion is not the app deciding: it is your own most
// recent choice, which is the single best predictor of what you want next
// (you were looking at it minutes ago, and build pages get re-opened between
// games). When there is no such choice yet, the page shows a pick prompt
// rather than inventing one.
//
// Deliberately localStorage, not the DB: this is per-device UI continuity, it
// must survive a reload with zero network, and it is worthless to anyone else.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";

const KEY = "coachbuild:lastChampion:v1";

export interface LastChampion {
  champ: ChampionRef;
  lane: LaneId;
}

/** Never throws: a corrupt/absent/SSR value is simply "no last champion", which
 *  the caller renders as the pick prompt. */
export function readLastChampion(): LastChampion | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastChampion>;
    const champ = parsed?.champ;
    // Validate the shape rather than trusting it — a stale schema from an older
    // build must not crash the whole page on open.
    if (
      !champ ||
      typeof champ.id !== "number" ||
      typeof champ.name !== "string" ||
      typeof champ.key !== "string"
    ) {
      return null;
    }
    const lane = typeof parsed?.lane === "string" ? (parsed.lane as LaneId) : "mid";
    return { champ: champ as ChampionRef, lane };
  } catch {
    return null;
  }
}

export function writeLastChampion(champ: ChampionRef, lane: LaneId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ champ, lane }));
  } catch {
    // Quota/private-mode — continuity is a nicety, never worth an error.
  }
}
