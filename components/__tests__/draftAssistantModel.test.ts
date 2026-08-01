import { describe, expect, it } from "vitest";
import type { DraftPlayResult } from "../live/draftRecommend";
import type { BlindPickResult } from "@/lib/draft/blindPick";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";
import {
  DEFAULT_DRAFT_ASSISTANT_FILTERS,
  filterCounterCandidates,
  filterComfortCandidates,
  filterDraftAssistantCandidates,
  isOffMetaLaneShare,
  resolveTopRecommendationCards,
  type DraftLaneStat,
} from "../hextech/draftAssistantModel";

function play(champId: number, score: number, games: number): DraftPlayResult {
  return {
    champId,
    score,
    winVsLaneOpp: null,
    winVsLaneOppGames: null,
    confidence: "normal",
    minGames: games,
    personal: null,
    personalOverall: { games: 0, wins: 0 },
    synergyDelta: 0,
    synergyBand: "Even",
  };
}

function blind(champId: number, fieldWr: number, floor: number, games: number): BlindPickResult {
  return {
    rank: 1,
    champId,
    blindScore: fieldWr,
    fieldWr,
    es10: floor,
    badMass: 0,
    worstMatchup: null,
    totalGames: games,
    coverageMass: 1,
  };
}

function stat(champId: number, laneShare: number, totalGames: number): DraftLaneStat {
  return { champId, baselineWr: 0.5, laneShare, totalGames };
}

describe("Draft Assistant recommendation slots", () => {
  it("resolves three distinct champions, falling through duplicate sources", () => {
    const cards = resolveTopRecommendationCards({
      recommended: [play(1, 0.58, 12000), play(2, 0.56, 4000), play(3, 0.55, 9000)],
      blind: [blind(1, 0.57, 0.53, 12000), blind(2, 0.56, 0.54, 4000), blind(4, 0.54, 0.52, 7000)],
      laneStats: new Map([
        [1, stat(1, 0.06, 12000)],
        [2, stat(2, 0.03, 4000)],
        [3, stat(3, 0.04, 9000)],
        [4, stat(4, 0.02, 7000)],
      ]),
    });

    expect(cards.map((card) => card.candidate?.champId)).toEqual([1, 2, 3]);
    expect(new Set(cards.flatMap((card) => (card.candidate ? [card.candidate.champId] : []))).size).toBe(3);
  });

  it("reads the off-meta threshold from POOL_MIN_PICKRATE", () => {
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE - 0.0001)).toBe(true);
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE)).toBe(false);
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE + 0.0001)).toBe(false);
  });

  it("keeps a high-win-rate potential row aligned with the table and tags it", () => {
    const cards = resolveTopRecommendationCards({
      recommended: [play(1, 0.52, 12000)],
      potential: [play(2, 0.56, 500)],
      blind: [],
      laneStats: new Map([
        [1, stat(1, 0.04, 12000)],
        [2, stat(2, 0.02, 500)],
      ]),
    });
    expect(cards[0].candidate?.champId).toBe(2);
    expect(cards[0].candidate?.isPotential).toBe(true);
  });

  it("never uses an off-meta hero while three meta candidates are available", () => {
    const cards = resolveTopRecommendationCards({
      recommended: [play(1, 0.70, 12000), play(2, 0.60, 9000), play(3, 0.59, 8000)],
      blind: [blind(4, 0.68, 0.50, 7000), blind(5, 0.58, 0.54, 6000)],
      laneStats: new Map([
        [1, stat(1, POOL_MIN_PICKRATE - 0.001, 12000)],
        [2, stat(2, 0.03, 9000)],
        [3, stat(3, 0.025, 8000)],
        [4, stat(4, POOL_MIN_PICKRATE - 0.002, 7000)],
        [5, stat(5, 0.02, 6000)],
      ]),
    });

    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.candidate && !isOffMetaLaneShare(card.candidate.laneShare))).toBe(true);
    expect(new Set(cards.map((card) => card.candidate?.champId)).size).toBe(3);
  });

  it("uses the full lane list before filling a missing slot with off-meta", () => {
    const cards = resolveTopRecommendationCards({
      recommended: [play(1, 0.70, 12000)],
      blind: [],
      laneStats: new Map([
        [1, stat(1, POOL_MIN_PICKRATE - 0.001, 12000)],
        [2, stat(2, 0.03, 9000)],
        [3, stat(3, 0.025, 8000)],
        [4, stat(4, 0.02, 7000)],
      ]),
      fullList: [
        { champId: 2, winRate: 0.56, floor: null, totalGames: 9000, laneShare: 0.03, rank: 99, isPotential: false, personalOverall: { games: 0, wins: 0 }, source: "recommended" },
        { champId: 3, winRate: 0.55, floor: null, totalGames: 8000, laneShare: 0.025, rank: 100, isPotential: false, personalOverall: { games: 0, wins: 0 }, source: "recommended" },
        { champId: 4, winRate: 0.54, floor: null, totalGames: 7000, laneShare: 0.02, rank: 101, isPotential: false, personalOverall: { games: 0, wins: 0 }, source: "recommended" },
      ],
    });

    expect(cards.map((card) => card.candidate?.champId)).toEqual([2, 3, 4]);
  });
});

describe("Draft Assistant filters", () => {
  const candidates = [
    { champId: 1, laneShare: 0.02, totalGames: 5000 },
    { champId: 2, laneShare: 0.004, totalGames: 5000 },
    { champId: 3, laneShare: 0.03, totalGames: 500 },
  ];

  it("filters by lane share, off-meta inclusion, and total games", () => {
    expect(
      filterDraftAssistantCandidates(candidates, { minPickRate: 0.01, includeOffMeta: false, minimumGames: 1000 }).map(
        (candidate) => candidate.champId
      )
    ).toEqual([1]);

    expect(
      filterDraftAssistantCandidates(candidates, { minPickRate: 0, includeOffMeta: true, minimumGames: 1000 }).map(
        (candidate) => candidate.champId
      )
    ).toEqual([1, 2]);
  });

  it("preserves the base order rather than sorting filtered candidates", () => {
    const ordered = [
      { champId: 8, laneShare: 0.02, totalGames: 1000 },
      { champId: 4, laneShare: 0.03, totalGames: 2000 },
      { champId: 9, laneShare: 0.04, totalGames: 3000 },
    ];
    expect(filterDraftAssistantCandidates(ordered, { minPickRate: 0.01, includeOffMeta: false, minimumGames: 1 }).map((x) => x.champId)).toEqual([
      8,
      4,
      9,
    ]);
  });

  it("keeps the default filter state populated for every lane fixture", () => {
    const laneFixtures = Array.from({ length: 5 }, (_, lane) => [
      { champId: lane + 1, laneShare: 0.002, totalGames: 1000 },
      { champId: lane + 101, laneShare: 0.02, totalGames: 2500 },
    ]);
    for (const fixture of laneFixtures) {
      expect(filterDraftAssistantCandidates(fixture, DEFAULT_DRAFT_ASSISTANT_FILTERS)).not.toHaveLength(0);
    }
    expect(DEFAULT_DRAFT_ASSISTANT_FILTERS).toEqual({ minPickRate: 0, includeOffMeta: true, minimumGames: 1000 });
  });

  it("keeps only positive shrunk matchup deltas for Counters", () => {
    const rows = [
      { champId: 1, synergyDelta: 0.012 },
      { champId: 2, synergyDelta: 0 },
      { champId: 3, synergyDelta: -0.004 },
    ];
    expect(filterCounterCandidates(rows).map((row) => row.champId)).toEqual([1]);
  });
});

describe("Comfort Picks", () => {
  it("filters the server order without changing the surviving order", () => {
    const base = [
      { champId: 3, personalOverall: { games: 0, wins: 0 } },
      { champId: 1, personalOverall: { games: 12, wins: 7 } },
      { champId: 2, personalOverall: { games: 4, wins: 2 } },
      { champId: 5, personalOverall: { games: 0, wins: 0 } },
    ];
    expect(filterComfortCandidates(base).map((candidate) => candidate.champId)).toEqual([1, 2]);
  });
});
