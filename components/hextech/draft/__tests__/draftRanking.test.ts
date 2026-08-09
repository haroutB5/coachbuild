import { describe, expect, it } from "vitest";
import { draftTierForRank, resolveVisibleDraftAssistantRanking } from "../../draftAssistantModel";
import { preserveOriginalDraftRanks } from "../draftRanking";

describe("preserveOriginalDraftRanks", () => {
  it("numbers merged feeds once for Recommended and keeps the display rank sequential for Blind", () => {
    const mainFeed = [
      { id: 1, personalOverall: { games: 0 } },
      { id: 2, personalOverall: { games: 0 } },
    ];
    const potentialFeed = [
      { id: 3, personalOverall: { games: 0 } },
      { id: 4, personalOverall: { games: 0 } },
    ];

    const recommendedRows = preserveOriginalDraftRanks([mainFeed, potentialFeed], false);

    expect(recommendedRows.map(({ rank }) => rank)).toEqual([1, 2, 3, 4]);

    const blindFeed = [5, 6].map((champId, index) => ({
      champId,
      winRate: 0.5,
      floor: null,
      totalGames: null,
      laneShare: null,
      rank: index + 1,
      isPotential: false,
      personalOverall: { games: 0, wins: 0 },
      source: "blind" as const,
    }));
    const blindDisplayRows = resolveVisibleDraftAssistantRanking({
      rows: [
        ...recommendedRows.map(({ play, rank }) => ({
          champId: play.id,
          winRate: 0.5,
          floor: null,
          totalGames: null,
          laneShare: null,
          rank,
          isPotential: false,
          personalOverall: { games: play.personalOverall.games, wins: 0 },
          source: "recommended" as const,
        })),
        ...blindFeed,
      ],
      sort: "winRate",
      preserveOrder: false,
    });

    expect(blindDisplayRows.map(({ rank }) => rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("filters Comfort Picks without re-tiering merged Recommended order", () => {
    const mainFeed = [
      { id: 1, personalOverall: { games: 12 } },
      { id: 2, personalOverall: { games: 0 } },
    ];
    const potentialFeed = [
      { id: 3, personalOverall: { games: 8 } },
      { id: 4, personalOverall: { games: 0 } },
    ];

    const comfortRows = preserveOriginalDraftRanks([mainFeed, potentialFeed], true);

    expect(comfortRows.map(({ play, rank }) => ({ id: play.id, rank }))).toEqual([
      { id: 1, rank: 1 },
      { id: 3, rank: 3 },
    ]);
    expect(new Set(comfortRows.map(({ rank }) => rank)).size).toBe(comfortRows.length);
    expect(draftTierForRank(comfortRows[1].rank)).toBe("S");
  });
});
