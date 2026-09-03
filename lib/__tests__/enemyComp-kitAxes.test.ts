import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAMPION_KIT_AXES,
  AXIS_COUNT_FLOOR,
  getKitAxes,
  countAtOrAbove,
  type KitAxes,
} from "@/lib/enemyComp/kitAxes";
import { COMP_RATINGS } from "@/lib/draft/compRatings";

/** The same captured roster the counter-item derivation is pinned against.
 *  Using the CATALOGUE rather than COMP_RATINGS' own key set is deliberate:
 *  two curated tables agreeing with each other proves only that they were
 *  written on the same day. The catalogue is the upstream fact. */
const ROSTER: number[] = Object.values(
  JSON.parse(readFileSync("fixtures/enemycomp/catalogue-champions-16.17.1.json", "utf8")).data as Record<
    string,
    { key: string }
  >
).map((e) => parseInt(e.key, 10));

const AXES: (keyof KitAxes)[] = ["assassin", "heal", "shield"];

describe("kitAxes.ts covers the roster", () => {
  it("has a row for every live champion id", () => {
    const missing = ROSTER.filter((id) => !(id in CHAMPION_KIT_AXES));
    expect(missing).toEqual([]);
  });

  it("has no row for an id that is not on the roster", () => {
    const live = new Set(ROSTER);
    expect(Object.keys(CHAMPION_KIT_AXES).map(Number).filter((id) => !live.has(id))).toEqual([]);
  });

  it("keeps every value inside the published 0-3 rubric", () => {
    for (const [id, row] of Object.entries(CHAMPION_KIT_AXES)) {
      for (const axis of AXES) {
        expect(
          row[axis] >= 0 && row[axis] <= 3 && Number.isInteger(row[axis]),
          `champion ${id} axis ${axis} = ${row[axis]}`
        ).toBe(true);
      }
    }
  });

  it("agrees with compRatings.ts on which champions exist", () => {
    // Not a redundancy check on the VALUES -- the two files carry different
    // axes. This asserts the two curated rosters cannot drift apart, because
    // scenarios.ts reads cc/tankiness from one and assassin/heal/shield from
    // the other for the SAME enemy id on the same tick.
    const ratings = new Set(Object.keys(COMP_RATINGS).map(Number));
    const axes = new Set(Object.keys(CHAMPION_KIT_AXES).map(Number));
    expect([...axes].filter((id) => !ratings.has(id))).toEqual([]);
    expect([...ratings].filter((id) => !axes.has(id))).toEqual([]);
  });
});

describe("kitAxes.ts deliberate rows", () => {
  // These are hand-picked because they are the rows a careless edit breaks
  // FIRST, and because each one is the reason a scenario exists at all.
  it.each([
    [16, "Soraka", 3],
    [350, "Yuumi", 3],
    [266, "Aatrox", 3],
    [8, "Vladimir", 3],
    [36, "Dr. Mundo", 3],
    [19, "Warwick", 3],
    [50, "Swain", 3],
  ])("heal: %i %s is defining (%i)", (id, _name, want) => {
    expect(getKitAxes(id).heal).toBe(want);
  });

  it.each([
    [43, "Karma", 3],
    [117, "Lulu", 3],
    [40, "Janna", 3],
    [25, "Morgana", 3],
    [888, "Renata Glasc", 3],
  ])("shield: %i %s is defining (%i)", (id, _name, want) => {
    expect(getKitAxes(id).shield).toBe(want);
  });

  it.each([
    [238, "Zed", 3],
    [121, "Kha'Zix", 3],
    [55, "Katarina", 3],
    [107, "Rengar", 3],
    [91, "Talon", 3],
  ])("assassin: %i %s is defining (%i)", (id, _name, want) => {
    expect(getKitAxes(id).assassin).toBe(want);
  });

  it("separates Zeri and Camille from real assassins, which no existing axis does", () => {
    // The reason this table exists. compRatings gives BOTH of them mobility 3
    // and damage 3, which is the obvious derived proxy for "assassin", so a
    // derived version of this axis would count them toward the assassins
    // scenario and put Zhonya's Hourglass in a build over a Zeri.
    expect(COMP_RATINGS[221].mobility).toBe(3);
    expect(COMP_RATINGS[221].damage).toBe(3);
    expect(COMP_RATINGS[164].mobility).toBe(3);
    expect(COMP_RATINGS[164].damage).toBe(3);
    expect(getKitAxes(221).assassin).toBeLessThan(AXIS_COUNT_FLOOR); // Zeri
    expect(getKitAxes(164).assassin).toBeGreaterThanOrEqual(AXIS_COUNT_FLOOR); // Camille genuinely dives
    expect(getKitAxes(238).assassin).toBeGreaterThanOrEqual(AXIS_COUNT_FLOOR); // Zed, the control
  });

  it("does not credit item-sourced sustain to a kit", () => {
    // Every marksman heals a lot with a Bloodthirster. That is an item choice,
    // invisible in champ select, and reading it off a champion id would be a
    // claim about a purchase this app has explicitly promised never to model.
    for (const id of [222, 51, 119, 429, 202]) expect(getKitAxes(id).heal).toBe(0);
    // 2026-09-03 second read, user-confirmed per row: Irelia's BORK healing,
    // Illaoi's diver sustain, Tahm's devour saves and Gwen's kit are all the
    // same non-kit sustain — none of them counts toward the healers scenario.
    for (const id of [39, 420, 223, 887]) expect(getKitAxes(id).heal).toBe(0);
  });

  it("Ivern counts shield-plus-support-item sustain as heal by user directive", () => {
    // Deliberate exception to the rule above, kept because the owner asked
    // for it on 2026-09-03 (Ivern E-shield + Redemption-style support items).
    // Do not "fix" this to 0 without re-asking: the row comment says the same.
    expect(getKitAxes(427).heal).toBe(2);
    expect(getKitAxes(427).shield).toBe(2);
  });

  it("2026-09-03 second read: Lillia is sustained burn, Rell has no shield", () => {
    expect(getKitAxes(876).assassin).toBe(1);
    expect(getKitAxes(526).shield).toBe(0);
  });
});

describe("kitAxes.ts helpers fail closed", () => {
  it("returns all-zero for an unknown id and never throws", () => {
    expect(getKitAxes(999999)).toEqual({ assassin: 0, heal: 0, shield: 0 });
    expect(getKitAxes(-1)).toEqual({ assassin: 0, heal: 0, shield: 0 });
  });

  it("an unknown enemy counts toward no scenario", () => {
    expect(countAtOrAbove([999999, 999998], "heal")).toBe(0);
  });

  it("counts at the shared floor, identically on every axis", () => {
    // Soraka + Aatrox are heal 3; Zed is heal 0.
    expect(countAtOrAbove([16, 266, 238], "heal")).toBe(2);
    // Zed + Kha'Zix are assassin 3; Soraka is 0.
    expect(countAtOrAbove([238, 121, 16], "assassin")).toBe(2);
    expect(AXIS_COUNT_FLOOR).toBe(2);
  });

  it("the frozen zero row cannot be mutated by a caller", () => {
    const row = getKitAxes(999999);
    expect(() => {
      (row as KitAxes).heal = 3;
    }).toThrow();
    expect(getKitAxes(999998).heal).toBe(0);
  });
});
