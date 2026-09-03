import { describe, expect, it } from "vitest";
import { reasonForCandidate } from "../draftReason";
import { tagFor } from "../../draftAssistantModel";
import type { DraftAssistantCandidate } from "../../draftAssistantModel";

function baseCandidate(): DraftAssistantCandidate {
  return {
    champId: 103,
    winRate: 0.567,
    floor: null,
    totalGames: 561,
    laneShare: 0.002,
    rank: 1,
    isPotential: false,
    personalOverall: { games: 0, wins: 0 },
    source: "blind",
  };
}

describe("reasonForCandidate", () => {
  it("suppresses the best-matchup sentence when no enemy info exists, even with a preview", () => {
    const { chip, reason } = reasonForCandidate({
      candidate: baseCandidate(),
      laneOpponentName: null,
      preview: { champId: 103, worst: [], best: [{ oppId: 84, winRate: 0.56, games: 200, opponentLaneShare: 0.05 }] },
      floor: null,
      compTakeaway: null,
      hasEnemyInfo: false,
    });
    expect(reason).toBeNull();
    expect(chip).toBeNull();
  });

  it("keeps the best-matchup sentence once enemies are entered", () => {
    const { reason } = reasonForCandidate({
      candidate: baseCandidate(),
      laneOpponentName: null,
      preview: { champId: 103, worst: [], best: [{ oppId: 84, winRate: 0.56, games: 200, opponentLaneShare: 0.05 }] },
      floor: null,
      compTakeaway: null,
      hasEnemyInfo: true,
    });
    expect(reason).toContain("popular enemy picks");
  });

  it("names the current enemy field when the best matchup is the entered enemy", () => {
    const candidate = { ...baseCandidate(), champId: 84 };
    const { reason } = reasonForCandidate({
      candidate,
      laneOpponentName: null,
      preview: { champId: 84, worst: [], best: [{ oppId: 84, winRate: 0.56, games: 200, opponentLaneShare: 0.05 }] },
      floor: null,
      compTakeaway: null,
      hasEnemyInfo: true,
    });
    expect(reason).toContain("the current enemy field");
  });

  it("chips a lane-opponent answer ahead of the floor chip", () => {
    const candidate = { ...baseCandidate(), synergyDelta: 0.03 };
    const { chip, reason } = reasonForCandidate({
      candidate,
      laneOpponentName: "Akali",
      preview: undefined,
      floor: 0.51,
      compTakeaway: null,
      hasEnemyInfo: true,
    });
    expect(chip).toBe("Favored into Akali");
    expect(reason).toContain("answers Akali");
    expect(reason).toContain("first-pick floor");
  });

  it("falls back to the Blind-safe chip on a floor with no matchup evidence", () => {
    const { chip, reason } = reasonForCandidate({
      candidate: baseCandidate(),
      laneOpponentName: null,
      preview: undefined,
      floor: 0.51,
      compTakeaway: null,
      hasEnemyInfo: false,
    });
    expect(chip).toBe("Blind-safe");
    expect(reason).toContain("first-pick floor");
  });
});

describe("tagFor", () => {
  it("prefers comfort over floor over off-meta", () => {
    const comfort = { ...baseCandidate(), personalOverall: { games: 12, wins: 7 }, floor: 0.51, laneShare: 0.001 };
    expect(tagFor(comfort)).toBe("YOUR COMFORT");
    const safe = { ...baseCandidate(), floor: 0.51, laneShare: 0.001 };
    expect(tagFor(safe)).toBe("SAFEST");
    const offMeta = { ...baseCandidate(), floor: null, laneShare: 0.002 };
    expect(tagFor(offMeta)).toBe("OFF-META");
    const reliable = { ...baseCandidate(), floor: null, laneShare: 0.05 };
    expect(tagFor(reliable)).toBe("RELIABLE");
  });
});
