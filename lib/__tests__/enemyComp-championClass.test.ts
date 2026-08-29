import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  deriveChampionClassBaseline,
  CLASS_TAG_PRIORITY,
} from "@/scripts/derive-enemycomp-tables.mjs";
import {
  CHAMPION_CLASS,
  CHAMPION_CLASS_CORRECTIONS,
  ROLE_OVERRIDE_IDS,
  getRoleOverride,
  resolveChampionItemClass,
  type ChampionItemClass,
} from "@/lib/enemyComp/championClass";
import type { LaneId } from "@/components/hextech/heroContracts";

const CATALOGUE = JSON.parse(
  readFileSync("fixtures/enemycomp/catalogue-champions-16.17.1.json", "utf8")
);
const ROSTER: number[] = Object.values(CATALOGUE.data as Record<string, { key: string }>).map((e) =>
  parseInt(e.key, 10)
);
const LANES: LaneId[] = ["top", "jungle", "mid", "bot", "support"];

describe("championClass.ts is the derivation, corrected", () => {
  const baseline = deriveChampionClassBaseline(CATALOGUE) as Record<number, ChampionItemClass>;

  it("has a row for every live champion id, and no extras", () => {
    expect(ROSTER.filter((id) => !(id in CHAMPION_CLASS))).toEqual([]);
    const live = new Set(ROSTER);
    expect(Object.keys(CHAMPION_CLASS).map(Number).filter((id) => !live.has(id))).toEqual([]);
  });

  it("EVERY correction genuinely disagrees with the derived baseline", () => {
    // THE POINT OF THIS TEST. A correction that upstream has since caught up
    // with is dead weight carrying an authority it no longer has, and it is
    // invisible: the value is right either way. This is what makes it visible.
    const redundant = CHAMPION_CLASS_CORRECTIONS.filter((id) => CHAMPION_CLASS[id] === baseline[id]);
    expect(redundant).toEqual([]);
  });

  it("every row that DISAGREES with the baseline is listed as a correction", () => {
    // The other direction, and the one that catches a quiet hand-edit: a row
    // changed in the table without being added to the corrections list would
    // pass the test above forever.
    const listed = new Set(CHAMPION_CLASS_CORRECTIONS);
    const unlisted = ROSTER.filter((id) => CHAMPION_CLASS[id] !== baseline[id] && !listed.has(id));
    expect(unlisted).toEqual([]);
  });

  it("the correction RATE is the finding, and it is large", () => {
    // Documented in the file header as 57 of 173. If a future roster changes
    // this, the header is now wrong and should be updated rather than this
    // number being loosened.
    expect(CHAMPION_CLASS_CORRECTIONS.length).toBe(57);
    expect(ROSTER.length).toBe(173);
  });

  it("resolves the tag priority deterministically for a dual-tagged champion", () => {
    // Ahri is Mage/Assassin; the priority puts Assassin first, so the baseline
    // says assassin and the curated table agrees. Pinned so a reordering of
    // CLASS_TAG_PRIORITY cannot silently rewrite half the baseline.
    expect(CLASS_TAG_PRIORITY.map((p) => p[0])).toEqual([
      "Marksman",
      "Assassin",
      "Tank",
      "Mage",
      "Fighter",
      "Support",
    ]);
    expect(baseline[103]).toBe("assassin");
  });
});

describe("championClass.ts names ITEMS, not playstyle", () => {
  it.each([
    [11, "Master Yi", "marksman"],
    [23, "Tryndamere", "marksman"],
    [157, "Yasuo", "marksman"],
    [777, "Yone", "marksman"],
  ])("%i %s buys crit, so the class is %s", (id, _n, want) => {
    expect(CHAMPION_CLASS[id]).toBe(want);
  });

  it.each([
    [6, "Urgot", "fighter-bruiser"],
    [19, "Warwick", "fighter-bruiser"],
    [2, "Olaf", "fighter-bruiser"],
    [5, "Xin Zhao", "fighter-bruiser"],
  ])("%i %s reads Fighter/Tank upstream but builds bruiser items (%s)", (id, _n, want) => {
    expect(CHAMPION_CLASS[id]).toBe(want);
  });

  it.each([
    [79, "Gragas", "mage"],
    [82, "Mordekaiser", "mage"],
    [887, "Gwen", "mage"],
  ])("%i %s is tagged Fighter but buys AP (%s)", (id, _n, want) => {
    expect(CHAMPION_CLASS[id]).toBe(want);
  });
});

describe("championClass.ts role overrides", () => {
  it("has exactly three, and every one genuinely changes the class", () => {
    expect([...ROLE_OVERRIDE_IDS].sort((a, b) => a - b)).toEqual([43, 147, 235]);
    for (const id of ROLE_OVERRIDE_IDS) {
      for (const lane of LANES) {
        const override = getRoleOverride(id, lane);
        if (override === undefined) continue;
        expect(override, `champion ${id} lane ${lane} override is redundant`).not.toBe(
          CHAMPION_CLASS[id]
        );
      }
    }
  });

  it("Senna is a marksman bot and an enchanter support", () => {
    expect(resolveChampionItemClass(235, "bot")).toBe("marksman");
    expect(resolveChampionItemClass(235, "support")).toBe("enchanter-support");
  });

  it("Lux support is a MAGE -- the absence of a row is the claim", () => {
    // The one case most likely to be "fixed" by a future reader. Lux buys mage
    // items in the support role; classing her as an enchanter would offer her
    // Mikael's Blessing against heavy CC instead of Mercury's Treads.
    expect(getRoleOverride(99, "support")).toBeUndefined();
    expect(resolveChampionItemClass(99, "support")).toBe("mage");
    expect(resolveChampionItemClass(99, "mid")).toBe("mage");
  });

  it("Seraphine and Karma leave the enchanter column in a solo lane", () => {
    expect(resolveChampionItemClass(147, "support")).toBe("enchanter-support");
    expect(resolveChampionItemClass(147, "mid")).toBe("mage");
    expect(resolveChampionItemClass(43, "support")).toBe("enchanter-support");
    expect(resolveChampionItemClass(43, "mid")).toBe("mage");
    expect(resolveChampionItemClass(43, "top")).toBe("mage");
  });
});

describe("championClass.ts fails closed", () => {
  it("returns null for an unknown id rather than guessing a class", () => {
    expect(resolveChampionItemClass(999999, "mid")).toBeNull();
  });

  it("resolves every live champion in every lane to a real class", () => {
    const classes = new Set<ChampionItemClass>([
      "mage",
      "assassin",
      "marksman",
      "fighter-bruiser",
      "tank",
      "enchanter-support",
    ]);
    for (const id of ROSTER) {
      for (const lane of LANES) {
        const cls = resolveChampionItemClass(id, lane);
        expect(cls, `champion ${id} lane ${lane}`).not.toBeNull();
        expect(classes.has(cls!)).toBe(true);
      }
    }
  });
});
