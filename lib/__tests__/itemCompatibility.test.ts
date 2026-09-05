import { describe, expect, it } from "vitest";
import { itemsConflict } from "../itemCompatibility";
import { applyForThisGameLine, type ForThisGamePlan } from "../enemyComp/forThisGame";

describe("completed-item compatibility", () => {
  it.each([[3036, 3033], [3053, 3156], [3135, 3137], [3004, 3040]])("rejects the incompatible pair %i / %i", (a, b) => {
    expect(itemsConflict(a, b)).toBe(true);
    expect(itemsConflict(b, a)).toBe(true);
  });
  it("does not group Malignance with Tear items", () => {
    expect(itemsConflict(3118, 3003)).toBe(false);
  });
  it("replaces Lord Dominik's with Mortal Reminder when countering healers", () => {
    const plan = { items: [{ itemId: 3033, scenario: "healers", reason: "2 healers", measured: true }], boots: null } as ForThisGamePlan;
    const result = applyForThisGameLine([3031, 3006, 3036, 3094, 3072, 3026], plan, new Set([3006]));
    expect(result.ids).toContain(3033);
    expect(result.ids).not.toContain(3036);
    expect(result.ids).toContain(3026);
    expect(result.ids).toHaveLength(6);
    expect(result.swaps[0].replacedId).toBe(3036);
  });
});
