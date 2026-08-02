import { describe, expect, it } from "vitest";
import type { DraftPlayResult } from "../live/draftRecommend";
import type { BlindPickResult } from "@/lib/draft/blindPick";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";
import {
  DEFAULT_DRAFT_ASSISTANT_FILTERS,
  compareDraftAssistantCandidates,
  filterCounterCandidates,
  filterComfortCandidates,
  filterDraftAssistantCandidates,
  isOffMetaLaneShare,
  resolveRecommendedDetailCandidates,
  resolveTopRecommendationCards,
  resolveVisibleDraftAssistantRanking,
  type DraftAssistantCandidate,
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

function candidate(
  champId: number,
  source: DraftAssistantCandidate["source"],
  rank: number,
  winRate: number,
  totalGames: number,
  laneShare = 0.02
): DraftAssistantCandidate {
  return {
    champId,
    winRate,
    floor: source === "blind" ? winRate - 0.03 : null,
    totalGames,
    laneShare,
    rank,
    isPotential: false,
    personalOverall: { games: 0, wins: 0 },
    source,
  };
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

describe("Recommended detail ranking source", () => {
  it("uses the filtered blind pool for no-enemy details, matching the three cards and de-duplicating", () => {
    // Reported first-pick shape: Riven is the matchup recommendation, while
    // Diana and Ahri come from the blind ranking.
    const cards = resolveTopRecommendationCards({
      recommended: [play(92, 0.58, 12000)],
      blind: [blind(131, 0.56, 0.53, 227014), blind(103, 0.55, 0.52, 429501)],
      laneStats: new Map([
        [92, stat(92, 0.04, 12000)],
        [131, stat(131, 0.03, 227014)],
        [103, stat(103, 0.02, 429501)],
      ]),
    });
    const cardIds = cards.flatMap((card) => (card.candidate ? [card.candidate.champId] : []));
    const detailCandidates = resolveRecommendedDetailCandidates({
      noEnemies: true,
      recommended: [candidate(92, "recommended", 1, 0.58, 12000)],
      blind: [
        candidate(92, "blind", 1, 0.57, 12000),
        candidate(131, "blind", 1, 0.56, 227014),
        candidate(103, "blind", 2, 0.55, 429501),
      ],
    });

    expect(cardIds).toEqual([92, 131, 103]);
    expect(detailCandidates.map((item) => item.champId)).toEqual(cardIds);
    expect(new Set(detailCandidates.map((item) => item.champId)).size).toBe(3);
    expect(detailCandidates[0].source).toBe("recommended");
  });

  it("keeps matchup-only rows unchanged when enemies are selected", () => {
    const recommended = [candidate(92, "recommended", 1, 0.58, 12000), candidate(7, "recommended", 2, 0.55, 7000)];
    const detailCandidates = resolveRecommendedDetailCandidates({
      noEnemies: false,
      recommended,
      blind: [candidate(131, "blind", 1, 0.56, 227014)],
    });

    expect(detailCandidates).toBe(recommended);
    expect(detailCandidates.map((item) => item.champId)).toEqual([92, 7]);
    expect(detailCandidates.some((item) => item.source === "blind")).toBe(false);
  });

  it("does not let a filtered-out blind row leak into no-enemy details", () => {
    const filteredBlind = filterDraftAssistantCandidates(
      [
        candidate(131, "blind", 1, 0.56, 227014),
        candidate(103, "blind", 2, 0.55, 429501),
        candidate(999, "blind", 3, 0.54, 999),
      ],
      { minPickRate: 0.01, includeOffMeta: false, minimumGames: 1000 }
    );
    const detailCandidates = resolveRecommendedDetailCandidates({
      noEnemies: true,
      recommended: [candidate(92, "recommended", 1, 0.58, 12000)],
      blind: filteredBlind,
    });

    expect(detailCandidates.map((item) => item.champId)).toEqual([92, 131, 103]);
    expect(detailCandidates.some((item) => item.champId === 999)).toBe(false);
  });

  it("puts matchup recommendations ahead of blind rows when the sorted figure ties", () => {
    const recommended = candidate(92, "recommended", 3, 0.55, 5000);
    const blindRow = candidate(131, "blind", 1, 0.55, 5000);
    expect(compareDraftAssistantCandidates(recommended, blindRow, "winRate")).toBeLessThan(0);
    expect(compareDraftAssistantCandidates(recommended, blindRow, "pickRate")).toBeLessThan(0);
    expect(compareDraftAssistantCandidates(recommended, blindRow, "games")).toBeLessThan(0);
  });
});

describe("Carded recommendations in the visible ranking window", () => {
  function fixture() {
    const cards = resolveTopRecommendationCards({
      recommended: [play(92, 0.524, 56878)],
      blind: [blind(131, 0.514, 0.49, 227014), blind(103, 0.508, 0.47, 429501)],
      laneStats: new Map([
        [92, stat(92, 0.012, 56878)],
        [131, stat(131, 0.046, 227014)],
        [103, stat(103, 0.087, 429501)],
      ]),
    });
    const carded = cards.flatMap((card) => (card.candidate ? [card.candidate] : []));
    const offMeta = [0.6, 0.59, 0.58, 0.57, 0.56, 0.55, 0.54, 0.53, 0.52, 0.51].map((winRate, index) =>
      candidate(200 + index, "recommended", index + 1, winRate, 10000 + index, 0.005)
    );
    return { carded, rows: [...offMeta, ...carded] };
  }

  function visibleAt(minPickRate: number) {
    const { carded, rows } = fixture();
    const filters = { minPickRate, includeOffMeta: true, minimumGames: 1000 };
    const filteredRows = filterDraftAssistantCandidates(rows, filters);
    const filteredCarded = filterDraftAssistantCandidates(carded, filters);
    return {
      carded,
      filteredRows,
      visible: resolveVisibleDraftAssistantRanking({ rows: filteredRows, carded: filteredCarded, sort: "winRate" }),
    };
  }

  it("keeps every carded champion in the visible rows with a 0% floor and off-meta included", () => {
    const { carded, filteredRows, visible } = visibleAt(0);
    const cardIds = carded.map((item) => item.champId);
    const sorted = [...filteredRows].sort((a, b) => compareDraftAssistantCandidates(a, b, "winRate"));

    expect(visible).toHaveLength(12);
    expect(new Set(visible.map((row) => row.candidate.champId)).size).toBeGreaterThanOrEqual(cardIds.length);
    for (const cardId of cardIds) expect(visible.some((row) => row.candidate.champId === cardId)).toBe(true);
    expect(visible.filter((row) => row.isAppended).map((row) => row.candidate.champId)).toEqual([131, 103]);
    expect(visible.filter((row) => !row.isAppended).map((row) => row.candidate.champId)).toEqual(sorted.slice(0, 10).map((row) => row.champId));
  });

  it("keeps every carded champion in the natural top ten when the 1% floor removes off-meta rows", () => {
    const { carded, filteredRows, visible } = visibleAt(0.01);
    const sorted = [...filteredRows].sort((a, b) => compareDraftAssistantCandidates(a, b, "winRate"));

    expect(visible.map((row) => row.candidate.champId)).toEqual(sorted.map((row) => row.champId));
    expect(visible.every((row) => !row.isAppended)).toBe(true);
    expect(new Set(visible.map((row) => row.candidate.champId))).toEqual(new Set(carded.map((row) => row.champId)));
  });

  it("keeps appended rank and displayed values truthful, while respecting filter exclusions", () => {
    const { carded, filteredRows, visible } = visibleAt(0);
    const sorted = [...filteredRows].sort((a, b) => compareDraftAssistantCandidates(a, b, "winRate"));
    for (const row of visible) {
      const trueRank = sorted.findIndex((candidate) => candidate.champId === row.candidate.champId) + 1;
      expect(row.rank).toBe(trueRank);
      expect(row.candidate.winRate).toBe(sorted[trueRank - 1].winRate);
    }

    const excludedCard = candidate(555, "blind", 4, 0.6, 999, 0.03);
    const filters = { minPickRate: 0, includeOffMeta: true, minimumGames: 1000 };
    const filteredExcludedCard = filterDraftAssistantCandidates([excludedCard], filters);
    const excludedVisible = resolveVisibleDraftAssistantRanking({
      rows: filteredRows,
      carded: [...carded, ...filteredExcludedCard],
      sort: "winRate",
    });
    expect(excludedVisible.some((row) => row.candidate.champId === excludedCard.champId)).toBe(false);
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
