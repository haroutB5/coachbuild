// ─────────────────────────────────────────────────────────────────────────────
// championKit.test.ts — the per-champion rank RULES.
//
// PROVENANCE OF EVERY FIXTURE HERE. The maxrank tuples below are not invented
// and not remembered: they were read off Data Dragon 16.14.1's
// `championFull.json` in a full-roster sweep on 2026-07-27, together with the
// individual `champion/<Key>.json` files for each of the seven non-standard
// champions (both sources agreed exactly). The sweep found 173 champions, all
// with exactly 4 spells, and exactly seven off the 5/5/5/3 model.
//
// What this file proves is the INTERPRETATION of those integers — the mapping
// from an R maxrank to "when is this rank legal" and "does it cost a point".
// That mapping is an inference, and lib/championKit.ts's header sets out the
// evidence for it; the 18-point identity test below is that evidence executed
// rather than asserted in prose.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  kitFromMaxRanks,
  isUltimateRankLegal,
  purchasedRanks,
  purchasableUltimateRanks,
  tailUltimateRanks,
  STANDARD_KIT,
  MEASURED_CHAMPION_KITS,
  KNOWN_NON_STANDARD_CHAMPION_IDS,
  kitForChampionIdentity,
  isMeasuredChampionIdentity,
  TOTAL_LEVELS,
} from "@/lib/championKit";
import { parseChampionKit } from "@/lib/staticData";

/** ddragon 16.14.1, verbatim. [Q,W,E,R] maxranks, plus the Riot numeric id. */
const REAL: Record<string, { id: number; maxranks: [number, number, number, number] }> = {
  Ahri: { id: 103, maxranks: [5, 5, 5, 3] },
  Aphelios: { id: 523, maxranks: [6, 6, 6, 3] },
  Elise: { id: 60, maxranks: [5, 5, 5, 4] },
  Jayce: { id: 126, maxranks: [6, 6, 6, 1] },
  Karma: { id: 43, maxranks: [5, 5, 5, 4] },
  Nidalee: { id: 76, maxranks: [5, 5, 5, 4] },
  Udyr: { id: 77, maxranks: [6, 6, 6, 6] },
  Yuumi: { id: 350, maxranks: [6, 5, 5, 3] },
};

const kitOf = (name: keyof typeof REAL) => kitFromMaxRanks(REAL[name].maxranks)!;

describe("kitFromMaxRanks — the four R shapes that exist on the live roster", () => {
  it("maxrank 3 is a true ultimate: 6/11/16, nothing free", () => {
    const k = kitOf("Ahri");
    expect(k.maxRanks).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
    expect(k.ultimateLevels).toEqual([6, 11, 16]);
    expect(k.freeRanks).toEqual({ Q: 0, W: 0, E: 0, R: 0 });
    expect(k.purchasableTotal).toBe(18);
  });

  it("maxrank 4 is a LEVEL-1 ultimate: 1/6/11/16, first rank free", () => {
    for (const name of ["Karma", "Elise", "Nidalee"] as const) {
      const k = kitOf(name);
      expect(k.maxRanks.R, name).toBe(4);
      expect(k.ultimateLevels, name).toEqual([1, 6, 11, 16]);
      expect(k.freeRanks.R, name).toBe(1);
      // One free + three bought = the same three purchased ultimate ranks a
      // standard champion has, which is why these three behave normally.
      expect(purchasableUltimateRanks(k), name).toBe(3);
      expect(k.purchasableTotal, name).toBe(18);
    }
  });

  it("maxrank 1 is a single-rank transform: level 1, free, never bought", () => {
    const k = kitOf("Jayce");
    expect(k.maxRanks).toEqual({ Q: 6, W: 6, E: 6, R: 1 });
    expect(k.ultimateLevels).toEqual([1]);
    expect(k.freeRanks.R).toBe(1);
    expect(purchasableUltimateRanks(k)).toBe(0);
    // His basics alone consume every point — the reductio that proves the
    // Transform cannot cost one.
    expect(k.purchasableTotal).toBe(18);
    expect(k.maxRanks.Q + k.maxRanks.W + k.maxRanks.E).toBe(18);
  });

  it("maxrank 6 is not an ultimate at all — a fourth basic, never level-gated", () => {
    const k = kitOf("Udyr");
    expect(k.maxRanks).toEqual({ Q: 6, W: 6, E: 6, R: 6 });
    expect(k.ultimateLevels).toBeNull();
    expect(k.freeRanks.R).toBe(0);
    // 24 purchasable ranks against 18 points: he MUST skip six.
    expect(k.purchasableTotal).toBe(24);
  });

  it("Aphelios and Yuumi keep a true ultimate but overflow the point budget", () => {
    expect(kitOf("Aphelios").ultimateLevels).toEqual([6, 11, 16]);
    expect(kitOf("Aphelios").purchasableTotal).toBe(21);
    expect(kitOf("Yuumi").maxRanks).toEqual({ Q: 6, W: 5, E: 5, R: 3 });
    expect(kitOf("Yuumi").purchasableTotal).toBe(19);
  });

  it("marks automatic-R identities without confusing them with standard R3", () => {
    expect(kitFromMaxRanks([6, 6, 6, 3], "Aphelios")?.rAuto).toBe(true);
    expect(kitFromMaxRanks([6, 6, 6, 3], "Ahri")?.rAuto).toBe(false);
    expect(kitFromMaxRanks([6, 6, 6, 1], "Jayce")?.rAuto).toBe(true);
  });
});

describe("the 18-point identity — the evidence the free-rank rule rests on", () => {
  // A champion has exactly one ability point per level. So a champion who can
  // spend every point without waste must have exactly 18 purchasable ranks.
  // This is the test that distinguishes the free-rank interpretation from the
  // naive one; see lib/championKit.ts's header.
  it("holds for every champion EXCEPT the three who genuinely must skip points", () => {
    const overflow: string[] = [];
    for (const [name, { maxranks }] of Object.entries(REAL)) {
      const k = kitFromMaxRanks(maxranks)!;
      if (k.purchasableTotal !== TOTAL_LEVELS) overflow.push(name);
    }
    expect(overflow.sort()).toEqual(["Aphelios", "Udyr", "Yuumi"]);
  });

  it("would FAIL for four champions if free ranks were counted as purchased", () => {
    // The counterfactual, executed. Reading every rank as costing a point
    // makes Jayce/Karma/Elise/Nidalee total 19 — and Jayce, whose basics alone
    // are 18, literally unplayable. This is why the rule exists.
    const naive = (m: readonly number[]) => m.reduce((a, b) => a + b, 0);
    for (const name of ["Jayce", "Karma", "Elise", "Nidalee"] as const) {
      expect(naive(REAL[name].maxranks), name).toBe(19);
      expect(kitOf(name).purchasableTotal, name).toBe(18);
    }
  });
});

describe("kitFromMaxRanks — refuses rather than guessing", () => {
  it("returns null for an R shape with no verified semantics", () => {
    // 2 and 5 do not occur on the live roster. If Riot ever ships one we must
    // find out by the feature going quiet, not by advising off a guess.
    for (const r of [0, 2, 5, 7, 99]) {
      expect(kitFromMaxRanks([5, 5, 5, r]), `R=${r}`).toBeNull();
    }
  });

  it("returns null for a ragged, short, or non-integer spells array", () => {
    expect(kitFromMaxRanks([5, 5, 5])).toBeNull();
    expect(kitFromMaxRanks([5, 5, 5, 3, 3])).toBeNull();
    expect(kitFromMaxRanks([])).toBeNull();
    expect(kitFromMaxRanks([5, 5, 5, NaN])).toBeNull();
    expect(kitFromMaxRanks([5, 5, 1.5, 3])).toBeNull();
    expect(kitFromMaxRanks([5, 5, 0, 3])).toBeNull();
    expect(kitFromMaxRanks([-1, 5, 5, 3])).toBeNull();
    expect(kitFromMaxRanks(null as unknown as number[])).toBeNull();
  });

  it("STANDARD_KIT is exactly the old hardcoded model", () => {
    expect(STANDARD_KIT.maxRanks).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
    expect(STANDARD_KIT.ultimateLevels).toEqual([6, 11, 16]);
    expect(STANDARD_KIT.freeRanks).toEqual({ Q: 0, W: 0, E: 0, R: 0 });
  });
});

describe("isUltimateRankLegal — the rule stated in nextSkill.ts, executed", () => {
  it("gates a true ultimate at 6/11/16", () => {
    const k = kitOf("Ahri");
    expect(isUltimateRankLegal(1, 5, k)).toBe(false);
    expect(isUltimateRankLegal(1, 6, k)).toBe(true);
    expect(isUltimateRankLegal(2, 10, k)).toBe(false);
    expect(isUltimateRankLegal(2, 11, k)).toBe(true);
    expect(isUltimateRankLegal(3, 15, k)).toBe(false);
    expect(isUltimateRankLegal(3, 16, k)).toBe(true);
    // Out of range must be REFUSED, not silently approved by an undefined read.
    expect(isUltimateRankLegal(4, 18, k)).toBe(false);
    expect(isUltimateRankLegal(0, 18, k)).toBe(false);
  });

  it("allows a level-1 ultimate's first rank at level 1, then the usual cadence", () => {
    const k = kitOf("Karma");
    expect(isUltimateRankLegal(1, 1, k)).toBe(true);
    expect(isUltimateRankLegal(2, 5, k)).toBe(false);
    expect(isUltimateRankLegal(2, 6, k)).toBe(true);
    expect(isUltimateRankLegal(4, 15, k)).toBe(false);
    expect(isUltimateRankLegal(4, 16, k)).toBe(true);
    expect(isUltimateRankLegal(5, 18, k)).toBe(false);
  });

  it("allows Jayce's transform at level 1 and nothing beyond rank 1", () => {
    const k = kitOf("Jayce");
    expect(isUltimateRankLegal(1, 1, k)).toBe(true);
    expect(isUltimateRankLegal(2, 18, k)).toBe(false);
  });

  it("never gates an ungated slot — Udyr's R is legal from level 1", () => {
    const k = kitOf("Udyr");
    for (let level = 1; level <= 18; level += 1) {
      for (let rank = 1; rank <= 6; rank += 1) {
        expect(isUltimateRankLegal(rank, level, k)).toBe(true);
      }
    }
  });
});

describe("purchasedRanks / tailUltimateRanks", () => {
  it("excludes a granted rank from the spend, and never goes negative", () => {
    const karma = kitOf("Karma");
    expect(purchasedRanks(1, "R", karma)).toBe(0); // the free level-1 Mantra
    expect(purchasedRanks(4, "R", karma)).toBe(3);
    expect(purchasedRanks(0, "R", karma)).toBe(0); // impossible live; still safe
    expect(purchasedRanks(5, "Q", karma)).toBe(5); // basics are never free
  });

  it("leaves room for exactly one ultimate rank in a gated tail, zero for Jayce", () => {
    expect(tailUltimateRanks(kitOf("Ahri"), 15)).toBe(1);
    expect(tailUltimateRanks(kitOf("Karma"), 15)).toBe(1);
    expect(tailUltimateRanks(kitOf("Jayce"), 15)).toBe(0);
    expect(tailUltimateRanks(kitOf("Udyr"), 15)).toBe(0);
  });
});

describe("KNOWN_NON_STANDARD_CHAMPION_IDS — identity list for the degraded path", () => {
  it("contains exactly the seven measured non-standard champions, by Riot id", () => {
    const expected = Object.entries(REAL)
      .filter(([, v]) => v.maxranks.join() !== "5,5,5,3")
      .map(([, v]) => v.id)
      .sort((a, b) => a - b);
    // Array.from rather than spread: tsconfig targets below es2015, where
    // spreading a Set needs --downlevelIteration.
    expect(Array.from(KNOWN_NON_STANDARD_CHAMPION_IDS).sort((a, b) => a - b)).toEqual(expected);
  });

  it("does not contain a standard champion (a false entry would blank Ahri)", () => {
    expect(KNOWN_NON_STANDARD_CHAMPION_IDS.has(REAL.Ahri.id)).toBe(false);
  });
});

describe("MEASURED_CHAMPION_KITS — the single identity/cap table", () => {
  it("contains the seven exceptional kits plus measured standard Viego", () => {
    expect(MEASURED_CHAMPION_KITS.size).toBe(8);
    expect(MEASURED_CHAMPION_KITS.get(234)?.maxRanks).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
    expect(MEASURED_CHAMPION_KITS.get(77)?.maxRanks).toEqual({ Q: 6, W: 6, E: 6, R: 6 });
  });

  it("distinguishes a measured standard identity from the compatibility fallback", () => {
    expect(kitForChampionIdentity(234, "Viego")).toBe(MEASURED_CHAMPION_KITS.get(234));
    expect(isMeasuredChampionIdentity(234, "Viego")).toBe(true);
    expect(kitForChampionIdentity(112, "Viktor")).toBe(STANDARD_KIT);
    expect(isMeasuredChampionIdentity(112, "Viktor")).toBe(false);
  });
});

describe("parseChampionKit — the ddragon payload boundary", () => {
  // Shaped exactly like ddragon's champion/<Key>.json, trimmed to the fields
  // this parser reads. Field path confirmed live: data.<Key>.spells[i].maxrank.
  const payload = (key: string, maxranks: number[]) => ({
    type: "champion",
    format: "standAloneComplex",
    version: "16.14.1",
    data: {
      [key]: {
        id: key,
        key: "126",
        name: key,
        spells: maxranks.map((maxrank, i) => ({ id: `${key}Spell${i}`, maxrank })),
      },
    },
  });

  it("reads the real Jayce shape", () => {
    const kit = parseChampionKit(payload("Jayce", [6, 6, 6, 1]), "Jayce");
    expect(kit?.maxRanks).toEqual({ Q: 6, W: 6, E: 6, R: 1 });
    expect(kit?.purchasableTotal).toBe(18);
  });

  it("returns null for every shape it does not recognise", () => {
    expect(parseChampionKit(payload("Jayce", [6, 6, 6, 1]), "Ahri")).toBeNull(); // wrong key
    expect(parseChampionKit({ data: { Ahri: {} } }, "Ahri")).toBeNull(); // no spells
    expect(parseChampionKit({ data: { Ahri: { spells: [] } } }, "Ahri")).toBeNull();
    expect(parseChampionKit({ data: { Ahri: { spells: {} } } }, "Ahri")).toBeNull();
    // A spells array of the wrong LENGTH. No live counterexample exists (all
    // 173 champions carry exactly 4), so this pins the contract boundary
    // against a CDN reshape rather than a known case.
    expect(parseChampionKit(payload("Ahri", [5, 5, 5]), "Ahri")).toBeNull();
    expect(parseChampionKit(payload("Ahri", [5, 5, 5, 3, 2]), "Ahri")).toBeNull();
    // maxrank missing or not a number.
    expect(parseChampionKit({ data: { Ahri: { spells: [{}, {}, {}, {}] } } }, "Ahri")).toBeNull();
    expect(
      parseChampionKit({ data: { Ahri: { spells: [{ maxrank: "5" }, {}, {}, {}] } } }, "Ahri")
    ).toBeNull();
    for (const bad of [null, undefined, 0, "", [], { data: null }, { data: 1 }]) {
      expect(parseChampionKit(bad, "Ahri")).toBeNull();
    }
  });
});
