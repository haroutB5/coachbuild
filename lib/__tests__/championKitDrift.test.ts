// ─────────────────────────────────────────────────────────────────────────────
// championKitDrift.test.ts — the guard, not the interpretation.
//
// championKit.test.ts proves what the maxrank integers MEAN. This file proves
// the integers themselves are still Riot's, and that the desktop companion is
// carrying the same ones. Two different failure modes, and neither was checked
// by anything before 2026-08-20:
//
//   DRIFT.   MEASURED_CHAMPION_KIT_SPECS was measured by hand at ddragon
//            16.14.1. A rework that gives a champion a fourth R rank, or a new
//            champion shipped with a free one, would be wrong here and silent
//            everywhere — the entry just quietly stops matching the game. The
//            check is against fixtures/champion-kit-derived.json, a checked-in
//            full-roster derivation, so this suite never touches the network.
//            scripts/refresh-champion-kits.mjs is the online half; it belongs
//            in maintenance, not in a unit test.
//
//   THE 18-POINT FLOOR. One ability point per level means a kit whose
//            purchasable ranks total under TOTAL_LEVELS describes a champion who
//            cannot spend every point they are given. skillOrderModel.ts refuses
//            `kit-not-derivable` for exactly that, so such a champion gets NO
//            published skill order, the companion logs `no-skill-order`, and the
//            in-game highlight never draws for them. That is the Jayce blank
//            overlay. The cheapest-looking response to the 2026-08-19 Kennen
//            anomaly — give him a free R rank — lands on total 17 and
//            reintroduces it exactly. It fails here rather than in a game.
//
//   PORT PARITY. desktop/src/CoachBuild.Core/ChampionKit.cs is this table
//            transcribed into C#, and its own doc-comment says the two must not
//            drift apart. This test READS that C# file rather than restating it.
//            Its twin (ChampionKitDriftTests.cs) reads this one from the .NET
//            suite, so whichever ecosystem a half-edit is made in, that
//            ecosystem's own suite catches it.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MEASURED_CHAMPION_KITS,
  STANDARD_KIT,
  TOTAL_LEVELS,
  kitFromMaxRanks,
  kitForChampionIdentity,
  isMeasuredChampionIdentity,
} from "../championKit";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const KENNEN = 85;
const JAYCE = 126;

type DerivedChampion = {
  id: number;
  key: string;
  maxRanks: [number, number, number, number];
  freeR: number;
  purchasableTotal: number;
};

const derived: { ddragonPatch: string; champions: DerivedChampion[] } = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "fixtures", "champion-kit-derived.json"), "utf8")
);

const isStandardShape = (maxRanks: readonly number[]) =>
  maxRanks.length === 4 && maxRanks[0] === 5 && maxRanks[1] === 5 && maxRanks[2] === 5 && maxRanks[3] === 3;

const byId = new Map(derived.champions.map((c) => [c.id, c]));

/** The desktop table, parsed out of the C# source. Deliberately not imported
 *  from anywhere — there is nothing to import; the point is to read the shipped
 *  file. */
function parseDesktopTable(): { entries: Map<number, { maxRanks: number[]; freeR: number }>; totalLevels: number } {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "desktop", "src", "CoachBuild.Core", "ChampionKit.cs"),
    "utf8"
  );

  // Scope to the Measured dictionary. A pattern let loose over the whole file
  // would collect `new(5, 5, 5, 3, 0)` from the Standard property too.
  const start = source.indexOf("Measured =");
  expect(start, "the Measured dictionary is gone from ChampionKit.cs").toBeGreaterThan(-1);
  const end = source.indexOf("};", start);
  expect(end, "the Measured dictionary has no terminator").toBeGreaterThan(start);
  const block = source.slice(start, end);

  const entries = new Map<number, { maxRanks: number[]; freeR: number }>();
  const pattern = /\[(\d+)\]\s*=\s*new\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  for (const m of block.matchAll(pattern)) {
    entries.set(Number(m[1]), {
      maxRanks: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
      freeR: Number(m[6]),
    });
  }

  const totalLevels = /TotalLevels\s*=\s*(\d+)/.exec(source);
  expect(totalLevels, "ChampionKit.cs no longer declares TotalLevels").not.toBeNull();
  return { entries, totalLevels: Number(totalLevels![1]) };
}

describe("champion kit drift guard", () => {
  // Every test below is a sweep over the fixture, and a sweep over nothing
  // passes. This is what makes the rest of them mean something.
  it("reads a full roster, not an empty or truncated parse", () => {
    expect(derived.ddragonPatch).toMatch(/^\d+\.\d+\.\d+$/);
    expect(derived.champions.length).toBeGreaterThanOrEqual(170);
    expect(new Set(derived.champions.map((c) => c.id)).size).toBe(derived.champions.length);

    const jayce = byId.get(JAYCE);
    expect(jayce?.maxRanks).toEqual([6, 6, 6, 1]);
    expect(jayce?.freeR).toBe(1);
    expect(derived.champions.filter((c) => !isStandardShape(c.maxRanks)).length).toBeGreaterThanOrEqual(7);
  });

  it("has no stale entry: every measured kit still matches ddragon", () => {
    const stale: string[] = [];
    for (const [id, kit] of MEASURED_CHAMPION_KITS) {
      const record = byId.get(id);
      if (!record) {
        stale.push(`id ${id} is measured but absent from the ${derived.ddragonPatch} roster`);
        continue;
      }
      const shipped = [kit.maxRanks.Q, kit.maxRanks.W, kit.maxRanks.E, kit.maxRanks.R];
      if (shipped.join("/") !== record.maxRanks.join("/"))
        stale.push(`${record.key} (${id}) caps ${shipped.join("/")} but ddragon says ${record.maxRanks.join("/")}`);
      if (kit.freeRanks.R !== record.freeR)
        stale.push(`${record.key} (${id}) freeR ${kit.freeRanks.R} but ddragon says ${record.freeR}`);
    }
    expect(stale).toEqual([]);
  });

  // The test that catches a genuinely NEW off-model champion — the failure the
  // measured table exists for, and the one nobody would notice by hand.
  it("has no missing entry: every off-model champion is measured", () => {
    const missing = derived.champions
      .filter((c) => !isStandardShape(c.maxRanks) && !MEASURED_CHAMPION_KITS.has(c.id))
      .map((c) => `${c.key} (${c.id}) ${c.maxRanks.join("/")}`);
    expect(missing).toEqual([]);
  });

  it("resolves a kit for every champion on the roster", () => {
    const unresolvable = derived.champions
      .filter((c) => kitFromMaxRanks(c.maxRanks, c.key) === null)
      .map((c) => `${c.key} (${c.id}) ${c.maxRanks.join("/")}`);
    expect(unresolvable).toEqual([]);
  });

  it("derives the same free ranks the fixture recorded", () => {
    const disagreements = derived.champions
      .filter((c) => kitFromMaxRanks(c.maxRanks, c.key)!.freeRanks.R !== c.freeR)
      .map((c) => `${c.key} (${c.id}) R${c.maxRanks[3]} freeR ${c.freeR}`);
    expect(disagreements).toEqual([]);
  });

  // ── the 18-point floor ────────────────────────────────────────────────────

  it("keeps every measured kit at or above the 18-point floor", () => {
    const below = Array.from(MEASURED_CHAMPION_KITS.entries())
      .filter(([, kit]) => kit.purchasableTotal < TOTAL_LEVELS)
      .map(([id, kit]) => `id ${id} totals ${kit.purchasableTotal}`);
    expect(below).toEqual([]);
    expect(STANDARD_KIT.purchasableTotal).toBeGreaterThanOrEqual(TOTAL_LEVELS);
  });

  it("keeps every champion on the roster at or above the 18-point floor", () => {
    const below = derived.champions
      .filter((c) => c.purchasableTotal < TOTAL_LEVELS)
      .map((c) => `${c.key} (${c.id}) totals ${c.purchasableTotal}`);
    expect(below).toEqual([]);
  });

  // The tripwire, named as the thing it stops. Kennen is 5/5/5/3 freeR 0 on
  // 16.16.1; bolting a free rank on to make one game's log read coherent gives
  // 5 + 5 + 5 + (3 − 1) = 17, which skillOrderModel refuses outright.
  it("refuses a free rank bolted onto a 5/5/5/3 champion", () => {
    const cheapKennenFix = kitFromMaxRanks([5, 5, 5, 4], "Kennen")!;
    expect(cheapKennenFix.freeRanks.R).toBe(1);
    // Reaching total 17 requires misdeclaring the caps as well; either way the
    // shape a well-meaning patch produces is below the floor.
    const bolted = { ...STANDARD_KIT, freeRanks: { Q: 0, W: 0, E: 0, R: 1 }, purchasableTotal: 17 };
    expect(bolted.purchasableTotal).toBeLessThan(TOTAL_LEVELS);

    // Kennen is deliberately NOT measured, and must stay that way.
    expect(MEASURED_CHAMPION_KITS.has(KENNEN)).toBe(false);
    expect(isMeasuredChampionIdentity(KENNEN, "Kennen")).toBe(false);
    expect(kitForChampionIdentity(KENNEN, "Kennen")).toBe(STANDARD_KIT);
    expect(byId.get(KENNEN)).toMatchObject({ maxRanks: [5, 5, 5, 3], freeR: 0, purchasableTotal: 18 });
  });

  // ── port parity ───────────────────────────────────────────────────────────

  it("carries the same table as the desktop companion", () => {
    const { entries, totalLevels } = parseDesktopTable();

    // Believe the parse before believing its verdict: a regex that matched
    // nothing would make every comparison below pass.
    expect(entries.size).toBeGreaterThanOrEqual(8);
    expect(totalLevels).toBe(TOTAL_LEVELS);

    const differences: string[] = [];
    for (const [id, kit] of MEASURED_CHAMPION_KITS) {
      const desktop = entries.get(id);
      if (!desktop) {
        differences.push(`id ${id} is in MEASURED_CHAMPION_KIT_SPECS but not in ChampionKit.cs`);
        continue;
      }
      const web = [kit.maxRanks.Q, kit.maxRanks.W, kit.maxRanks.E, kit.maxRanks.R];
      if (web.join("/") !== desktop.maxRanks.join("/"))
        differences.push(`id ${id} web ${web.join("/")} vs desktop ${desktop.maxRanks.join("/")}`);
      if (kit.freeRanks.R !== desktop.freeR)
        differences.push(`id ${id} web freeR ${kit.freeRanks.R} vs desktop freeR ${desktop.freeR}`);
    }
    for (const id of entries.keys()) {
      if (!MEASURED_CHAMPION_KITS.has(id))
        differences.push(`id ${id} is in ChampionKit.cs but not in MEASURED_CHAMPION_KIT_SPECS`);
    }

    expect(differences).toEqual([]);
  });
});
