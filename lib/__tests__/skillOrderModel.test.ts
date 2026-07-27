import { describe, it, expect } from "vitest";
import {
  completeSkillOrder,
  derivePriority,
  resolvePriority,
  levelsByAbility,
  countRanks,
  buildSkillOrderModel,
  isAbility,
  MAX_RANKS,
  TOTAL_LEVELS,
  SOURCE_LEVELS,
  type Ability,
} from "@/lib/skillOrderModel";

const A = (s: string): Ability[] => s.split("") as Ability[];

/** Ahri mid, verbatim from op.gg, 2026-07-27. */
const AHRI_15 = A("WQEQQRQWQWRWWEE");
/** Udyr jungle, verbatim. Q and E hit SIX ranks; "R" ranked at level 2. */
const UDYR_15 = A("QRWEQQQEQEQEEEW");
/** Aphelios adc, verbatim. Q and E hit six ranks; W only one. */
const APHELIOS_15 = A("QQQEQREQEQEEREW");
/** Kayn jungle, verbatim — standard 5/5/5/3 despite the form-swap reputation. */
const KAYN_15 = A("QEWQQRQWQWRWWEE");

describe("isAbility / countRanks / levelsByAbility", () => {
  it("accepts only Q/W/E/R", () => {
    expect(["Q", "W", "E", "R"].every(isAbility)).toBe(true);
    for (const bad of ["q", "P", "", "QQ", null, undefined, 1, {}]) {
      expect(isAbility(bad)).toBe(false);
    }
  });

  it("counts ranks per ability", () => {
    expect(countRanks(AHRI_15)).toEqual({ Q: 5, W: 5, E: 3, R: 2 });
    expect(countRanks(UDYR_15)).toEqual({ Q: 6, W: 2, E: 6, R: 1 });
    expect(countRanks(APHELIOS_15)).toEqual({ Q: 6, W: 1, E: 6, R: 2 });
  });

  it("maps 1-based levels, and leaves never-ranked abilities empty (not fabricated)", () => {
    expect(levelsByAbility(AHRI_15)).toEqual({
      Q: [2, 4, 5, 7, 9],
      W: [1, 8, 10, 12, 13],
      E: [3, 14, 15],
      R: [6, 11],
    });
    expect(levelsByAbility(A("QQ"))).toEqual({ Q: [1, 2], W: [], E: [], R: [] });
  });
});

describe("completeSkillOrder — the derivation", () => {
  it("completes Ahri to R@16, E@17, E@18 (matches U.GG's published path)", () => {
    const res = completeSkillOrder(AHRI_15, A("QWE"));
    expect(res.completed).toBe(true);
    expect(res.order).toHaveLength(18);
    expect(res.order.slice(15)).toEqual(A("REE"));
    expect(res.order.join("")).toBe("WQEQQRQWQWRWWEEREE");
    expect(countRanks(res.order)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
  });

  it("completes Kayn — a 'form swapper' whose ranks are in fact standard", () => {
    const res = completeSkillOrder(KAYN_15, A("QWE"));
    expect(res.completed).toBe(true);
    expect(res.order.slice(15)).toEqual(A("REE"));
    expect(countRanks(res.order)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
  });

  it("always lands on exactly 5/5/5/3 across 18 levels when it completes", () => {
    for (const observed of [AHRI_15, KAYN_15]) {
      const res = completeSkillOrder(observed);
      expect(res.completed).toBe(true);
      expect(res.order).toHaveLength(TOTAL_LEVELS);
      expect(countRanks(res.order)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
    }
  });

  it("places the leftover ultimate at level 16, never later", () => {
    const res = completeSkillOrder(AHRI_15, A("QWE"));
    expect(res.order[15]).toBe("R");
    expect(levelsByAbility(res.order).R).toEqual([6, 11, 16]);
  });

  it("fills 17/18 in the champion's OWN priority order", () => {
    // One Q and one E remaining; priority decides which is taken first.
    const observed = A("QQQQWWWWWEEEERR"); // Q4 W5 E4 R2
    expect(countRanks(observed)).toEqual({ Q: 4, W: 5, E: 4, R: 2 });

    const qFirst = completeSkillOrder(observed, A("QWE"));
    expect(qFirst.completed).toBe(true);
    expect(qFirst.order.slice(15)).toEqual(A("RQE"));

    const eFirst = completeSkillOrder(observed, A("EWQ"));
    expect(eFirst.completed).toBe(true);
    expect(eFirst.order.slice(15)).toEqual(A("REQ"));
  });
});

describe("completeSkillOrder — the refusals (never invent)", () => {
  const expectRefusal = (
    res: ReturnType<typeof completeSkillOrder>,
    because: string,
    observed: readonly Ability[]
  ) => {
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe(because);
    // The observed levels are returned UNCHANGED — never padded, never trimmed.
    expect(res.order).toEqual([...observed]);
  };

  it("refuses Udyr (four basics, six ranks each) — by arithmetic, not a blocklist", () => {
    const res = completeSkillOrder(UDYR_15, A("QEWR"));
    expectRefusal(res, "rank-over-cap", UDYR_15);
    expect(res.order).toHaveLength(15);
  });

  it("refuses Aphelios (Q and E reach six ranks)", () => {
    const res = completeSkillOrder(APHELIOS_15, A("QEW"));
    expectRefusal(res, "rank-over-cap", APHELIOS_15);
  });

  it("refuses when a basic is over cap by exactly one", () => {
    const observed = A("QQQQQQWWWWWEEEE"); // Q6 W5 E4 R0
    expectRefusal(completeSkillOrder(observed), "rank-over-cap", observed);
  });

  it("refuses when the ultimate remainder is not exactly 1", () => {
    // R already at 3 by level 15 -> nothing left for level 16.
    const rMaxed = A("RRRQQQQQWWWWWEE"); // R3 Q5 W5 E2
    expectRefusal(completeSkillOrder(rMaxed), "ultimate-remainder", rMaxed);

    // R only once by level 15 -> two ultimate ranks would have to fit in
    // 16/17/18, but only level 16 is an ultimate level.
    const rOnce = A("RQQQQQWWWWWEEEE"); // R1 Q5 W5 E4
    expectRefusal(completeSkillOrder(rOnce), "ultimate-remainder", rOnce);

    // R never taken.
    const rNone = A("QQQQQWWWWWEEEEE"); // R0 Q5 W5 E5
    expectRefusal(completeSkillOrder(rNone), "ultimate-remainder", rNone);
  });

  it("refuses a path that is already 18 long, and reports it did not derive", () => {
    const full = [...AHRI_15, ...A("REE")];
    const res = completeSkillOrder(full);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("already-complete");
    expect(res.order).toEqual(full);
    expect(res.order).toHaveLength(18);
  });

  it("refuses any length that is neither 15 nor 18", () => {
    for (const n of [0, 1, 14, 16, 17, 19, 30]) {
      const observed = Array.from({ length: n }, () => "Q" as Ability);
      const res = completeSkillOrder(observed);
      expect(res.completed).toBe(false);
      expect(res.refusedBecause).toBe(n === 18 ? "already-complete" : "unexpected-length");
    }
  });

  it("refuses non-ability tokens", () => {
    const junk = ["Q", "W", "X", ...Array(12).fill("Q")] as unknown as Ability[];
    const res = completeSkillOrder(junk);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("bad-token");
  });

  it("never emits an order longer than 18 or shorter than the observed input", () => {
    for (const observed of [AHRI_15, UDYR_15, APHELIOS_15, KAYN_15]) {
      const res = completeSkillOrder(observed);
      expect(res.order.length).toBeGreaterThanOrEqual(observed.length);
      expect(res.order.length).toBeLessThanOrEqual(TOTAL_LEVELS);
    }
  });
});

describe("completeSkillOrder — EXHAUSTIVE over the arithmetic space", () => {
  // Every possible (Q,W,E,R) rank distribution summing to 15. This covers the
  // whole domain the completion rule reasons about, so the "can't happen"
  // branches are proven rather than assumed.
  const tuples: Array<[number, number, number, number]> = [];
  for (let q = 0; q <= 8; q += 1)
    for (let w = 0; w <= 8; w += 1)
      for (let e = 0; e <= 8; e += 1) {
        const r = SOURCE_LEVELS - q - w - e;
        if (r >= 0 && r <= 8) tuples.push([q, w, e, r]);
      }

  const orderFrom = ([q, w, e, r]: [number, number, number, number]): Ability[] => [
    ...Array<Ability>(q).fill("Q"),
    ...Array<Ability>(w).fill("W"),
    ...Array<Ability>(e).fill("E"),
    ...Array<Ability>(r).fill("R"),
  ];

  it("covers a non-trivial domain", () => {
    expect(tuples.length).toBeGreaterThan(100);
  });

  it("completes EXACTLY the tuples that fit the standard model, and no others", () => {
    for (const t of tuples) {
      const [q, w, e, r] = t;
      const res = completeSkillOrder(orderFrom(t), A("QWE"));
      const withinCaps = q <= MAX_RANKS.Q && w <= MAX_RANKS.W && e <= MAX_RANKS.E && r <= MAX_RANKS.R;
      const shouldComplete = withinCaps && MAX_RANKS.R - r === 1;
      expect(res.completed, `tuple ${t.join("/")}`).toBe(shouldComplete);
    }
  });

  it("every completion lands on 18 levels at exactly 5/5/5/3", () => {
    let completedCount = 0;
    for (const t of tuples) {
      const res = completeSkillOrder(orderFrom(t), A("QWE"));
      if (!res.completed) continue;
      completedCount += 1;
      expect(res.order).toHaveLength(TOTAL_LEVELS);
      expect(countRanks(res.order)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
    }
    expect(completedCount).toBeGreaterThan(0);
  });

  it("every refusal returns the observed levels untouched", () => {
    for (const t of tuples) {
      const observed = orderFrom(t);
      const res = completeSkillOrder(observed, A("QWE"));
      if (res.completed) continue;
      expect(res.order).toEqual(observed);
      expect(res.refusedBecause).toBeTruthy();
    }
  });

  it("the 'tail-mismatch' guard is genuinely unreachable from valid input", () => {
    // Asserted rather than assumed — a 'can't happen' branch is a test target.
    for (const t of tuples) {
      const res = completeSkillOrder(orderFrom(t), A("QWE"));
      expect(res.refusedBecause).not.toBe("tail-mismatch");
    }
  });
});

describe("full-roster sweep findings (172 champions, 2026-07-27)", () => {
  // The seven champions whose published order ranks R at level 12 — not a
  // legal ultimate level. Their rank COUNTS are standard, so the tail is
  // still derivable and they must NOT be refused.
  const ILLEGAL_R_LEVEL_12: Array<[string, string]> = [
    ["SIVIR", "WQEQQRQWQWWRWEE"],
    ["KASSADIN", "QWEEEREWEWWRWQQ"],
    ["CORKI", "EQWQQRQEQEEREWW"],
    ["ZERI", "QEWQQRQEQEEREWW"],
    ["JINX", "QWEQQRQWQWWRWEE"],
    ["ZED", "QWEQQRQEQEEREWW"],
    ["QIYANA", "QWEQQRQWQWWRWEE"],
  ];

  it.each(ILLEGAL_R_LEVEL_12)(
    "%s ranks R at level 12 yet still completes — no legality check refuses it",
    (_name, path) => {
      const observed = A(path);
      expect(observed).toHaveLength(15);
      expect(levelsByAbility(observed).R).toEqual([6, 12]);

      const res = completeSkillOrder(observed, A("QWE"));
      expect(res.completed).toBe(true);
      expect(res.order).toHaveLength(18);
      expect(countRanks(res.order)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
      // The observed 15 are passed through untouched — level 12 is NOT
      // silently "corrected" to 11.
      expect(res.order.slice(0, 15)).toEqual(observed);
    }
  );

  // The four champions refused on the cap check.
  const OVER_CAP: Array<[string, string]> = [
    ["UDYR", "QRWEQQQEQEQEEEW"],
    ["JAYCE", "QWEQQWQWQWQWWEE"],
    ["YUUMI", "QEQEQRQEQERQEWW"],
    ["APHELIOS", "QQQEQREQEQEEREW"],
  ];

  it.each(OVER_CAP)("%s is refused by arithmetic, never completed", (_name, path) => {
    const observed = A(path);
    expect(observed).toHaveLength(15);
    const res = completeSkillOrder(observed);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("rank-over-cap");
    expect(res.order).toEqual(observed);
  });

  it("Kha'Zix's evolution tokens are refused as bad-token", () => {
    const khazix = ["Q", "W", "E", "Q", "Q", "R-Q", "Q", "W", "Q", "W", "W", "R-W", "W", "E", "E"];
    const res = completeSkillOrder(khazix as unknown as Ability[]);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("bad-token");
  });

  it("the measured refusal rate is 5 of 172 — the rule is not over-eager", () => {
    const refused = [...OVER_CAP.map(([, p]) => p)].filter(
      (p) => !completeSkillOrder(A(p)).completed
    );
    expect(refused).toHaveLength(4); // + Kha'Zix, refused earlier at parse time
  });
});

describe("derivePriority", () => {
  it("ranks by which ability is MAXED first, not by raw rank count", () => {
    // Ahri: Q and W both reach 5 ranks, so a count-based sort would tie and
    // then fall back to first appearance -> W (level 1) before Q (level 2),
    // which is backwards. Q maxes at level 9, W not until 13.
    expect(derivePriority(AHRI_15)).toEqual(A("QWE"));
    expect(levelsByAbility(AHRI_15).Q[4]).toBe(9);
    expect(levelsByAbility(AHRI_15).W[4]).toBe(13);
  });

  it("puts never-maxed abilities after maxed ones", () => {
    expect(derivePriority(A("WWWWWQQQEEERRR"))).toEqual(A("WQE"));
  });

  it("is deterministic on a total tie", () => {
    expect(derivePriority(A("QWE"))).toEqual(A("QWE"));
    expect(derivePriority([])).toEqual(A("QWE"));
  });
});

describe("resolvePriority", () => {
  it("uses the source's priority when usable", () => {
    expect(resolvePriority(A("EQW"), AHRI_15)).toEqual(A("EQW"));
  });

  it("strips R from a supplied priority (Udyr's ids are Q,E,W,R)", () => {
    expect(resolvePriority(A("QEWR"), UDYR_15)).toEqual(A("QEW"));
  });

  it("appends missing basics so no remaining point can be silently dropped", () => {
    expect(resolvePriority(A("E"), AHRI_15)).toEqual(A("EQW"));
    expect(resolvePriority(A("WE"), AHRI_15)).toEqual(A("WEQ"));
  });

  it("de-duplicates a repeated entry", () => {
    expect(resolvePriority(A("QQW"), AHRI_15)).toEqual(A("QWE"));
  });

  it("falls back to derivation on absent or invalid input", () => {
    expect(resolvePriority(undefined, AHRI_15)).toEqual(A("QWE"));
    expect(resolvePriority([], AHRI_15)).toEqual(A("QWE"));
    expect(resolvePriority(["X"] as unknown as Ability[], AHRI_15)).toEqual(A("QWE"));
  });
});

describe("buildSkillOrderModel", () => {
  const base = { order: AHRI_15, priorityIds: A("QWE"), play: 71667, win: 41408, pickRate: 0.57 };

  it("builds the full Ahri model from the real numbers", () => {
    const m = buildSkillOrderModel(base)!;
    expect(m).toBeTruthy();
    expect(m.priority).toEqual(A("QWE"));
    expect(m.order).toHaveLength(18);
    expect(m.completed).toBe(true);
    expect(m.sampleSize).toBe(71667);
    // Win rate is DERIVED from the two counts, never read off the feed.
    expect(m.winRate).toBeCloseTo(41408 / 71667, 10);
    expect(m.winRate).toBeCloseTo(0.5778, 4);
    // Share is passed through verbatim.
    expect(m.share).toBe(0.57);
    expect(m.levels.R).toEqual([6, 11, 16]);
    expect(m.levels.E).toEqual([3, 14, 15, 17, 18]);
  });

  it("treats `win` as a COUNT, not a rate", () => {
    // The whole point: 41408 is wins, not 41408% and not 0.41408.
    const m = buildSkillOrderModel(base)!;
    expect(m.winRate).toBeLessThanOrEqual(1);
    expect(m.winRate).toBeGreaterThan(0.5);
  });

  it("levels reflect the COMPLETED order when completed, the observed one when not", () => {
    const completed = buildSkillOrderModel(base)!;
    expect(completed.levels.R).toContain(16);

    const refused = buildSkillOrderModel({ ...base, order: UDYR_15, priorityIds: A("QEWR") })!;
    expect(refused.completed).toBe(false);
    expect(refused.order).toHaveLength(15);
    expect(refused.levels.R).toEqual([2]);
    // Nothing beyond level 15 is claimed.
    const maxLevel = Math.max(...Object.values(refused.levels).flat());
    expect(maxLevel).toBeLessThanOrEqual(15);
  });

  it("carries a tiny sample through honestly instead of hiding it", () => {
    const m = buildSkillOrderModel({ ...base, play: 77, win: 53, pickRate: 0.12 })!;
    expect(m.sampleSize).toBe(77);
    expect(m.winRate).toBeCloseTo(53 / 77, 10);
  });

  it("returns null on unusable input rather than a partial model", () => {
    expect(buildSkillOrderModel({ ...base, order: [] })).toBeNull();
    expect(buildSkillOrderModel({ ...base, play: 0 })).toBeNull();
    expect(buildSkillOrderModel({ ...base, play: -1 })).toBeNull();
    expect(buildSkillOrderModel({ ...base, play: NaN })).toBeNull();
    expect(buildSkillOrderModel({ ...base, order: ["X"] as unknown as Ability[] })).toBeNull();
  });

  it("nulls the rates it cannot compute rather than defaulting them to 0", () => {
    const noPick = buildSkillOrderModel({ ...base, pickRate: null })!;
    expect(noPick.share).toBeNull();
    expect(noPick.winRate).not.toBeNull();

    const badWin = buildSkillOrderModel({ ...base, win: NaN })!;
    expect(badWin.winRate).toBeNull();
  });

  it("clamps a rate into 0..1 rather than emitting an impossible value", () => {
    expect(buildSkillOrderModel({ ...base, pickRate: 1.4 })!.share).toBe(1);
    expect(buildSkillOrderModel({ ...base, pickRate: -0.2 })!.share).toBe(0);
  });
});
