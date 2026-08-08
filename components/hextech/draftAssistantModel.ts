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

/** Opt-in filters: the first paint must remain populated for every lane. */
export const DEFAULT_DRAFT_ASSISTANT_FILTERS: DraftAssistantFilters = {
  minPickRate: 0,
  includeOffMeta: true,
  minimumGames: 1000,
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
 * blind feed and let the real matchup rows win any champion-level duplicate. */
export function resolveRecommendedDetailCandidates(args: {
  recommended: DraftAssistantCandidate[];
  blind: DraftAssistantCandidate[];
  noEnemies: boolean;
}): DraftAssistantCandidate[] {
  return args.noEnemies ? uniqueCandidates([...args.recommended, ...args.blind]) : args.recommended;
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

/** Resolve the hero cards from the same displayed ranking window as the table.
 * `rows` must already contain the active tab and filter selection; sorting and
 * Comfort Picks' preserved order mirror `resolveVisibleDraftAssistantRanking`.
 * The slots are visual positions only and carry no role-selection meaning. */
export function resolveTopRecommendationCards(args: {
  rows: DraftAssistantCandidate[];
  sort: DraftAssistantDetailSort;
  preserveOrder?: boolean;
}): DraftAssistantCard[] {
  const displayedRows = resolveVisibleDraftAssistantRanking({
    rows: args.rows,
    sort: args.sort,
    limit: 3,
    preserveOrder: args.preserveOrder,
  });
  const slots = ["best", "blind", "reliable"] as const;
  return displayedRows.map(({ candidate }, index) => ({ slot: slots[index], candidate }));
}

/** Comfort Picks is the existing My Stats filter, kept as a filter-only
 *  operation so Array.prototype.filter preserves the server's ranking order. */
export function filterComfortCandidates<T extends { personalOverall: PersonalRecord }>(items: T[]): T[] {
  return filterToMyPool(items);
}
