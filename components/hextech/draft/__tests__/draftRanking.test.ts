import { describe, expect, it } from "vitest";
import { draftTierForRank } from "../../draftAssistantModel";
import { preserveOriginalDraftRanks } from "../draftRanking";

describe("preserveOriginalDraftRanks", () => {
  it("filters Comfort Picks without re-tiering the original Recommended order", () => {
    const plays = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      personalOverall: { games: index === 9 ? 12 : 0 },
    }));

    const comfortRows = preserveOriginalDraftRanks(plays, true);

    expect(comfortRows).toEqual([{ play: plays[9], rank: 10 }]);
    expect(draftTierForRank(comfortRows[0].rank)).toBe("B");
  });
});
