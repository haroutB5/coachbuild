import { describe, it, expect } from "vitest";
import { buildsPickBadge } from "../navBadgeModel";

describe("buildsPickBadge", () => {
  it("true during ChampSelect", () => {
    expect(buildsPickBadge("ChampSelect")).toBe(true);
  });

  it("false for any other phase", () => {
    expect(buildsPickBadge("InProgress")).toBe(false);
    expect(buildsPickBadge("None")).toBe(false);
    expect(buildsPickBadge("Lobby")).toBe(false);
  });

  it("false when phase is null (no companion/session)", () => {
    expect(buildsPickBadge(null)).toBe(false);
  });
});
