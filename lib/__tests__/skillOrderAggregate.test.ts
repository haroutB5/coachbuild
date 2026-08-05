import { describe, expect, it } from "vitest";
import { buildRecommendedSkillGrid } from "@/components/hextech/skillOrder";
import { SKILL_ROWS } from "@/components/skillOrderGrid";
import {
  aggregateRecordedSkillOrders,
  assertLegalSkillOrder,
} from "@/lib/skillOrderAggregate";
import { kitFromMaxRanks, STANDARD_KIT } from "@/lib/championKit";
import { buildSkillOrderModel, type Ability } from "@/lib/skillOrderModel";

const abilities = (value: string): Ability[] => value.split("") as Ability[];

/** Dun#NA1 / Viktor mid — pre-backfill contaminated data retained as
 * adversarial input. The final entry is shorter because that game ended before
 * level 18. */
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

/** Representative subset of Zaahen's stored timeline repro. Keep the compact
 * strings verbatim; the aggregator receives their one-character
 * levels, matching the database's parsed array shape. */
const ZAAHEN_STORED_ORDERS = [
  "WQEQQRQEQEREEWWRWW",
  "WQEQQRQEQEREEWWWRW",
  "QEWQQRQEQEREEWWRW",
  "QEWQQRQEQEREEWWR",
  "QWEQQRQEQER",
  "EQWQQRQEQEREEWWRWW",
  "QEWQQRQEQEREEW",
  "WQEQQRQEQEREE",
  "EQQWQRQEQEREE",
  "QEWQQRQEQEREEWWRWW",
  "QWEQQRQEQEREEWW",
  "WEQQQRQEQEREE",
  "Q",
] as const;

const UDYR_KIT = kitFromMaxRanks([6, 6, 6, 6])!;
const JAYCE_KIT = kitFromMaxRanks([6, 6, 6, 1])!;
const APHELIOS_KIT = kitFromMaxRanks([6, 6, 6, 3], "Aphelios")!;
const YUUMI_KIT = kitFromMaxRanks([6, 5, 5, 3])!;
const ELISE_KIT = kitFromMaxRanks([5, 5, 5, 4])!;

/** Real stored non-standard-kit orders supplied by the recorded-order audit. */
const UDYR_STORED_ORDERS = ["QRWERRRQRQRQQQEWW", "QRWEQQQEQEQEEE"] as const;
const JAYCE_STORED_ORDER = "QWEQQWQWQWQWWEEEEE" as const;
const APHELIOS_STORED_ORDER = "WQQQQREQEQEREEEWWR" as const;
/** Yuumi's stored path from the existing non-standard-kit fixture. Her extra
 *  starting point permits one skipped purchasable rank, so no tail is forced. */
const YUUMI_STORED_ORDERS = ["QEQEQRQEQERQEWW"] as const;
const ELISE_STORED_ORDER = "WQEQQRQWQWRWWEE" as const;

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

  it("keeps the Zaahen aggregate on a real basics prefix", () => {
    const model = aggregateRecordedSkillOrders(ZAAHEN_STORED_ORDERS.map(abilities));
    const explicitStandard = aggregateRecordedSkillOrders(ZAAHEN_STORED_ORDERS.map(abilities), STANDARD_KIT);

    expect(model).not.toBeNull();
    expect(explicitStandard).not.toBeNull();
    expect(model!.order).toEqual(abilities("QEWQQRQEQEREEWWRWW"));
    expect(explicitStandard!.order).toEqual(model!.order);
    expect(model!.order.slice(0, 3)).toContain("W");
    expect(model!.sampleSize).toBe(13);

    const aggregateBasics = model!.order.filter((ability) => ability !== "R");
    const gameBasics = ZAAHEN_STORED_ORDERS.map((stored) => abilities(stored).filter((ability) => ability !== "R"));
    const chosenPrefix: Ability[] = [];

    for (let slot = 0; slot < aggregateBasics.length; slot += 1) {
      const electorate = gameBasics.filter(
        (game) =>
          game.length > slot &&
          game.slice(0, slot).every((ability, index) => ability === chosenPrefix[index])
      );
      if (electorate.length === 0) break;

      expect(electorate.some((game) => game[slot] === aggregateBasics[slot])).toBe(true);
      chosenPrefix.push(aggregateBasics[slot]);
    }

    expect(chosenPrefix).toEqual(aggregateBasics);
    assertLegalSkillOrder(model!.order);
  });

  it("walks Udyr R as a fourth basic under six-rank caps", () => {
    const model = aggregateRecordedSkillOrders(UDYR_STORED_ORDERS.map(abilities), UDYR_KIT);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(abilities("QRWEQQQEQEQEEEWWW"));
    expect(model!.levels).toEqual({
      Q: [1, 5, 6, 7, 9, 11],
      W: [3, 15, 16, 17],
      E: [4, 8, 10, 12, 13, 14],
      R: [2],
    });
    expect(model!.order.length).toBe(17);
    expect(model!.kit).toBe(UDYR_KIT);
    assertLegalSkillOrder(model!.order, UDYR_KIT);
  });

  it("keeps Jayce's eighteen basic points and never emits Transform", () => {
    const model = aggregateRecordedSkillOrders([abilities(JAYCE_STORED_ORDER)], JAYCE_KIT);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(abilities("QWEQQWQWQWQWWEEEEE"));
    expect(model!.order).toHaveLength(18);
    expect(model!.levels.R).toEqual([]);
    expect(model!.order).not.toContain("R");
    expect(() => assertLegalSkillOrder(model!.order, JAYCE_KIT)).not.toThrow();
    expect(() => assertLegalSkillOrder(abilities("RQWE"), JAYCE_KIT)).toThrow(/not a recorded/);
  });

  it("normalizes Aphelios zero-cost R markers without charging a point", () => {
    const model = aggregateRecordedSkillOrders([abilities(APHELIOS_STORED_ORDER)], APHELIOS_KIT);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(abilities("WQQQQREQEQREEEERWW"));
    expect(model!.levels.R).toEqual([6, 11, 16]);
    expect(model!.order).toHaveLength(18);
    assertLegalSkillOrder(model!.order, APHELIOS_KIT);
  });

  it("uses kit caps for Yuumi without correcting her extra-point skew", () => {
    const model = aggregateRecordedSkillOrders(YUUMI_STORED_ORDERS.map(abilities), YUUMI_KIT);

    expect(model).not.toBeNull();
    expect(model!.order.length).toBeLessThanOrEqual(17);
    expect(model!.order.length).toBeGreaterThan(0);
    expect(model!.order.filter((ability) => ability === "Q").length).toBeLessThanOrEqual(6);
    expect(model!.order.filter((ability) => ability === "W").length).toBeLessThanOrEqual(5);
    expect(model!.order.filter((ability) => ability === "E").length).toBeLessThanOrEqual(5);
    expect(model!.order.filter((ability) => ability === "R").length).toBeLessThanOrEqual(3);
    assertLegalSkillOrder(model!.order, YUUMI_KIT);
  });

  it("keeps Elise-shaped 5/5/5/R4 timelines on standard R slots", () => {
    const model = aggregateRecordedSkillOrders([abilities(ELISE_STORED_ORDER)], ELISE_KIT);

    expect(model).not.toBeNull();
    expect(model!.levels.R).toEqual([6, 11]);
    expect(model!.order).not.toContain(undefined);
    assertLegalSkillOrder(model!.order, ELISE_KIT);
  });

  it("uses remaining observations as the second tie-break", () => {
    const model = aggregateRecordedSkillOrders([
      ["Q", "W", "W"],
      ["W", "W", "W"],
    ]);

    expect(model!.order).toEqual(["W", "W", "W"]);
    assertLegalSkillOrder(model!.order);
  });

  it("caps malformed six-Q input instead of publishing a sixth Q", () => {
    const values = Array.from({ length: 3 }, () => abilities("QQQQQQWEEERWEWERWW"));
    const model = aggregateRecordedSkillOrders(values);

    expect(model).not.toBeNull();
    expect(model!.order).toHaveLength(18);
    expect(model!.order.filter((ability) => ability === "Q")).toHaveLength(5);
    expect(model!.levels.R).toEqual([6, 11, 16]);
    assertLegalSkillOrder(model!.order);
  });

  it("normalizes delayed R evidence to level 6 and never invents absent R", () => {
    const delayed = aggregateRecordedSkillOrders([abilities("QWEQWQR")]);
    expect(delayed).not.toBeNull();
    expect(delayed!.order).toEqual(abilities("QWEQWRQ"));
    expect(delayed!.levels.R).toEqual([6]);
    assertLegalSkillOrder(delayed!.order);

    const absent = aggregateRecordedSkillOrders([abilities("QWEQWQ")]);
    expect(absent).not.toBeNull();
    expect(absent!.order).toEqual(abilities("QWEQWQ"));
    expect(absent!.levels.R).toEqual([]);
    assertLegalSkillOrder(absent!.order);
  });

  it("uses the prefix walk for the real Dun/Viktor 22-game sample", () => {
    const model = aggregateRecordedSkillOrders(DUN_VIKTOR_22);

    expect(model).not.toBeNull();
    expect(model!.order).toEqual(abilities("QEEWEREEQQRQWWQRWW"));
    expect(model!.levels).toEqual({
      Q: [1, 9, 10, 12, 15],
      W: [4, 13, 14, 17, 18],
      E: [2, 3, 5, 7, 8],
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
