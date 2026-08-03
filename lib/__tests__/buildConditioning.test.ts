/**
 * Feature 1 (matchup) + Feature 2 (item optimizer) selection primitives.
 * Pure, network-free — mirrors recommend.test.ts's convention.
 */
import { describe, it, expect } from "vitest";
import {
  conditionedLeader,
  buildOptimizedPath,
  resolveMatchupSlot,
  OPTIMIZER_MIN_SAMPLE,
  MATCHUP_MIN_SAMPLE,
} from "../buildConditioning";

const item = (itemId: number, occ: number, wpa: number) => ({
  itemId,
  occurrence: occ,
  wpaOverall: wpa,
});

describe("conditionedLeader", () => {
  it("picks highest WPA among candidates clearing the sample floor", () => {
    const pool = [item(1, 5000, 0.2), item(2, 4000, 1.9), item(3, 100, 9.0)];
    // #3's 9.0 is a sub-floor fluke (occ 100 < 300); #2 wins on WPA above it.
    expect(conditionedLeader(pool, 300)?.itemId).toBe(2);
  });
  it("breaks equal-WPA item ties by item id, independent of provider order", () => {
    const pool = [item(2, 5000, 1.0), item(1, 5000, 1.0)];
    expect(conditionedLeader(pool, 300)?.itemId).toBe(1);
  });
  it("returns null when nothing clears the floor", () => {
    expect(conditionedLeader([item(1, 100, 5)], 300)).toBeNull();
  });
  it("honours the exclude predicate", () => {
    const pool = [item(1, 9000, 2.0), item(2, 8000, 1.0)];
    expect(conditionedLeader(pool, 300, (e) => e.itemId === 1)?.itemId).toBe(2);
  });
  it("OPTIMIZER_MIN_SAMPLE is a defensible small-but-nonzero floor", () => {
    expect(OPTIMIZER_MIN_SAMPLE).toBeGreaterThan(0);
    expect(OPTIMIZER_MIN_SAMPLE).toBeLessThan(1000);
  });

  it("adoptFrac rejects a high-WPA tail spike below the adoption-relative floor", () => {
    // Regression for the live smoke finding: Archangel's-style 430-game / +3.69
    // spike in a large conditioned pool must NOT win over a well-adopted item.
    const pool = [
      { occurrence: 100000, wpaOverall: 0.4 }, // head, well-adopted
      { occurrence: 430, wpaOverall: 3.69 }, // tail spike
    ];
    // total ~100430, 5% ≈ 5021 → spike (430) excluded, head wins.
    expect(conditionedLeader(pool, 300, undefined, 0.05)).toBe(pool[0]);
    // Without the adoption floor (flat 300), the spike would win — proves it's real.
    expect(conditionedLeader(pool, 300, undefined, 0)).toBe(pool[1]);
  });
});

describe("buildOptimizedPath (greedy conditioned chain)", () => {
  it("walks full depth, conditioning each slot on the running prefix", async () => {
    const calls: number[][] = [];
    const fixtures: Record<string, ReturnType<typeof item>[]> = {
      "3078": [item(20, 4000, 0.8), item(21, 3000, 0.5)], // slot2 | first=3078
      "3078,20": [item(30, 2000, 1.2), item(31, 1500, 0.3)], // slot3 | first,second
    };
    const rest = await buildOptimizedPath(
      async (prefix) => {
        calls.push(prefix);
        return fixtures[prefix.join(",")] ?? [];
      },
      2,
      300,
      [3078] // seed = core first legendary
    );
    expect(rest.map((r) => r.itemId)).toEqual([20, 30]);
    // Prefix grew: slot2 saw [3078], slot3 saw [3078, 20].
    expect(calls).toEqual([[3078], [3078, 20]]);
  });

  it("truncates the moment a conditioned slot collapses below the floor", async () => {
    const rest = await buildOptimizedPath(
      async (prefix) => {
        if (prefix.length === 1) return [item(20, 4000, 0.8)]; // slot2 ok
        return [item(30, 50, 5.0)]; // slot3 sub-floor → truncate
      },
      2,
      300,
      [3078]
    );
    expect(rest.map((r) => r.itemId)).toEqual([20]); // stopped at slot2
  });

  it("never re-picks a seeded or already-chosen item", async () => {
    const rest = await buildOptimizedPath(
      async () => [item(3078, 9000, 3.0), item(20, 4000, 0.8)], // 3078 is seeded
      2,
      300,
      [3078]
    );
    expect(rest[0].itemId).toBe(20); // seed excluded despite higher WPA
  });
});

describe("resolveMatchupSlot (per-slot conditioned-or-fallback)", () => {
  const fallback = item(999, 100000, 0.0);
  it("uses the conditioned leader when it clears the matchup floor", () => {
    const cond = [item(1, MATCHUP_MIN_SAMPLE + 50, 1.5)];
    const r = resolveMatchupSlot(cond, fallback, MATCHUP_MIN_SAMPLE);
    expect(r.conditioned).toBe(true);
    expect(r.entry.itemId).toBe(1);
  });
  it("falls back (conditioned:false) when the conditioned pool is empty (403 case)", () => {
    const r = resolveMatchupSlot([], fallback, MATCHUP_MIN_SAMPLE);
    expect(r.conditioned).toBe(false);
    expect(r.entry.itemId).toBe(999);
  });
  it("falls back when the conditioned sample is below the floor", () => {
    const r = resolveMatchupSlot([item(1, 10, 5.0)], fallback, MATCHUP_MIN_SAMPLE);
    expect(r.conditioned).toBe(false);
    expect(r.entry.itemId).toBe(999);
  });
});
