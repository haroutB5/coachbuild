import { filterToMyPool } from "@/components/live/personalBadge";
import type { DraftPlayResult, PersonalRecord } from "@/components/live/draftRecommend";
import type { BlindPickResult } from "@/lib/draft/blindPick";
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
  isCarded: boolean;
  isAppended: boolean;
}

export interface DraftAssistantCard {
  slot: "best" | "blind" | "reliable";
  candidate: DraftAssistantCandidate | null;
}

function laneStatFor(stats: ReadonlyMap<number, DraftLaneStat>, champId: number): DraftLaneStat | undefined {
  return stats.get(champId);
}

function candidateFromPlay(
  play: DraftPlayResult,
  rank: number,
  stats: ReadonlyMap<number, DraftLaneStat>,
  isPotential: boolean
): DraftAssistantCandidate {
  const stat = laneStatFor(stats, play.champId);
  return {
    champId: play.champId,
    winRate: play.score,
    floor: null,
    totalGames: stat?.totalGames ?? null,
    laneShare: stat?.laneShare ?? null,
    rank,
    isPotential,
    personalOverall: play.personalOverall,
    source: "recommended",
  };
}

function candidateFromBlind(
  pick: BlindPickResult,
  rank: number,
  stats: ReadonlyMap<number, DraftLaneStat>
): DraftAssistantCandidate {
  const stat = laneStatFor(stats, pick.champId);
  return {
    champId: pick.champId,
    winRate: pick.fieldWr,
    floor: pick.es10,
    totalGames: stat?.totalGames ?? pick.totalGames,
    laneShare: stat?.laneShare ?? null,
    rank,
    isPotential: false,
    personalOverall: { games: 0, wins: 0 },
    source: "blind",
  };
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

/** Keep the honest sorted window intact, then append only carded candidates
 * that fell outside it. Appended rows carry their true insertion rank; they
 * are reference rows, not a reorder of the active ranking. Candidates are
 * expected to have already passed the active filters before this function is
 * called. */
export function resolveVisibleDraftAssistantRanking(args: {
  rows: DraftAssistantCandidate[];
  carded: DraftAssistantCandidate[];
  sort: DraftAssistantDetailSort;
  limit?: number;
  preserveOrder?: boolean;
}): DraftAssistantVisibleRankingRow[] {
  const limit = args.limit ?? 10;
  const baseRows = args.rows;
  const rankedRows = args.preserveOrder
    ? baseRows
    : [...baseRows].sort((a, b) => compareDraftAssistantCandidates(a, b, args.sort));
  const cardedCandidates = uniqueCandidates(args.carded);
  const cardedIds = new Set(cardedCandidates.map((candidate) => candidate.champId));
  const visibleRows = rankedRows.slice(0, limit);
  const visibleIds = new Set(visibleRows.map((candidate) => candidate.champId));
  const rankFor = (candidate: DraftAssistantCandidate): number => {
    const baseIndex = rankedRows.findIndex((row) => row.champId === candidate.champId);
    if (baseIndex >= 0) return baseIndex + 1;
    if (args.preserveOrder) return 1 + rankedRows.filter((row) => row.rank < candidate.rank).length;
    return 1 + rankedRows.filter((row) => compareDraftAssistantCandidates(row, candidate, args.sort) < 0).length;
  };

  const result: DraftAssistantVisibleRankingRow[] = visibleRows.map((candidate, index) => ({
    candidate,
    rank: index + 1,
    isCarded: cardedIds.has(candidate.champId),
    isAppended: false,
  }));
  const appended = cardedCandidates
    .filter((candidate) => !visibleIds.has(candidate.champId))
    .sort((a, b) => (args.preserveOrder ? a.rank - b.rank : compareDraftAssistantCandidates(a, b, args.sort)))
    .map((candidate) => ({ candidate, rank: rankFor(candidate), isCarded: true, isAppended: true }));
  return [...result, ...appended];
}

/** The three hero cards are deliberately resolved from separate ranked
 * sources, then de-duplicated in display order. Meta candidates always win a
 * slot before an off-meta candidate is considered. `fullList` is an additive
 * fallback for lanes where the short ranked feeds contain fewer than three
 * meta champions; those fallback candidates use the lane baseline as their
 * honest score rather than leaving a hero slot blank. */
export function resolveTopRecommendationCards(args: {
  recommended: DraftPlayResult[];
  potential?: DraftPlayResult[];
  blind: BlindPickResult[];
  laneStats: ReadonlyMap<number, DraftLaneStat>;
  fullList?: DraftAssistantCandidate[];
}): DraftAssistantCard[] {
  const recommended = args.recommended.map((play, index) => candidateFromPlay(play, index + 1, args.laneStats, false));
  const potential = (args.potential ?? []).map((play, index) => candidateFromPlay(play, index + 1, args.laneStats, true));
  const allRecommended = uniqueCandidates([...recommended, ...potential]);
  const blind = args.blind.map((pick, index) => candidateFromBlind(pick, index + 1, args.laneStats));
  const allCandidates = uniqueCandidates([...allRecommended, ...blind]);
  const fullList = uniqueCandidates(args.fullList ?? []);
  const selected = new Set<number>();
  const hasRequiredEvidence = (candidate: DraftAssistantCandidate): boolean =>
    candidate.totalGames !== null && candidate.laneShare !== null;

  function chooseSlot(
    preferred: DraftAssistantCandidate[],
    comparator: (a: DraftAssistantCandidate, b: DraftAssistantCandidate) => number
  ): DraftAssistantCandidate | null {
    // Search actual slot-specific candidates first, then the complete ranked
    // feed, then the lane baseline fallback. Within each source, meta rows
    // are exhausted before any off-meta row is allowed through.
    const groups = [preferred, allCandidates, fullList];
    for (const metaOnly of [true, false]) {
      for (const group of groups) {
        const choice = uniqueCandidates(group)
          .filter(
            (candidate) =>
              !selected.has(candidate.champId) &&
              hasRequiredEvidence(candidate) &&
              (!metaOnly || !isOffMetaLaneShare(candidate.laneShare))
          )
          .sort(comparator)[0];
        if (choice) {
          selected.add(choice.champId);
          return choice;
        }
      }
    }
    return null;
  }

  const byScore = (a: DraftAssistantCandidate, b: DraftAssistantCandidate): number =>
    b.winRate !== a.winRate ? b.winRate - a.winRate : a.rank - b.rank;
  const byBlindSafety = (a: DraftAssistantCandidate, b: DraftAssistantCandidate): number => {
    if (a.source !== b.source) return a.source === "blind" ? -1 : 1;
    return a.source === "blind" && b.source === "blind"
      ? a.rank - b.rank
      : byScore(a, b);
  };
  const byReliability = (a: DraftAssistantCandidate, b: DraftAssistantCandidate): number => {
    const gamesA = a.totalGames ?? -1;
    const gamesB = b.totalGames ?? -1;
    return gamesB !== gamesA ? gamesB - gamesA : a.rank - b.rank;
  };

  const best = chooseSlot(allRecommended, byScore);
  const safeBlind = chooseSlot(blind, byBlindSafety);
  // Reliability is a filter over the recommendation ranking, not a new
  // score: choose the best-evidenced staple, then use the complete lane list
  // only when the ranked feeds cannot provide a third distinct candidate.
  const reliable = chooseSlot(allRecommended, byReliability);

  return [
    { slot: "best", candidate: best },
    { slot: "blind", candidate: safeBlind },
    { slot: "reliable", candidate: reliable },
  ];
}

/** Comfort Picks is the existing My Stats filter, kept as a filter-only
 *  operation so Array.prototype.filter preserves the server's ranking order. */
export function filterComfortCandidates<T extends { personalOverall: PersonalRecord }>(items: T[]): T[] {
  return filterToMyPool(items);
}
