// ─────────────────────────────────────────────────────────────────────────────
// teamCompDisplay.ts — pure display-logic helpers for TeamComp.tsx's boxed
// Teams section, kept in a JSX-free module deliberately: this repo's Vitest
// harness has no React/JSX transform configured (see vitest.config.ts — no
// @vitejs/plugin-react), and TeamComp.tsx is a "use client" component file
// that DOES contain real JSX. Importing a JSX-bearing .tsx straight into a
// .test.ts file trips vite's import-analysis lexer on the untransformed JSX
// (tsconfig's `jsx: "preserve"` tells esbuild not to strip it) — every other
// unit-tested module in this repo (itemDetail.ts, runeDetail.ts,
// skillOrderGrid.ts, StatBadge.tsx) happens to contain zero actual JSX tags,
// which is why this never surfaced before. Splitting pure logic out here
// keeps the "pure-function-only, no JSX harness" test convention intact
// without touching the shared vitest config.
// ─────────────────────────────────────────────────────────────────────────────

// Positional role labels — used two ways: ROSTER_ROLE_LABELS (full words) for
// the legacy icon-only fallback body (unchanged from before this redesign),
// ROLE_ABBR (short form, "Jg"/"Sup") for the new per-player rows where
// horizontal space is tighter. Both are display-only hints, index- or
// role-field-derived — never a reorder; array order is left exactly as the
// API returns it, and an unexpected roster length degrades to no role hint
// rather than guessing.
export const ROSTER_ROLE_LABELS = ["Top", "Jungle", "Mid", "Bot", "Support"] as const;
export const ROLE_ABBR = ["Top", "Jg", "Mid", "Bot", "Sup"] as const;

export const STANDARD_ROSTER_LENGTH = 5;

/** Resolve a per-player row's role abbreviation. Prefers the roster slot's
 *  own `role` field (0-4) when it's a valid index into ROLE_ABBR; falls back
 *  to the row's position ONLY when the roster is the standard 5-length
 *  (matching the pre-existing TeamRosterRow convention) so an unexpected
 *  roster shape never guesses a wrong lane. */
export function roleAbbrForPlayer(
  role: number | null | undefined,
  index: number,
  rosterLength: number
): string | undefined {
  if (typeof role === "number" && role >= 0 && role < ROLE_ABBR.length) return ROLE_ABBR[role];
  if (rosterLength === ROLE_ABBR.length) return ROLE_ABBR[index];
  return undefined;
}

/** Box header title. Prefers a real backend-resolved team name (`realName`,
 *  read defensively by GameDetailSheet from a not-yet-landed field — see
 *  HANDOFF-fronty.md); degrades to "Ally team" (with the tracked player's own
 *  team appended when known — `game.player.team`, already on-contract today)
 *  or a plain "Enemy team" once no real name is available. */
export function teamBoxTitle(
  side: "ally" | "enemy",
  realName: string | null | undefined,
  trackedPlayerTeam?: string | null
): string {
  if (realName) return realName;
  if (side === "ally") return trackedPlayerTeam ? `Ally team — ${trackedPlayerTeam}` : "Ally team";
  return "Enemy team";
}

/** Whether a WIN/LOSS chip is safely derivable for a box header: only when
 *  the tracked player's champion actually appears in the ally roster (the
 *  contract guarantees this, but the box header chip is cosmetic — degrade
 *  to no chip rather than trust an invariant blindly). */
export function isSelfInAlly(allyChampionIds: number[], selfChampionId: number): boolean {
  return allyChampionIds.includes(selfChampionId);
}
