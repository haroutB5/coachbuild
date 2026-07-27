import { describe, it, expect } from "vitest";
import {
  completeSkillOrder,
  derivePriority,
  resolvePriority,
  resolveAllocationPriority,
  isWellFormedPriority,
  observedLevelCount,
  isDerivedLevel,
  levelsByAbility,
  countRanks,
  buildSkillOrderModel,
  isAbility,
  MAX_RANKS,
  TOTAL_LEVELS,
  SOURCE_LEVELS,
  STANDARD_KIT,
  type Ability,
} from "@/lib/skillOrderModel";
import { kitFromMaxRanks } from "@/lib/championKit";
import type { ChampionKit, SkillOrderModel } from "@/lib/types";

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

  // The four champions the STANDARD kit refuses on the cap check. This is now
  // the FALLBACK path (no kit supplied), not what production does for them —
  // see the per-champion block below for their real behaviour. Kept because
  // the fallback is still live whenever ddragon cannot be reached for a
  // champion we have no reason to believe is non-standard.
  const OVER_CAP: Array<[string, string]> = [
    ["UDYR", "QRWEQQQEQEQEEEW"],
    ["JAYCE", "QWEQQWQWQWQWWEE"],
    ["YUUMI", "QEQEQRQEQERQEWW"],
    ["APHELIOS", "QQQEQREQEQEEREW"],
  ];

  it.each(OVER_CAP)(
    "%s is refused under the STANDARD-kit fallback, by arithmetic, never completed",
    (_name, path) => {
      const observed = A(path);
      expect(observed).toHaveLength(15);
      const res = completeSkillOrder(observed);
      expect(res.completed).toBe(false);
      expect(res.refusedBecause).toBe("rank-over-cap");
      expect(res.order).toEqual(observed);
    }
  );

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

// ─────────────────────────────────────────────────────────────────────────────
// PER-CHAMPION CAPS. Every order below is the REAL op.gg published 15, probed
// live 2026-07-27; every kit is ddragon 16.14.1's real maxranks. This block is
// what the hardcoded 5/5/5/3 model got wrong.
// ─────────────────────────────────────────────────────────────────────────────
describe("completeSkillOrder — with the champion's OWN caps", () => {
  const KIT = {
    jayce: kitFromMaxRanks([6, 6, 6, 1])!,
    karma: kitFromMaxRanks([5, 5, 5, 4])!,
    elise: kitFromMaxRanks([5, 5, 5, 4])!,
    nidalee: kitFromMaxRanks([5, 5, 5, 4])!,
    udyr: kitFromMaxRanks([6, 6, 6, 6])!,
    yuumi: kitFromMaxRanks([6, 5, 5, 3])!,
    aphelios: kitFromMaxRanks([6, 6, 6, 3])!,
  };

  it("JAYCE completes — six Q, six W, and NO ultimate in the tail", () => {
    // The champion from the actual bug report. His Transform is granted free
    // at level 1, so all 18 points go into basics and the tail is three E.
    const observed = A("QWEQQWQWQWQWWEE");
    expect(countRanks(observed)).toEqual({ Q: 6, W: 6, E: 3, R: 0 });

    const res = completeSkillOrder(observed, A("QWE"), KIT.jayce);
    expect(res.completed).toBe(true);
    expect(res.order).toHaveLength(18);
    expect(res.order.slice(15)).toEqual(A("EEE"));
    expect(countRanks(res.order)).toEqual({ Q: 6, W: 6, E: 6, R: 0 });
    // Ranking Q six times must NOT trip rank-over-cap.
    expect(res.refusedBecause).toBeUndefined();
  });

  it.each([
    ["KARMA", "QEWQQRQEQEREEWW"],
    ["NIDALEE", "QEWQQRQEQEREEWW"],
    ["ELISE", "WQEQQRQWQWRWWEE"],
  ])("%s (5/5/5/4, one free R rank) completes exactly like a standard champion", (name, path) => {
    const observed = A(path);
    const kit = name === "ELISE" ? KIT.elise : KIT.karma;
    const res = completeSkillOrder(observed, A("QWE"), kit);
    expect(res.completed, name).toBe(true);
    expect(res.order, name).toHaveLength(18);
    // Their order counts PURCHASED points, so R appears 3 times across 18
    // levels — the 4th rank was granted at level 1 and never cost a point.
    expect(countRanks(res.order).R, name).toBe(3);
    expect(res.order[15], name).toBe("R");
  });

  // ── THE SURPLUS KITS. Every order and every `ids` list below was probed
  // LIVE against op.gg 2026-07-27 (patch 16.14) — not copied from a prior
  // transcript. These three used to refuse as `kit-not-derivable`.
  const SURPLUS: Array<[string, string, keyof typeof KIT, string, string, string]> = [
    // name       observed 15        kit         published ids  tail   final counts
    ["UDYR", "QRWEQQQEQEQEEEW", "udyr", "QEWR", "WWW", "6/5/6/1"],
    ["YUUMI", "QEQEQRQEQERQEWW", "yuumi", "QEW", "RWW", "6/4/5/3"],
    ["APHELIOS", "QQQEQREQEQEEREW", "aphelios", "QEW", "RWW", "6/3/6/3"],
  ];

  it.each(SURPLUS)(
    "%s completes to 18 via the PUBLISHED max-priority order",
    (name, path, key, ids, tail, counts) => {
      const observed = A(path);
      const kit = KIT[key as keyof typeof KIT];
      // The premise: subtraction alone genuinely cannot resolve these.
      expect(kit.purchasableTotal, name).toBeGreaterThan(18);

      const res = completeSkillOrder(observed, A(ids), kit);
      expect(res.completed, name).toBe(true);
      expect(res.basis, name).toBe("published");
      expect(res.order, name).toHaveLength(18);
      // The observed 15 pass through byte-for-byte — completion APPENDS, it
      // never edits what the source published.
      expect(res.order.slice(0, 15), name).toEqual(observed);
      expect(res.order.slice(15).join(""), name).toBe(tail);
      expect(res.observedLevels, name).toBe(15);

      const [q, w, e, r] = counts.split("/").map(Number);
      expect(countRanks(res.order), name).toEqual({ Q: q, W: w, E: e, R: r });
      // 18 points, all of them legal for THIS champion.
      expect(q + w + e + r, name).toBe(18);
      for (const a of ["Q", "W", "E"] as const) {
        expect(countRanks(res.order)[a], `${name} ${a}`).toBeLessThanOrEqual(kit.maxRanks[a]);
      }
      expect(countRanks(res.order).R, name).toBeLessThanOrEqual(
        kit.maxRanks.R - kit.freeRanks.R
      );
    }
  );

  it("UDYR is the report: Q6 W5 E6 R1, and the last three points are W", () => {
    // The user's symptom was a path that stopped at 15. This is the exact
    // arithmetic that ends it, spelled out rather than parameterised.
    const res = completeSkillOrder(UDYR_15, A("QEWR"), KIT.udyr);
    expect(countRanks(UDYR_15)).toEqual({ Q: 6, W: 2, E: 6, R: 1 });
    // Q and E are ALREADY at their caps by level 15 — that is why the tail was
    // ambiguous, and why the priority is what settles it.
    expect(countRanks(UDYR_15).Q).toBe(KIT.udyr.maxRanks.Q);
    expect(countRanks(UDYR_15).E).toBe(KIT.udyr.maxRanks.E);
    expect(res.order.join("")).toBe("QRWEQQQEQEQEEEWWWW");
    expect(levelsByAbility(res.order).W).toEqual([3, 15, 16, 17, 18]);
    expect(countRanks(res.order)).toEqual({ Q: 6, W: 5, E: 6, R: 1 });
  });

  it.each(SURPLUS)(
    "%s REFUSES without a published priority — a derived one is blind to R, not merely weaker",
    (name, path, key) => {
      // Reversed 2026-07-27, deliberately. This previously asserted that the
      // three still complete on a derived priority, on the reasoning that "for
      // these three the derived priority happens to agree with the published
      // one". Agreeing is not the same as deciding: `derivePriority` sorts
      // BASIC_ABILITIES, so R is not on the ballot at all. For a DETERMINATE
      // kit that is harmless (subtraction already fixed the multiset); for a
      // SURPLUS kit the spare ranks are exactly what the walk must choose
      // between, so a blind priority fabricates the choice.
      //
      // The sibling test below proves the stakes: same Udyr input, published
      // "R before W" gives RRR and the derived list gives EEE. Whenever those
      // two can differ, "it agreed this time" is not a property we hold.
      const res = completeSkillOrder(A(path), undefined, KIT[key as keyof typeof KIT]);
      expect(res.completed, name).toBe(false);
      expect(res.refusedBecause, name).toBe("kit-not-derivable");
      // A refusal returns the source's 15 untouched — never a truncated or
      // half-built order.
      expect(res.order, name).toEqual(A(path));
      expect(res.observedLevels, name).toBe(15);
    }
  );

  it("the surplus refusal is NOT reached in production — op.gg publishes ids for all three", () => {
    // The gate above only bites when the publication is absent or malformed.
    // Every surplus champion's live payload carries a well-formed `ids` list
    // (probed 2026-07-27, patch 16.14), so the user-visible behaviour is
    // completion, not refusal. This pins that the gate is a safety net rather
    // than a regression to the old "Skill path only published to level 15".
    for (const [name, path, key, ids] of SURPLUS) {
      const res = completeSkillOrder(A(path), A(ids), KIT[key as keyof typeof KIT]);
      expect(res.completed, name).toBe(true);
      expect(res.basis, name).toBe("published");
    }
  });

  it("prefers the PUBLISHED priority over the derived one when they disagree", () => {
    // Udyr's derived priority omits R entirely (derivePriority only ranks
    // basics), so a published list is the ONLY way R can ever receive a
    // derived point. Construct the disagreement explicitly: a synthetic Udyr
    // path with W already maxed.
    //
    // A published "R before W" is now literally the only thing that can place
    // this tail — but note WHY, because the reason changed. It is not that the
    // derived priority runs out (it does not; it would happily place EEE). It
    // is that gate (3c) refuses a surplus kit without a published priority, so
    // the derived answer is never reached at all. The second half of this test
    // pins that refusal.
    const wMaxed = A("QQQQQQWWWWWWEEE"); // Q6 W6 E3 R0
    expect(countRanks(wMaxed)).toEqual({ Q: 6, W: 6, E: 3, R: 0 });

    const rNext = completeSkillOrder(wMaxed, A("QWRE"), KIT.udyr);
    expect(rNext.completed).toBe(true);
    expect(rNext.basis).toBe("published");
    expect(rNext.order.slice(15).join("")).toBe("RRR");

    // Same path, no published priority: the derived list names only basics, so
    // the three points fall to E instead. Different answer, same input — which
    // is exactly why the basis is reported rather than assumed.
    // Same path, no published priority. The derived list names only basics, so
    // R cannot be chosen and the tail would silently fall to E — a DIFFERENT
    // answer from the same input. That difference is the whole argument for
    // refusing rather than reporting: the consumer cannot tell "R lost" from
    // "R was never considered", and only one of those is a recommendation.
    const eNext = completeSkillOrder(wMaxed, undefined, KIT.udyr);
    expect(eNext.completed).toBe(false);
    expect(eNext.refusedBecause).toBe("kit-not-derivable");
  });

  it("refuses a MALFORMED published priority on a surplus kit rather than half-using it", () => {
    // Malformed is treated as ABSENT, not as partial signal — the ids are
    // meant to be a ranking, and one that repeats or names a non-ability is a
    // payload we do not understand. On a surplus kit "absent" now means refuse.
    for (const bad of [[], ["Q", "Q", "W"], ["Q", "X"], ["r"]] as unknown as Ability[][]) {
      const res = completeSkillOrder(UDYR_15, bad, KIT.udyr);
      expect(res.completed, JSON.stringify(bad)).toBe(false);
      expect(res.refusedBecause, JSON.stringify(bad)).toBe("kit-not-derivable");
    }
  });

  it("a DETERMINATE kit is unaffected by the surplus gate — derived priority still completes", () => {
    // The gate is scoped to surplus kits on purpose. For the 170 champions
    // whose purchasable ranks total exactly 18, subtraction fixes the multiset
    // and the priority only ORDERS points that were forced anyway — so a
    // missing publication costs nothing and must NOT refuse. This is the
    // regression guard for the overwhelming majority of the roster.
    for (const [label, path, kit] of [
      ["standard", "WQEQQRQWQWRWWEE", STANDARD_KIT],
      ["jayce", "QWEQQWQWQWQWWEE", KIT.jayce],
      ["karma", "QEWQQRQEQEREEWW", KIT.karma],
    ] as const) {
      expect(kit.purchasableTotal, label).toBe(18);
      const res = completeSkillOrder(A(path), undefined, kit);
      expect(res.completed, label).toBe(true);
      expect(res.basis, label).toBe("derived");
      expect(res.order, label).toHaveLength(18);
    }
  });

  it("still refuses a path that breaks the champion's OWN cap", () => {
    // Seven Q on a six-Q champion is incoherent for Jayce too.
    const observed = A("QQQQQQQWWWWEEEE");
    expect(countRanks(observed).Q).toBe(7);
    const res = completeSkillOrder(observed, A("QWE"), KIT.jayce);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("rank-over-cap");
  });

  it("every completion still lands on exactly 18 levels within the kit's caps", () => {
    for (const [path, kit] of [
      ["QWEQQWQWQWQWWEE", KIT.jayce],
      ["QEWQQRQEQEREEWW", KIT.karma],
      ["WQEQQRQWQWRWWEE", STANDARD_KIT],
    ] as const) {
      const res = completeSkillOrder(A(path), A("QWE"), kit);
      expect(res.completed).toBe(true);
      expect(res.order).toHaveLength(TOTAL_LEVELS);
      const counts = countRanks(res.order);
      for (const a of ["Q", "W", "E"] as const) {
        expect(counts[a]).toBeLessThanOrEqual(kit.maxRanks[a]);
      }
      expect(counts.R).toBeLessThanOrEqual(kit.maxRanks.R - kit.freeRanks.R);
    }
  });

  it("derivePriority reads per-ability caps — Yuumi's Q maxes at 6, not 5", () => {
    // A shared basic cap of 5 would call her Q "maxed" at its 5th point
    // (level 9) rather than its 6th (level 12), ranking priority off a level
    // she has not reached. Q still wins here, but for the right reason.
    const yuumi = A("QEQEQRQEQERQEWW");
    expect(levelsByAbility(yuumi).Q).toEqual([1, 3, 5, 7, 9, 12]);
    expect(derivePriority(yuumi, KIT.yuumi)).toEqual(A("QEW"));
  });

  it("buildSkillOrderModel attaches the kit it was given, and omits it when given none", () => {
    const base = { order: A("QWEQQWQWQWQWWEE"), play: 100, win: 55, pickRate: 0.3 };
    const withKit = buildSkillOrderModel(base, KIT.jayce)!;
    expect(withKit.kit).toEqual(KIT.jayce);
    expect(withKit.completed).toBe(true);

    const withoutKit = buildSkillOrderModel(base)!;
    expect("kit" in withoutKit).toBe(false);
    // Unchanged fallback behaviour: standard caps refuse this order.
    expect(withoutKit.completed).toBe(false);
  });

  it("a NULL kit carries through and refuses to complete anything", () => {
    // "Known non-standard, could not resolve." Completing under standard caps
    // here is exactly the wrong answer, so it does not try.
    const m = buildSkillOrderModel(
      { order: A("WQEQQRQWQWRWWEE"), play: 100, win: 55, pickRate: 0.3 },
      null
    )!;
    expect(m.kit).toBeNull();
    expect(m.completed).toBe(false);
    expect(m.order).toHaveLength(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE. A derived tail is a legitimate answer; a derived tail presented
// as measured is the thing CLAUDE.md hard rule #4 forbids. These assert the
// model can always be asked which levels are the source's and which are ours.
// ─────────────────────────────────────────────────────────────────────────────
describe("provenance — observedLevels / completionBasis", () => {
  const AHRI_SRC = { order: AHRI_15, priorityIds: A("QWE"), play: 71667, win: 41408, pickRate: 0.57 };
  const UDYR_KIT = kitFromMaxRanks([6, 6, 6, 6])!;

  it("a completed model reports 15 observed levels and 3 derived ones", () => {
    const m = buildSkillOrderModel(AHRI_SRC)!;
    expect(m.order).toHaveLength(18);
    expect(m.observedLevels).toBe(15);
    expect(observedLevelCount(m)).toBe(15);
    for (const lvl of [1, 8, 15]) expect(isDerivedLevel(m, lvl), `level ${lvl}`).toBe(false);
    for (const lvl of [16, 17, 18]) expect(isDerivedLevel(m, lvl), `level ${lvl}`).toBe(true);
  });

  it("an UNCOMPLETED model claims nothing as derived — it claims nothing at all past 15", () => {
    // Kha'Zix-shaped: refused, so the order IS the source.
    const m = buildSkillOrderModel({ ...AHRI_SRC, order: A("QQQQQQWWWWWEEEE") })!;
    expect(m.completed).toBe(false);
    expect(m.observedLevels).toBe(15);
    expect(observedLevelCount(m)).toBe(15);
    // Level 16 is not derived — it is ABSENT. A UI must render neither.
    expect(isDerivedLevel(m, 16)).toBe(false);
  });

  it("reports WHICH priority decided the tail", () => {
    expect(buildSkillOrderModel(AHRI_SRC)!.completionBasis).toBe("published");
    expect(buildSkillOrderModel({ ...AHRI_SRC, priorityIds: undefined })!.completionBasis).toBe(
      "derived"
    );
    // Nothing derived → no basis. Naming a priority that decided nothing would
    // imply a derivation that never happened.
    const refused = buildSkillOrderModel({ ...AHRI_SRC, order: UDYR_15 })!;
    expect(refused.completed).toBe(false);
    expect("completionBasis" in refused).toBe(false);
  });

  it("Udyr's model carries the published basis end to end", () => {
    const m = buildSkillOrderModel(
      { order: UDYR_15, priorityIds: A("QEWR"), play: 9670, win: 5927, pickRate: 0.3 },
      UDYR_KIT
    )!;
    expect(m.completed).toBe(true);
    expect(m.completionBasis).toBe("published");
    expect(m.observedLevels).toBe(15);
    expect(m.levels.W).toEqual([3, 15, 16, 17, 18]);
    // The DISPLAY priority stays basics-only ("Q › E › W") — allocation and
    // display are deliberately different lists; see resolveAllocationPriority.
    expect(m.priority).toEqual(A("QEW"));
  });

  it("observedLevelCount reproduces the old meaning for a payload that predates the field", () => {
    // A response cached before `observedLevels` existed. Absent must not mean
    // "all 18 measured" — that is precisely the fabrication being prevented.
    const legacy = {
      order: [...AHRI_15, ...A("REE")],
      completed: true,
    } as unknown as SkillOrderModel;
    expect(observedLevelCount(legacy)).toBe(15);
    expect(isDerivedLevel(legacy, 16)).toBe(true);

    const legacyShort = { order: [...UDYR_15], completed: false } as unknown as SkillOrderModel;
    expect(observedLevelCount(legacyShort)).toBe(15);
    expect(isDerivedLevel(legacyShort, 16)).toBe(false);
  });

  it("clamps a nonsense observedLevels rather than trusting it", () => {
    const m = {
      order: [...AHRI_15],
      completed: false,
      observedLevels: 99,
    } as unknown as SkillOrderModel;
    expect(observedLevelCount(m)).toBe(15);
    expect(isDerivedLevel(m, 15)).toBe(false);
  });
});

describe("isWellFormedPriority / resolveAllocationPriority", () => {
  it("accepts the two shapes op.gg actually publishes", () => {
    expect(isWellFormedPriority(A("QWE"))).toBe(true); // every standard champion
    expect(isWellFormedPriority(A("QEWR"))).toBe(true); // Udyr
  });

  it("rejects empty, repeated, and non-ability entries", () => {
    for (const bad of [[], ["Q", "Q"], ["Q", "x"], ["QW"], null, undefined, "QWE", 3]) {
      expect(isWellFormedPriority(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("KEEPS R, unlike the display priority, and appends missing basics", () => {
    const udyrKit = kitFromMaxRanks([6, 6, 6, 6])!;
    expect(resolveAllocationPriority(A("QEWR"), UDYR_15, udyrKit)).toEqual({
      priority: A("QEWR"),
      basis: "published",
    });
    // Display priority for the same input drops R. Both are correct; they
    // answer different questions.
    expect(resolvePriority(A("QEWR"), UDYR_15, udyrKit)).toEqual(A("QEW"));

    // A partial published list still cannot leave a point unplaceable.
    expect(resolveAllocationPriority(A("R"), UDYR_15, udyrKit).priority).toEqual(A("RQEW"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE "CAN'T HAPPEN" REFUSALS. Every one below is unreachable from real roster
// data. Each is proven to FIRE against a synthetic input, so "unreachable" is
// a measured claim rather than a comment.
// ─────────────────────────────────────────────────────────────────────────────
describe("completeSkillOrder — the unreachable refusals, proven reachable", () => {
  it("kit-not-derivable fires on a kit that cannot fill 18 points", () => {
    // No real champion is this shape (the roster minimum is exactly 18), so it
    // is constructed. 5/5/5/1 with a free R = 15 purchasable ranks.
    const starved: ChampionKit = {
      maxRanks: { Q: 5, W: 5, E: 5, R: 1 },
      freeRanks: { Q: 0, W: 0, E: 0, R: 1 },
      ultimateLevels: [1],
      purchasableTotal: 15,
    };
    const res = completeSkillOrder(A("QQQQQWWWWWEEEEE"), A("QWE"), starved);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("kit-not-derivable");
    expect(res.order).toHaveLength(15);
  });

  it("priority-exhausted fires when nothing named is under its cap", () => {
    // Requires a kit with spare ranks ONLY in a slot the priority never names.
    // Real Udyr cannot reach this (Q+W+E = 18 > 15, so a basic is always
    // under cap at level 15), so the caps are shrunk to make it reachable.
    const narrow: ChampionKit = {
      maxRanks: { Q: 5, W: 5, E: 5, R: 6 },
      freeRanks: { Q: 0, W: 0, E: 0, R: 0 },
      ultimateLevels: null, // ungated, like Udyr's fourth basic
      purchasableTotal: 21,
    };
    // Q5 W5 E5 R0 — every basic maxed at level 15, spare only in R.
    const maxedBasics = A("QQQQQWWWWWEEEEE");
    // The priority must be PUBLISHED and well-formed to get past the surplus
    // gate (3c) — otherwise this input refuses as `kit-not-derivable` and
    // never reaches the allocator, which is the thing under test. "QWE" is
    // well-formed and names only abilities already at their cap, so the walk
    // starts and then runs dry: exactly `priority-exhausted`.
    const res = completeSkillOrder(maxedBasics, A("QWE"), narrow);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("priority-exhausted");
    expect(res.order).toEqual(maxedBasics);

    // ...and a PUBLISHED priority naming R resolves the very same input. This
    // is the whole feature in two assertions.
    const withR = completeSkillOrder(maxedBasics, A("QWER"), narrow);
    expect(withR.completed).toBe(true);
    expect(withR.order.slice(15).join("")).toBe("RRR");
  });

  it("ultimate-illegal-tail fires when a schedule gates a rank past level 16", () => {
    // No published schedule gates anything later than 16, which is why the
    // check never fires on real data. A synthetic one proves it is wired up
    // rather than decorative.
    const lateGate: ChampionKit = {
      maxRanks: { Q: 5, W: 5, E: 5, R: 3 },
      freeRanks: { Q: 0, W: 0, E: 0, R: 0 },
      ultimateLevels: [6, 11, 18], // third rank not legal until 18
      purchasableTotal: 18,
    };
    // Q5 W5 E3 R2 — the tail needs R at level 16, which this kit forbids.
    const res = completeSkillOrder(AHRI_15, A("QWE"), lateGate);
    expect(res.completed).toBe(false);
    expect(res.refusedBecause).toBe("ultimate-illegal-tail");
    expect(res.order).toEqual([...AHRI_15]);
  });

  it("every refusal returns observedLevels equal to the untouched input length", () => {
    const cases: Array<readonly Ability[]> = [
      A("QW"), // unexpected-length
      [...AHRI_15, ...A("REE")], // already-complete
      A("QQQQQQWWWWWEEEE"), // rank-over-cap
      A("RRRQQQQQWWWWWEE"), // ultimate-remainder
    ];
    for (const observed of cases) {
      const res = completeSkillOrder(observed);
      expect(res.completed).toBe(false);
      expect(res.observedLevels, res.refusedBecause).toBe(observed.length);
      expect(res.basis).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ROSTER-WIDE PROPERTY. The live 173-champion sweep is a one-off script
// (see HANDOFF-engy.md); this is the offline equivalent and it is STRICTER —
// it runs every rank distribution that can reach 15 levels against every kit
// shape ddragon publishes, which is a superset of what any one patch's orders
// exercise. The invariant is the one that matters: exactly 18 legal points, or
// an explicit refusal. Never a silently short or illegal order.
// ─────────────────────────────────────────────────────────────────────────────
describe("ALL KIT SHAPES × ALL 15-level distributions — 18 legal points, or refuse", () => {
  // Every R maxrank kitFromMaxRanks accepts, paired with the basic caps that
  // actually occur (ddragon 16.14.1 full-roster sweep).
  const KITS: Array<[string, ChampionKit]> = [
    ["standard 5/5/5/3", kitFromMaxRanks([5, 5, 5, 3])!],
    ["jayce 6/6/6/1", kitFromMaxRanks([6, 6, 6, 1])!],
    ["karma 5/5/5/4", kitFromMaxRanks([5, 5, 5, 4])!],
    ["udyr 6/6/6/6", kitFromMaxRanks([6, 6, 6, 6])!],
    ["yuumi 6/5/5/3", kitFromMaxRanks([6, 5, 5, 3])!],
    ["aphelios 6/6/6/3", kitFromMaxRanks([6, 6, 6, 3])!],
  ];

  const tuples: Array<[number, number, number, number]> = [];
  for (let q = 0; q <= 7; q += 1)
    for (let w = 0; w <= 7; w += 1)
      for (let e = 0; e <= 7; e += 1) {
        const r = SOURCE_LEVELS - q - w - e;
        if (r >= 0 && r <= 7) tuples.push([q, w, e, r]);
      }

  const orderFrom = ([q, w, e, r]: [number, number, number, number]): Ability[] => [
    ...Array<Ability>(q).fill("Q"),
    ...Array<Ability>(w).fill("W"),
    ...Array<Ability>(e).fill("E"),
    ...Array<Ability>(r).fill("R"),
  ];

  // Both priority sources, because the allocator's behaviour depends on which
  // one it got and a sweep over only one would miss half the paths.
  const PRIORITIES: Array<[string, Ability[] | undefined]> = [
    ["derived (none supplied)", undefined],
    ["published QWE", A("QWE")],
    ["published QEWR", A("QEWR")],
  ];

  it.each(KITS)("%s: never emits a short or illegal order", (kitName, kit) => {
    let completed = 0;
    let refused = 0;

    for (const [, priority] of PRIORITIES) {
      for (const t of tuples) {
        const observed = orderFrom(t);
        const res = completeSkillOrder(observed, priority, kit);
        const label = `${kitName} ${t.join("/")}`;

        if (!res.completed) {
          refused += 1;
          // A refusal returns the input untouched and says why.
          expect(res.order, label).toEqual(observed);
          expect(res.refusedBecause, label).toBeTruthy();
          expect(res.observedLevels, label).toBe(observed.length);
          continue;
        }

        completed += 1;
        // ── The invariant, in full. ──
        expect(res.order, label).toHaveLength(TOTAL_LEVELS);
        expect(res.observedLevels, label).toBe(SOURCE_LEVELS);
        expect(res.order.slice(0, SOURCE_LEVELS), label).toEqual(observed);
        expect(res.basis, label).toBeTruthy();

        const c = countRanks(res.order);
        // 18 points spent, none of them over a cap this champion has.
        expect(c.Q + c.W + c.E + c.R, label).toBe(TOTAL_LEVELS);
        for (const a of ["Q", "W", "E"] as const) {
          expect(c[a], `${label} ${a}`).toBeLessThanOrEqual(kit.maxRanks[a]);
        }
        expect(c.R, `${label} R`).toBeLessThanOrEqual(kit.maxRanks.R - kit.freeRanks.R);

        // Every R rank in the DERIVED tail lands at a level the game allows.
        if (kit.ultimateLevels !== null) {
          levelsByAbility(res.order).R.forEach((lvl, i) => {
            const gameRank = i + 1 + kit.freeRanks.R;
            if (lvl <= SOURCE_LEVELS) return; // source's own aggregate, not ours
            expect(kit.ultimateLevels![gameRank - 1], `${label} R@${lvl}`).toBeLessThanOrEqual(lvl);
          });
        }
      }
    }

    expect(completed, `${kitName} completed`).toBeGreaterThan(0);
    expect(refused, `${kitName} refused`).toBeGreaterThan(0);
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
