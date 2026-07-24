// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/season.ts — the 2026 ranked season boundary. My Stats is
// scoped to CURRENT SEASON ONLY (user refinement, 2026-07-21: personal
// build-inspiration data from a prior season's meta/items is stale/
// misleading, same rationale as lib/pro/fresh.ts's FRESH_WINDOW_DAYS, just
// season-grained instead of a rolling 90-day window).
//
// SEASON_START_MS SOURCE (verified via web search, 2026-07-21): patch
// 26.1/16.1 (Riot uses both "26.1" and "16.1" naming for the same patch —
// see leagueoflegends.com/en-us/news/game-updates/patch-26-1-notes/)
// shipped Wednesday, 2026-01-08, kicking off Season 16 (2026)'s first split
// ("Demacia") — corroborated independently by esports.gg's 2026 patch
// schedule and the LoL Wiki's "2026 Annual Cycle" page. Pinned to
// 00:00:00 UTC on that date rather than a specific server-rollout hour —
// the exact intra-day rollout time varies by region/server and isn't
// documented as a single global instant, so midnight UTC is the simplest
// unambiguous constant that errs on the side of INCLUDING the whole
// patch-day rather than arbitrarily excluding early games on it.
// ─────────────────────────────────────────────────────────────────────────────

export const SEASON_START_MS = Date.UTC(2026, 0, 8, 0, 0, 0); // 2026-01-08T00:00:00.000Z
export const SEASON_LABEL = "Season 2026";
/** The patch-label prefix every in-season row should carry — used only for
 *  the CROSS-CHECK (see checkSeasonAnomaly below), never as the primary
 *  keep/purge signal (that's always game_creation — patch strings are
 *  free-text derived from gameVersion and less authoritative than a Riot
 *  timestamp). */
export const SEASON_PATCH_PREFIX = "16.";

export function seasonStartEpochSec(): number {
  return Math.floor(SEASON_START_MS / 1000);
}

/** True iff a game_creation timestamp (epoch ms) falls within the current
 *  season. This IS the authoritative signal for keep/purge decisions
 *  (lib/mystats/ingest.ts's row-level guard, scripts/purge-mystats-preseason.mjs's
 *  DELETE) — patch label is only ever used as a secondary cross-check. */
export function isInSeason(gameCreationMs: number): boolean {
  return gameCreationMs >= SEASON_START_MS;
}

export interface MySeasonCheckRow {
  matchId: string;
  gameCreation: string; // ISO
  patch: string;
}

/** Cross-checks game_creation against the patch label for ONE row — both
 *  signals should agree on which side of the season boundary a row falls.
 *  Returns a human-readable reason when they DISAGREE, else null. This
 *  never decides keep/purge itself (game_creation alone does, per this
 *  file's header) — it only flags a row worth a human look, per the
 *  brief's "cross-check the two ... flag it rather than silently trusting
 *  one signal." A patch value that doesn't parse as a plain "MM.mm" label
 *  (empty string, degenerate ingest) is treated as "can't corroborate,"
 *  not as an automatic disagreement — there's nothing to compare. */
export function checkSeasonAnomaly(row: MySeasonCheckRow): string | null {
  if (!row.patch) return null;
  const gameCreationMs = new Date(row.gameCreation).getTime();
  if (Number.isNaN(gameCreationMs)) return `unparseable game_creation: "${row.gameCreation}"`;
  const inSeasonByTime = isInSeason(gameCreationMs);
  const inSeasonByPatch = row.patch.startsWith(SEASON_PATCH_PREFIX);
  if (inSeasonByTime && !inSeasonByPatch) {
    return `game_creation is in-season but patch "${row.patch}" is not ${SEASON_PATCH_PREFIX}x`;
  }
  if (!inSeasonByTime && inSeasonByPatch) {
    return `patch "${row.patch}" is ${SEASON_PATCH_PREFIX}x but game_creation is pre-season`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT BOUNDARIES (v0.51, My Stats build-adherence + KDA ship) — within the
// annual "Season 2026" (SEASON_LABEL above, which never changes), Riot itself
// runs three shorter named periods it calls "Season 1/2/3" (a genuine naming
// collision with this file's own SEASON_* constants -- this file calls Riot's
// sub-periods "splits" throughout to keep the two concepts distinguishable).
//
// SOURCE (verified via web search, 2026-07-24): nosmokesport.com's "Riot Games
// Confirms Official League Of Legends Patch Schedule For 2026" + corroborated
// by wiki.leagueoflegends.com/en-us/2026_Annual_Cycle --
//   Split 1 "For Demacia"  -> patch 26.1  (== 16.1  here) -> 2026-01-08 (== SEASON_START_MS)
//   Split 2 "Pandemonium"  -> patch 26.9  (== 16.9  here) -> 2026-04-29
//   Split 3 (unnamed yet)  -> patch 26.17 (== 16.17 here) -> 2026-08-26
// ("26.x" is Riot's marketing patch number; "16.x" is the internal one this
// file/lib/pro/extract.ts's patchFromGameVersion actually produces -- see this
// file's own SEASON_START_MS comment for that same 26/16 dual-naming note.)
//
// Used for: (a) tagging every my_matches row with which split it falls in at
// ingest time (see lib/mystats/extract.ts), so live display can filter to
// "this split" instead of the whole season: (b) lib/mystats/purge.ts's purge
// boundary, which now retires data older than the PRIOR split (instead of the
// whole-season boundary) so a delta against "last split" always has something
// to compare against, while anything older is eventually cleaned up.
export interface SplitBoundary {
  split: number;
  startMs: number;
}

export const SPLIT_BOUNDARIES: SplitBoundary[] = [
  { split: 1, startMs: SEASON_START_MS }, // "For Demacia", patch 16.1, 2026-01-08
  { split: 2, startMs: Date.UTC(2026, 3, 29) }, // "Pandemonium", patch 16.9, 2026-04-29
  { split: 3, startMs: Date.UTC(2026, 7, 26) }, // patch 16.17, 2026-08-26
];

/** The split a `gameCreation` timestamp (epoch ms) falls into -- the LATEST
 *  boundary at or before it. A timestamp before the very first boundary
 *  degrades to split 1 (there is no split 0) rather than 0/negative --
 *  shouldn't happen in practice since season scoping already excludes
 *  anything before SEASON_START_MS, which IS boundaries[0]. `boundaries` is
 *  injectable for tests; defaults to the real, sourced 2026 schedule above. */
export function splitForGameCreation(
  gameCreationMs: number,
  boundaries: SplitBoundary[] = SPLIT_BOUNDARIES
): number {
  let current = boundaries[0]?.split ?? 1;
  for (const b of boundaries) {
    if (gameCreationMs >= b.startMs) current = b.split;
    else break;
  }
  return current;
}

/** The split `now` currently falls into -- what a "current split" display
 *  filter compares a row's `split` column against. `now` is injectable for
 *  tests; defaults to the real clock. */
export function currentSplitNumber(
  now: () => number = Date.now,
  boundaries: SplitBoundary[] = SPLIT_BOUNDARIES
): number {
  return splitForGameCreation(now(), boundaries);
}

/** Start-of-PRIOR-split epoch ms, or null when there IS no prior split yet
 *  (currently in split 1 -- nothing precedes it within the season). Used by
 *  lib/mystats/purge.ts to compute a purge boundary that always keeps the
 *  prior split's rows intact (never just the current one). */
export function priorSplitStartMs(
  now: () => number = Date.now,
  boundaries: SplitBoundary[] = SPLIT_BOUNDARIES
): number | null {
  const current = currentSplitNumber(now, boundaries);
  const prior = boundaries.find((b) => b.split === current - 1);
  return prior ? prior.startMs : null;
}
