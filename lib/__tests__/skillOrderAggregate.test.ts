import { describe, expect, it } from "vitest";
import { buildRecommendedSkillGrid } from "@/components/hextech/skillOrder";
import { SKILL_ROWS } from "@/components/skillOrderGrid";
import {
  aggregateRecordedSkillOrders,
  assertLegalSkillOrder,
} from "@/lib/skillOrderAggregate";
import { buildSkillOrderModel, type Ability } from "@/lib/skillOrderModel";

const abilities = (value: string): Ability[] => value.split("") as Ability[];

/** Dun#NA1 / Viktor mid — the 22 stored timeline orders behind the live OTP
 * card. The final entry is shorter because that game ended before level 18. */
const DUN_VIKTOR_22 = [
  ["Q", "E", "E", "Q", "E", "R", "Q", "E", "W", "E", "E", "Q", "R", "W", "Q", "R", "Q", "W"],
  ["Q", "E", "E", "Q", "E", "R", "E", "Q", "W", "E", "E", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "Q", "Q", "E", "Q", "E", "R", "Q", "W", "Q", "R", "W"],
  ["Q", "E", "W", "E", "E", "E", "R", "E", "Q", "Q", "E", "W", "Q", "R", "R", "Q", "Q", "W"],
  ["Q", "E", "W", "E", "E", "R", "E", "E", "Q", "Q", "E", "Q", "W", "R", "R", "Q", "Q", "W"],
  ["Q", "E", "W", "E", "E", "R", "E", "E", "Q", "E", "Q", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "W", "E", "E", "R", "Q", "E", "Q", "E", "E", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "Q", "Q", "E", "Q", "E", "R", "Q", "W", "Q", "R", "W"],
  ["Q", "E", "E", "Q", "E", "R", "E", "Q", "W", "E", "E", "Q", "W", "R", "Q", "R", "Q", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "E", "Q", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "E", "Q", "Q"],
  ["Q", "E", "W", "E", "E", "R", "E", "E", "Q", "E", "Q", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["E", "Q", "W", "E", "E", "R", "E", "E", "Q", "E", "Q", "Q", "W", "R", "R", "Q", "Q", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "Q", "E", "Q", "W", "R", "Q", "Q", "R", "W"],
  ["Q", "E", "W", "E", "E", "R", "E", "Q", "E", "E", "Q", "Q", "Q", "R", "W", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "E", "Q", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "E", "Q", "Q", "R", "W", "Q", "Q", "R", "W"],
  ["Q", "E", "W", "E", "E", "R", "E", "Q", "Q", "E", "Q", "E", "R", "Q", "W", "Q", "R", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "Q", "E", "Q", "R", "W", "Q", "R", "Q", "W"],
  ["Q", "E", "W", "E", "E", "R", "Q", "E", "Q", "E", "E", "Q", "W", "R", "Q", "Q", "R", "W"],
  ["E", "Q", "W", "E", "E", "R", "E", "E", "Q", "Q", "E", "Q", "R", "W", "Q", "R", "Q", "W"],
  ["Q", "E", "E", "W", "E", "R", "E", "E", "Q", "E", "Q", "R", "Q", "Q", "Q", "W", "W", "W"],
] as const;

describe("aggregateRecordedSkillOrders", () => {
  it("keeps modal intent while enforcing rank caps and the ultimate schedule", () => {
    const model = aggregateRecordedSkillOrders([
      ["Q", "E", "E", "R", "W"],
      ["Q", "W", "E", "R"],
      ["W", "E", "Q"],
    ]);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(["Q", "E", "E", "W", "W"]);
    expect(model!.levels).toEqual({ Q: [1], W: [4, 5], E: [2, 3], R: [] });
    expect(model!.priority).toEqual(["Q", "E", "W"]);
    assertLegalSkillOrder(model!.order);
  });

  it("uses remaining observations as the second tie-break", () => {
    const model = aggregateRecordedSkillOrders([
      ["Q", "W", "W"],
      ["W", "W", "W"],
    ]);

    expect(model!.order).toEqual(["W", "W", "W"]);
    assertLegalSkillOrder(model!.order);
  });

  it("caps a synthetic over-selected ability instead of publishing an impossible order", () => {
    const values = Array.from(
      { length: 3 },
      () => ["E", "E", "E", "E", "E", "E", "E", "E", "E", "E", "R", "Q", "Q", "Q", "Q", "R", "W", "W"]
    );
    const model = aggregateRecordedSkillOrders(values);

    expect(model).not.toBeNull();
    expect(model!.order).toHaveLength(18);
    expect(model!.levels.E).toHaveLength(5);
    expect(model!.levels.R).toEqual([6, 11, 16]);
    assertLegalSkillOrder(model!.order);
  });

  it("normalizes the real Dun/Viktor 22-game sample to a legal order", () => {
    const model = aggregateRecordedSkillOrders(DUN_VIKTOR_22);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(abilities("QEEEEREQQQRQWWWRWW"));
    expect(model!.levels).toEqual({
      Q: [1, 8, 9, 10, 12],
      W: [13, 14, 15, 17, 18],
      E: [2, 3, 4, 5, 7],
      R: [6, 11, 16],
    });
    expect(model!.sampleSize).toBe(22);
    assertLegalSkillOrder(model!.order);
  });

  it("uses only timeline-backed orders for the exact denominator", () => {
    const model = aggregateRecordedSkillOrders([
      ["Q", "W"],
      null,
      [],
      "malformed",
      ["Q", "not-an-ability", "W"],
      ["Q", "E"],
    ]);

    expect(model?.sampleSize).toBe(2);
    expect(model?.observedLevels).toBe(2);
    expect(model?.completed).toBe(false);
    expect(model?.inferredTail).toBeUndefined();
    expect(model?.completionBasis).toBeUndefined();
    expect(model?.inferredBasis).toBeUndefined();
  });

  it("leaves an unreached level empty instead of deriving a tail", () => {
    const seventeen = abilities("QWEQWRQWEQWREEQRW");
    const model = aggregateRecordedSkillOrders([seventeen]);

    expect(model).not.toBeNull();
    expect(model!.observedLevels).toBe(17);
    expect(model!.order).toHaveLength(17);
    expect(model!.inferredTail).toBeUndefined();

    const grid = buildRecommendedSkillGrid(model!);
    for (const row of grid) expect(row[17]).toBeNull();
    expect(SKILL_ROWS.flatMap((_, row) => grid[row]).some((cell) => cell?.level === 18)).toBe(false);
    assertLegalSkillOrder(model!.order);
  });

  it("exports a cheap guard for caps and illegal ultimate levels", () => {
    expect(() => assertLegalSkillOrder(abilities("QQQQQQ"))).toThrow(/cap/);
    expect(() => assertLegalSkillOrder(abilities("QWER"))).toThrow(/R is not legal at level 4/);
    expect(() => assertLegalSkillOrder(abilities("QW"))).not.toThrow();
  });

  it("does not change the Builds page's existing completed recommendation", () => {
    const model = buildSkillOrderModel({
      order: abilities("WQEQQRQWQWRWWEE"),
      priorityIds: abilities("QWE"),
      play: 71667,
      win: 41408,
      pickRate: 0.57,
    });

    expect(model).not.toBeNull();
    expect(model!.priority).toEqual(abilities("QWE"));
    expect(model!.order).toEqual(abilities("WQEQQRQWQWRWWEEREE"));
    expect(model!.levels).toEqual({
      Q: [2, 4, 5, 7, 9],
      W: [1, 8, 10, 12, 13],
      E: [3, 14, 15, 17, 18],
      R: [6, 11, 16],
    });
    expect(model!.completed).toBe(true);
  });
});
