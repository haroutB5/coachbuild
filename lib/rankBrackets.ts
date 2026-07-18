// ─────────────────────────────────────────────────────────────────────────────
// rankBrackets.ts — VERIFIED rank-bracket → coachless `leagueTiers` map (Feature 3)
//
// PROBE EVIDENCE (live api.coachless.gg, patch 16.13, Viktor mid, 2026-07-18):
//   GetKeystoneData with leagueTiers = [N] returned:
//     [3] → total occ 194,981   [4] → 217,139   [5] → 210,171
//     [6] → 101,057             [7] → 17,871     [8] → 5,116
//     [0] [1] [2] [10] → 0 rows (empty)
//   So the coachless model exposes tiers 3-8 and does NOT track 0-2 / 9-10.
//
// TIER → RANK MAPPING: coachless publishes no tier-name endpoint (all
// champion-list / tier-list endpoint probes 404'd). The mapping below is
// INFERRED from (a) the ladder-population shape above — Emerald is the game's
// modal rank, tapering monotonically up to a tiny Challenger bucket — and
// (b) the app's pre-existing HIGH_ELO_TIERS = [5,6,7] already labelled
// "High Elo" in BuildResponse.tierLabel, which lines up exactly with
// Diamond/Master/Grandmaster. It is self-consistent but UNCONFIRMED against a
// coachless UI label; the fronty UI wave should sanity-check the display names.
// The apiValue tier-sets themselves ARE verified — only the human labels are
// inferred, so a wrong label never produces wrong DATA.
//
// DEFAULT: the 'all' bracket is [5,6,7] — byte-identical to the app's historical
// default — so a request WITHOUT a rank param, or with rank='all', hits the
// exact same coachless query (and Next fetch-cache key) as before this feature.
// It is deliberately NOT the full 3-8 span: this app has always been a High-Elo
// tool, and widening the default would silently change every existing build.
// ─────────────────────────────────────────────────────────────────────────────

export interface RankBracket {
  id: string;
  label: string;
  /** coachless `leagueTiers` value. Verified to return populated data. */
  apiValue: number[];
}

/** The 'all' default MUST be first (UI renders it as the selected default). */
export const RANK_BRACKETS: RankBracket[] = [
  { id: "all", label: "High Elo", apiValue: [5, 6, 7] },
  { id: "challenger", label: "Challenger", apiValue: [8] },
  { id: "grandmaster", label: "Grandmaster", apiValue: [7] },
  { id: "master", label: "Master", apiValue: [6] },
  { id: "diamond", label: "Diamond", apiValue: [5] },
  { id: "emerald", label: "Emerald", apiValue: [4] },
  { id: "platinum", label: "Platinum", apiValue: [3] },
];

export const DEFAULT_RANK_BRACKET = RANK_BRACKETS[0];

/** Resolve a rank id (case-sensitive, as sent by the UI) to its bracket, or
 *  null if unknown. `null`/`undefined`/'' resolve to the default bracket —
 *  an absent param is the historical (High Elo) behaviour, never an error. */
export function resolveRankBracket(id: string | null | undefined): RankBracket | null {
  if (id == null || id === "") return DEFAULT_RANK_BRACKET;
  return RANK_BRACKETS.find((b) => b.id === id) ?? null;
}

/** True when more than one bracket exists — i.e. the API supports rank
 *  filtering and the UI should render the selector. (If a future probe ever
 *  disproves tier filtering, collapse RANK_BRACKETS to just 'all' and this
 *  flips false, telling the UI to hide the selector — see the module's own
 *  contract in the HANDOFF.) */
export const RANK_FILTERING_SUPPORTED = RANK_BRACKETS.length > 1;
