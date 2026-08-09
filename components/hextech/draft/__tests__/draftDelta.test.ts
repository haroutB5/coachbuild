import { describe, expect, it } from "vitest";
import { deltaVsLaneAverage, formatDeltaPoints } from "../draftDelta";

describe("draft delta presentation", () => {
  it("derives the lane-average delta for every surface and stays honest when unmeasured", () => {
    expect(deltaVsLaneAverage(0.54, 0.51)).toBeCloseTo(0.03, 10);
    expect(formatDeltaPoints(deltaVsLaneAverage(0.54, 0.51))).toBe("+3.0pp");
    expect(deltaVsLaneAverage(0.54, null)).toBeNull();
    expect(formatDeltaPoints(null)).toBe("—");
  });
});
