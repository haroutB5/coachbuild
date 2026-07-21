import { describe, it, expect } from "vitest";
import { axisPoint, buildPolygonPoints, buildGridRingPoints, estimatedFootnote, RADAR_AXES } from "../hextech/draftRadarGeom";
import type { AggregatedComp } from "@/lib/draft/compRatings";

describe("RADAR_AXES", () => {
  it("has exactly 6 axes in the plan's pinned order", () => {
    expect(RADAR_AXES.map((a) => a.key)).toEqual(["cc", "damage", "tankiness", "mobility", "utility", "engage"]);
  });
});

describe("axisPoint", () => {
  it("index 0 at full value lands straight up from center", () => {
    const p = axisPoint(0, 1, 100, 100, 50);
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(50, 5);
  });
  it("valueFraction 0 collapses to the center regardless of index", () => {
    const p = axisPoint(3, 0, 100, 100, 50);
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(100, 5);
  });
  it("clamps a fraction above 1 to the outer radius", () => {
    const clamped = axisPoint(0, 5, 100, 100, 50);
    const atOne = axisPoint(0, 1, 100, 100, 50);
    expect(clamped).toEqual(atOne);
  });
  it("clamps a negative fraction to the center", () => {
    const p = axisPoint(0, -2, 100, 100, 50);
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(100, 5);
  });
});

describe("buildPolygonPoints", () => {
  const zeroVector = { cc: 0, damage: 0, tankiness: 0, mobility: 0, utility: 0, engage: 0 };
  it("an all-zero vector collapses every vertex to the center", () => {
    const pts = buildPolygonPoints(zeroVector, 100, 100, 50);
    const vertices = pts.split(" ");
    expect(vertices).toHaveLength(6);
    for (const v of vertices) {
      const [x, y] = v.split(",").map(Number);
      expect(x).toBeCloseTo(100, 1);
      expect(y).toBeCloseTo(100, 1);
    }
  });
  it("a max-value (3) vector reaches the full radius on every axis", () => {
    const maxVector = { cc: 3, damage: 3, tankiness: 3, mobility: 3, utility: 3, engage: 3 };
    const pts = buildPolygonPoints(maxVector, 0, 0, 50);
    for (const v of pts.split(" ")) {
      const [x, y] = v.split(",").map(Number);
      expect(Math.hypot(x, y)).toBeCloseTo(50, 1);
    }
  });
  it("tolerates a partial/missing key by defaulting it to 0, never throwing", () => {
    const partial = { cc: 2 } as unknown as Parameters<typeof buildPolygonPoints>[0];
    expect(() => buildPolygonPoints(partial, 0, 0, 50)).not.toThrow();
  });
});

describe("buildGridRingPoints", () => {
  it("returns 6 vertices scaled by the ring fraction", () => {
    const inner = buildGridRingPoints(1 / 3, 0, 0, 90);
    const outer = buildGridRingPoints(1, 0, 0, 90);
    const innerFirst = inner.split(" ")[0].split(",").map(Number);
    const outerFirst = outer.split(" ")[0].split(",").map(Number);
    expect(Math.hypot(...innerFirst)).toBeCloseTo(30, 1);
    expect(Math.hypot(...outerFirst)).toBeCloseTo(90, 1);
  });
});

describe("estimatedFootnote", () => {
  it("null when nothing was estimated (fully curated)", () => {
    const comp: AggregatedComp = { cc: 1, damage: 1, tankiness: 1, mobility: 1, utility: 1, engage: 1, estimatedCount: 0 };
    expect(estimatedFootnote(comp, 5)).toBeNull();
  });
  it("null when there's nothing resolved at all (avoid a 0-of-0 footnote)", () => {
    const comp: AggregatedComp = { cc: 0, damage: 0, tankiness: 0, mobility: 0, utility: 0, engage: 0, estimatedCount: 0 };
    expect(estimatedFootnote(comp, 0)).toBeNull();
  });
  it("singular noun for exactly one estimated champion", () => {
    const comp: AggregatedComp = { cc: 1, damage: 1, tankiness: 1, mobility: 1, utility: 1, engage: 1, estimatedCount: 1 };
    expect(estimatedFootnote(comp, 3)).toBe("Some ratings estimated (1 of 3 champion).");
  });
  it("plural noun for 2+ estimated champions", () => {
    const comp: AggregatedComp = { cc: 1, damage: 1, tankiness: 1, mobility: 1, utility: 1, engage: 1, estimatedCount: 2 };
    expect(estimatedFootnote(comp, 5)).toBe("Some ratings estimated (2 of 5 champions).");
  });
});
