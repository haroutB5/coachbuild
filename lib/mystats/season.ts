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
