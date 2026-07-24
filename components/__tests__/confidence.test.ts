import { describe, it, expect } from "vitest";
import { confidenceBand } from "../hextech/confidence";

describe("confidenceBand", () => {
  it("null games -> LOW", () => {
    expect(confidenceBand(null)).toBe("LOW");
  });

  it("0 games -> LOW", () => {
    expect(confidenceBand(0)).toBe("LOW");
  });

  it(">= 15000 games -> HIGH", () => {
    expect(confidenceBand(15000)).toBe("HIGH");
    expect(confidenceBand(50000)).toBe("HIGH");
  });

  it(">= 4000 and < 15000 games -> MEDIUM", () => {
    expect(confidenceBand(4000)).toBe("MEDIUM");
    expect(confidenceBand(14999)).toBe("MEDIUM");
  });

  it("< 4000 games (but > 0) -> LOW", () => {
    expect(confidenceBand(3999)).toBe("LOW");
    expect(confidenceBand(1)).toBe("LOW");
  });

  it("negative games (defensive, should never happen upstream) -> LOW", () => {
    expect(confidenceBand(-5)).toBe("LOW");
  });

  it("an adoption argument doesn't change the band today (accepted for a future refinement only)", () => {
    expect(confidenceBand(15000, 0.001)).toBe("HIGH");
    expect(confidenceBand(15000, 0.99)).toBe("HIGH");
  });
});
