import { describe, expect, it } from "vitest";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";
import {
  DEFAULT_DRAFT_ASSISTANT_FILTERS,
  compareDraftAssistantCandidates,
  draftTierForCandidate,
  filterCounterCandidates,
  filterComfortCandidates,
  filterDraftAssistantCandidates,
  isOffMetaLaneShare,
  resolveRecommendedDetailCandidates,
  resolveTopRecommendationCards,
  resolveVisibleDraftAssistantRanking,
  type DraftAssistantCandidate,
} from "../hextech/draftAssistantModel";

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

describe("Draft Assistant recommendation cards", () => {
  it("uses the first three displayed rows for every view", () => {
    const views = [
      {
        name: "Recommended",
        rows: [candidate(1, "recommended", 1, 0.575, 12000), candidate(2, "recommended", 2, 0.552, 9000), candidate(3, "recommended", 3, 0.547, 8000), candidate(4, "recommended", 4, 0.523, 7000)],
        expected: [1, 2, 3],
      },
      {
        name: "Blind Picks",
        rows: [candidate(11, "blind", 1, 0.59, 22000), candidate(12, "blind", 2, 0.57, 18000), candidate(13, "blind", 3, 0.55, 15000), candidate(14, "blind", 4, 0.53, 12000)],
        expected: [11, 12, 13],
      },
      {
        name: "Counters",
        rows: [candidate(21, "recommended", 1, 0.61, 11000), candidate(22, "recommended", 2, 0.58, 9000), candidate(23, "recommended", 3, 0.56, 7000), candidate(24, "recommended", 4, 0.54, 6000)],
        expected: [21, 22, 23],
      },
      {
        name: "Comfort Picks",
        rows: [candidate(31, "recommended", 4, 0.51, 4000), candidate(32, "recommended", 2, 0.59, 9000), candidate(33, "recommended", 3, 0.56, 7000), candidate(34, "recommended", 1, 0.62, 12000)],
        expected: [31, 32, 33],
        preserveOrder: true,
      },
    ];

    for (const view of views) {
      const cards = resolveTopRecommendationCards({ rows: view.rows });
      expect(cards.map((card) => card.candidate.champId), view.name).toEqual(view.expected);
    }
  });

  it("returns fewer cards when the displayed ranking has fewer than three rows", () => {
    const cards = resolveTopRecommendationCards({
      rows: [candidate(1, "recommended", 1, 0.58, 12000), candidate(2, "recommended", 2, 0.56, 9000)],
    });

    expect(cards.map((card) => card.candidate.champId)).toEqual([1, 2]);
  });

  it("does not render cards for an empty Counters ranking", () => {
    const counterRows = filterCounterCandidates([
      { ...candidate(1, "recommended", 1, 0.58, 12000), synergyDelta: 0 },
      { ...candidate(2, "recommended", 2, 0.56, 9000), synergyDelta: -0.01 },
    ]);

    expect(resolveTopRecommendationCards({ rows: counterRows })).toEqual([]);
  });

  it("keeps THE CALL in server order when the table sort changes", () => {
    const rows = [
      candidate(1, "recommended", 1, 0.52, 3000, 0.08),
      candidate(2, "recommended", 2, 0.58, 1000, 0.01),
      candidate(3, "recommended", 3, 0.55, 5000, 0.04),
    ];

    expect(resolveTopRecommendationCards({ rows }).map((card) => card.candidate.champId)).toEqual([1, 2, 3]);
  });

  it("reads the off-meta threshold from POOL_MIN_PICKRATE", () => {
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE - 0.0001)).toBe(true);
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE)).toBe(false);
    expect(isOffMetaLaneShare(POOL_MIN_PICKRATE + 0.0001)).toBe(false);
  });

  it("keeps a potential row in server order and tags it in the alternates", () => {
    const potential = candidate(2, "recommended", 2, 0.56, 500);
    potential.isPotential = true;
    const cards = resolveTopRecommendationCards({
      rows: [candidate(1, "recommended", 1, 0.52, 12000), potential],
    });
    expect(cards[0].candidate.champId).toBe(1);
    expect(cards[0].candidate.isPotential).toBe(false);
    expect(cards[1].candidate.champId).toBe(2);
    expect(cards[1].candidate.isPotential).toBe(true);
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
    const detailCandidates = resolveRecommendedDetailCandidates({
      noEnemies: true,
      recommended: [candidate(92, "recommended", 1, 0.58, 12000)],
      blind: [
        candidate(92, "blind", 1, 0.57, 12000),
        candidate(131, "blind", 1, 0.56, 227014),
        candidate(103, "blind", 2, 0.55, 429501),
        candidate(104, "blind", 3, 0.54, 420000),
        candidate(105, "blind", 4, 0.53, 410000),
        candidate(106, "blind", 5, 0.52, 400000),
        candidate(107, "blind", 6, 0.51, 390000),
        candidate(108, "blind", 7, 0.50, 380000),
      ],
    });
    const cards = resolveTopRecommendationCards({ rows: detailCandidates });
    const cardIds = cards.map((card) => card.candidate.champId);

    expect(cardIds).toEqual([92, 131, 103]);
    expect(detailCandidates.map((item) => item.champId)).toEqual([92, 131, 103, 104, 105, 106, 107, 108]);
    expect(new Set(detailCandidates.map((item) => item.champId)).size).toBe(8);
    expect(detailCandidates[0].source).toBe("recommended");
    const tiers = detailCandidates.map((item) => draftTierForCandidate(item));
    expect(detailCandidates.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tiers).toEqual(["S+", "S", "S", "A", "A", "A", "A", "A"]);
    expect(tiers.filter((tier) => tier === "S+")).toHaveLength(1);
    expect(tiers.filter((tier) => tier === "S")).toHaveLength(2);
    expect(tiers.filter((tier) => tier === "A")).toHaveLength(5);
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

describe("Visible ranking window", () => {
  function fixture() {
    return [0.6, 0.59, 0.58, 0.57, 0.56, 0.55, 0.54, 0.53, 0.52, 0.51, 0.5].map((winRate, index) =>
      candidate(200 + index, "recommended", index + 1, winRate, 10000 + index, 0.02)
    );
  }

  it("returns the sorted table window without appending card references", () => {
    const rows = filterDraftAssistantCandidates(fixture(), { minPickRate: 0, includeOffMeta: true, minimumGames: 1000 });
    const visible = resolveVisibleDraftAssistantRanking({ rows, sort: "winRate" });
    const sorted = [...rows].sort((a, b) => compareDraftAssistantCandidates(a, b, "winRate"));

    expect(visible.map((row) => row.candidate.champId)).toEqual(sorted.slice(0, 10).map((row) => row.champId));
    expect(visible.map((row) => row.rank)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
  });

  it("keeps THE CALL in server order while the table responds to a sort change", () => {
    const rows = fixture();
    const cards = resolveTopRecommendationCards({ rows });
    const visible = resolveVisibleDraftAssistantRanking({ rows, sort: "games" });

    expect(cards.map((card) => card.candidate.champId)).toEqual([200, 201, 202]);
    expect(visible.slice(0, 3).map((row) => row.candidate.champId)).toEqual([210, 209, 208]);
  });

  it("keeps a champion tier tied to its original rank after display sorting", () => {
    const rows = [
      candidate(301, "recommended", 9, 0.509, 10000, 0.08),
      candidate(302, "recommended", 2, 0.519, 9000, 0.01),
    ];
    const beforeSortTier = draftTierForCandidate(rows[0]);
    const sortedRow = resolveVisibleDraftAssistantRanking({ rows, sort: "pickRate" }).find((row) => row.candidate.champId === 301);

    expect(sortedRow?.rank).toBe(1);
    expect(draftTierForCandidate(sortedRow!.candidate)).toBe(beforeSortTier);
    expect(beforeSortTier).toBe("B");
    expect(draftTierForCandidate(rows[1])).toBe("S");
  });

  it("uses the same canonical tier for THE CALL and its table row", () => {
    const singed = candidate(401, "recommended", 1, 0.52, 10000, 0.08);
    const rows = [singed, candidate(402, "recommended", 2, 0.55, 9000, 0.01)];
    const call = resolveTopRecommendationCards({ rows })[0].candidate;
    const tableRow = resolveVisibleDraftAssistantRanking({ rows, sort: "pickRate" }).find((row) => row.candidate.champId === singed.champId)?.candidate;

    expect(call.champId).toBe(singed.champId);
    expect(tableRow).toBeDefined();
    expect(draftTierForCandidate(call)).toBe(draftTierForCandidate(tableRow!));
    expect(draftTierForCandidate(call)).toBe("S+");
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
