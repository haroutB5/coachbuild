import { describe, expect, it } from "vitest";
import { phaseSpineModel } from "../phaseSpineModel";

const freshClient = { clientConnected: true, statusFresh: true };

describe("phaseSpineModel", () => {
  it("keeps every node pending without a companion", () => {
    expect(
      phaseSpineModel({ phase: null, clientConnected: false, statusFresh: false })
    ).toEqual({ currentIndex: null, states: ["pending", "pending", "pending", "pending"] });
  });

  it("keeps every node pending when the companion has no League client", () => {
    expect(
      phaseSpineModel({ phase: "None", clientConnected: false, statusFresh: true })
    ).toEqual({ currentIndex: null, states: ["pending", "pending", "pending", "pending"] });
  });

  it("does not mark lobby complete when the first fresh observation is champ select", () => {
    expect(phaseSpineModel({ ...freshClient, phase: "ChampSelect" })).toEqual({
      currentIndex: 1,
      states: ["pending", "active", "pending", "pending"],
    });
  });

  it("does not invent lobby or champ select when the first observation is mid-game", () => {
    expect(phaseSpineModel({ ...freshClient, phase: "InProgress" })).toEqual({
      currentIndex: 2,
      states: ["pending", "pending", "active", "pending"],
    });
  });

  it("completes only phases observed earlier in this companion session", () => {
    expect(phaseSpineModel({ ...freshClient, phase: "None" })).toEqual({
      currentIndex: 0,
      states: ["active", "pending", "pending", "pending"],
    });
    expect(
      phaseSpineModel({ ...freshClient, phase: "ChampSelect", observedPhases: ["None"] })
    ).toEqual({
      currentIndex: 1,
      states: ["complete", "active", "pending", "pending"],
    });
    expect(
      phaseSpineModel({
        ...freshClient,
        phase: "InProgress",
        observedPhases: ["None", "ChampSelect"],
      })
    ).toEqual({
      currentIndex: 2,
      states: ["complete", "complete", "active", "pending"],
    });
    expect(
      phaseSpineModel({
        ...freshClient,
        phase: "PostGame",
        observedPhases: ["None", "ChampSelect", "InProgress"],
      })
    ).toEqual({
      currentIndex: 3,
      states: ["complete", "complete", "complete", "active"],
    });
  });
});
