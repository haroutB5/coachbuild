import { filterToMyPool } from "@/components/live/personalBadge";
import type { PersonalRecord } from "@/components/live/draftRecommend";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";

/** Lane-level figures derived from the matchup matrix. `laneShare` is the
 * champion's aggregate lane games divided by the lane-wide aggregate. */
export interface DraftLaneStat {
  champId: number;
  baselineWr: number | null;
  totalGames: number | null;
  laneShare: number | null;
}

export interface DraftMatchupPreviewRow {
  oppId: number;
  winRate: number;
  games: number;
  opponentLaneShare: number;
}

export interface DraftMatchupPreview {
  champId: number;
  worst: DraftMatchupPreviewRow[];
  best: DraftMatchupPreviewRow[];
}

export interface DraftAssistantFilters {
  minPickRate: number;
  includeOffMeta: boolean;
  minimumGames: number;
}

/** Opt-in filters: the first paint must remain populated for every lane.
 *
 *  v0.109.0 — `minimumGames` DEFAULTED TO 1000 and therefore was not opt-in at
 *  all, which the line above already claimed it was. That contradiction was
 *  harmless while /draft served u.gg tier 10, where 1,000 games is ~0.02% of a
 *  4.86M-game lane and the filter passed essentially everything. v0.108.0 moved
 *  /draft to tier 15 (~601k games per lane) and this number came along
 *  unexamined, at which point the DEFAULT client filter became STRICTER than
 *  the server's own pool floor (601 games) — it silently removed champions the
 *  engine had deliberately included and scored.
 *
 *  MEASURED two ways, patch 16.14 tier 15, because the two numbers are
 *  different and only one of them is what a user sees:
 *  - POOL: champions served by the engine vs. champions this default would
 *    admit, per lane (top/jungle/mid/bot/support) —
 *      served       : 114 / 73 / 101 / 71 / 81
 *      at min 1,000 :  98 / 70 /  87 / 59 / 70
 *    so the filter contradicted the engine on 16/3/14/12/11 champions.
 *  - ACTUALLY RENDERED, which is the smaller and more honest figure: of the
 *    10 rows the engine returns for an empty enemy set, this default removed
 *    2 in mid (869 and 642 lane games) and 2 in bot (700 and 924), and 0 in
 *    top/jungle/support. The ranked lists are top-N of the most-played, so
 *    most rows clear 1,000 anyway; the filter bites hardest exactly where the
 *    page is trying to surface a thinner, more interesting candidate.
 *  Either way it is a control the user never touched removing rows the server
 *  deliberately scored, which is the behaviour being fixed — not the size of
 *  the count.
 *
 *  Default is now 0: the server-side lane-share floor is the principled gate
 *  and it reports what it removed (RecommendMeta.poolTotal/poolIncluded); this
 *  control is for a user who wants to narrow further, which is what "opt-in"
 *  means. See MINIMUM_GAMES_OPTIONS in app/draft/page.tsx for the option values,
 *  which were rescaled in the same change. */
export const DEFAULT_DRAFT_ASSISTANT_FILTERS: DraftAssistantFilters = {
  minPickRate: 0,
  includeOffMeta: true,
  minimumGames: 0,
};

export interface FilterableDraftCandidate {
  champId: number;
  laneShare: number | null;
  totalGames: number | null;
}

/** Off-meta is a property of the lane-share figure, never of personal data or
 *  the nullable `draft_champ_stats.pickrate` decoder stub. */
export function isOffMetaLaneShare(laneShare: number | null): boolean {
  return laneShare !== null && laneShare < POOL_MIN_PICKRATE;
}

/** Apply the Draft Assistant's real filter controls without changing input
 *  order. Unknown figures are excluded because a filter cannot honestly pass
 *  a row whose lane-share or total-games denominator is unavailable. */
export function filterDraftAssistantCandidates<T extends FilterableDraftCandidate>(
  candidates: T[],
  filters: DraftAssistantFilters
): T[] {
  return candidates.filter((candidate) => {
    if (candidate.totalGames === null || candidate.totalGames < filters.minimumGames) return false;
    if (candidate.laneShare === null) return false;
    if (candidate.laneShare < filters.minPickRate) return false;
    if (!filters.includeOffMeta && isOffMetaLaneShare(candidate.laneShare)) return false;
    return true;
  });
}

/** Counters is a real matchup view, not an alias for Recommended: `score`
 *  already contains the shrunk terms against the entered enemies, and
 *  `synergyDelta` is that score's change from the candidate's own baseline.
 *  A positive delta is the honest favourable-matchup predicate. */
export function filterCounterCandidates<T extends { synergyDelta: number }>(items: T[]): T[] {
  return items.filter((item) => Number.isFinite(item.synergyDelta) && item.synergyDelta > 0);
}

export interface DraftAssistantCandidate {
  champId: number;
  winRate: number;
  floor: number | null;
  totalGames: number | null;
  laneShare: number | null;
  rank: number;
  isPotential: boolean;
  personalOverall: PersonalRecord;
  source: "recommended" | "blind";
  /** Display-only matchup swing carried through when the row comes from the
   *  recommend feed. Older/unit-test fixtures may omit it, which is treated
   *  as an even swing rather than changing ranking behavior. */
  synergyDelta?: number;
}

export type DraftTier = "S+" | "S" | "A" | "B";

/** The feed's server rank is the one canonical input for a champion's tier. */
export function draftTierForRank(rank: number): DraftTier {
  if (rank <= 1) return "S+";
  if (rank <= 3) return "S";
  if (rank <= 8) return "A";
  return "B";
}

/** Resolve a champion tier without consulting the current display position. */
export function draftTierForCandidate(candidate: Pick<DraftAssistantCandidate, "rank">): DraftTier {
  return draftTierForRank(candidate.rank);
}

export type DraftAssistantDetailSort = "winRate" | "pickRate" | "games";

export interface DraftAssistantVisibleRankingRow {
  candidate: DraftAssistantCandidate;
  rank: number;
}

export interface DraftAssistantCard {
  slot: "best" | "blind" | "reliable";
  candidate: DraftAssistantCandidate;
}

function uniqueCandidates(candidates: DraftAssistantCandidate[]): DraftAssistantCandidate[] {
  const seen = new Set<number>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.champId)) return false;
    seen.add(candidate.champId);
    return true;
  });
}

/** Recommended detail rows use the matchup feed unless there is no enemy
 * information yet. In that first-pick state, append the already-filtered
 * blind feed, de-duplicate champion rows, then assign one canonical rank
 * ladder across the merged server order. */
export function resolveRecommendedDetailCandidates(args: {
  recommended: DraftAssistantCandidate[];
  blind: DraftAssistantCandidate[];
  noEnemies: boolean;
}): DraftAssistantCandidate[] {
  if (!args.noEnemies) return args.recommended;
  return uniqueCandidates([...args.recommended, ...args.blind]).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}

/** Sort detail rows by the selected figure. Matchup-driven recommendations
 * are the stable source tiebreak ahead of blind rows when the figure is equal;
 * rank then preserves each feed's existing order. */
export function compareDraftAssistantCandidates(
  a: DraftAssistantCandidate,
  b: DraftAssistantCandidate,
  sort: DraftAssistantDetailSort
): number {
  const valueA = sort === "winRate" ? a.winRate : sort === "pickRate" ? a.laneShare ?? -1 : a.totalGames ?? -1;
  const valueB = sort === "winRate" ? b.winRate : sort === "pickRate" ? b.laneShare ?? -1 : b.totalGames ?? -1;
  if (valueB !== valueA) return valueB - valueA;
  const sourceA = a.source === "recommended" ? 0 : 1;
  const sourceB = b.source === "recommended" ? 0 : 1;
  return sourceA !== sourceB ? sourceA - sourceB : a.rank - b.rank;
}

/** Resolve the honest sorted or preserved window shown by Detailed Rankings.
 * Candidates are expected to have already passed the active filters before
 * this function is called. */
export function resolveVisibleDraftAssistantRanking(args: {
  rows: DraftAssistantCandidate[];
  sort: DraftAssistantDetailSort;
  limit?: number;
  preserveOrder?: boolean;
}): DraftAssistantVisibleRankingRow[] {
  const limit = args.limit ?? 10;
  const baseRows = args.rows;
  const rankedRows = args.preserveOrder
    ? baseRows
    : [...baseRows].sort((a, b) => compareDraftAssistantCandidates(a, b, args.sort));
  const visibleRows = rankedRows.slice(0, limit);
  return visibleRows.map((candidate, index) => ({
    candidate,
    rank: index + 1,
  }));
}

/** Display tag shared by THE CALL and its alternates: comfort, floor,
 *  off-meta (lane-share), or reliable — in that precedence. */
export function tagFor(candidate: Pick<DraftAssistantCandidate, "personalOverall" | "floor" | "laneShare">): string {
  if (candidate.personalOverall.games > 0) return "YOUR COMFORT";
  if (candidate.floor !== null) return "SAFEST";
  if (isOffMetaLaneShare(candidate.laneShare)) return "OFF-META";
  return "RELIABLE";
}
/** Resolve THE CALL from the first three candidates in server order.
 * Display sorting is intentionally not an input: the verdict and alternates
 * are pinned to the server order shown by the active tab/filter. */
export function resolveTopRecommendationCards(args: {
  rows: DraftAssistantCandidate[];
}): DraftAssistantCard[] {
  const displayedRows = args.rows.slice(0, 3).map((candidate, index) => ({ candidate, rank: index + 1 }));
  const slots = ["best", "blind", "reliable"] as const;
  return displayedRows.map(({ candidate }, index) => ({ slot: slots[index], candidate }));
}

/** Comfort Picks is the existing My Stats filter, kept as a filter-only
 *  operation so Array.prototype.filter preserves the server's ranking order. */
export function filterComfortCandidates<T extends { personalOverall: PersonalRecord }>(items: T[]): T[] {
  return filterToMyPool(items);
}
