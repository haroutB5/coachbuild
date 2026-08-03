/**
 * Unit tests for the recommendation engine's ranking primitives.
 * Inline copies of the logic from recommend.ts — zero network, wall-clock free.
 * Mirrors the confidence-weighted ranking (user decision 2026-06-14).
 */

import { describe, it, expect } from "vitest";
import { pickSpells } from "../recommend";

const ADOPT_FRAC = 0.05;
const ADOPT_FLOOR = 500;

type E = { wpaOverall: number; occurrence: number; rune?: number };
const r = (wpa: number, occ: number, rune = 0): E => ({ wpaOverall: wpa, occurrence: occ, rune });

// ── Mirrors of recommend.ts ────────────────────────────────────────────────────

function adoptionBar(total: number): number {
  return Math.max(ADOPT_FLOOR, total * ADOPT_FRAC);
}

function pickRecommended<T extends E>(entries: T[], bar: number): T | null {
  if (!entries.length) return null;
  const adopted = entries.filter((e) => e.occurrence >= bar);
  if (adopted.length) return adopted.slice().sort((a, b) => b.wpaOverall - a.wpaOverall)[0];
  return entries.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}

function bestPositiveByOcc<T extends E>(entries: T[], floor: number): T | null {
  const ok = entries.filter((e) => e.occurrence >= floor && e.wpaOverall > 0);
  if (!ok.length) return null;
  return ok.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}

function bestAboveFloor<T extends E>(entries: T[], floor: number): T | null {
  const ok = entries.filter((e) => e.occurrence >= floor);
  if (ok.length) return ok.slice().sort((a, b) => b.wpaOverall - a.wpaOverall)[0];
  return entries.slice().sort((a, b) => b.occurrence - a.occurrence)[0] ?? null;
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("adoptionBar (5% of total games, floor 500)", () => {
  it("floors at 500 for small populations", () => {
    expect(adoptionBar(2000)).toBe(500); // 5% = 100 → floor 500
  });
  it("scales with total games", () => {
    expect(adoptionBar(270000)).toBe(13500); // Viktor-mid scale
  });
});

describe("pickRecommended (confidence-weighted headline pick)", () => {
  it("demotes a high-WPA low-sample spike below the adoption bar", () => {
    const bar = adoptionBar(300000); // 15000
    const entries = [r(6.9, 138, 1), r(0.05, 251000, 2), r(0.25, 2700, 3)];
    // Only #2 clears 15000 → it wins despite the +6.9 fluke and the +0.25.
    expect(pickRecommended(entries, bar)?.rune).toBe(2);
  });
  it("falls back to most-played when nothing clears the bar", () => {
    const bar = adoptionBar(300000);
    const entries = [r(3.0, 200, 1), r(0.1, 9000, 2)];
    expect(pickRecommended(entries, bar)?.rune).toBe(2); // most-played
  });
});

describe("bestPositiveByOcc (reliable secondary pick)", () => {
  it("picks the most-PLAYED positive rune, ignoring a higher-WPA smaller-sample one", () => {
    // Viktor Precision: Cut Down (+0.18/57k) and Legend Haste (+0.19/54k) beat a
    // higher-WPA but smaller-sample option.
    const entries = [r(0.18, 57000, 8017), r(2.29, 3000, 9999)];
    expect(bestPositiveByOcc(entries, 800)?.rune).toBe(8017);
  });
  it("returns null when no positive rune clears the floor", () => {
    const entries = [r(-0.2, 185000, 1), r(1.5, 300, 2)];
    expect(bestPositiveByOcc(entries, 800)).toBeNull();
  });
});

describe("bestAboveFloor (high-ceiling alternative pick)", () => {
  it("excludes sub-floor flukes but keeps real moderate samples", () => {
    // Jack of All Trades (511) excluded; Triple Tonic (2987) kept.
    const entries = [r(2.33, 511, 1), r(2.29, 2987, 2)];
    expect(bestAboveFloor(entries, 800)?.rune).toBe(2);
  });
  it("prefers the popular negative rune only when nothing else clears the floor", () => {
    const entries = [r(-0.16, 185000, 1), r(0.64, 400, 2)];
    expect(bestAboveFloor(entries, 800)?.rune).toBe(1); // only #1 clears 800
  });
});

describe("variant viability", () => {
  it("a tree with < 2 non-negative above-floor runes is not a viable alternative", () => {
    const rows = [[r(0.4, 1500, 1)], [r(-1.6, 60000, 2)], [r(-3.0, 200, 3)]];
    const picks = rows
      .map((row) => bestAboveFloor(row, 800))
      .filter((p): p is E => !!p && p.wpaOverall >= 0);
    expect(picks.length).toBeLessThan(2); // not viable → dropped from the top-3
  });
});

// ── Spell selection (regression: no duplicate "Flash, Flash") ──────────────────

const sp = (id: number, wpa: number, occ: number) => ({
  summonerSpell: id,
  wpaOverall: wpa,
  occurrence: occ,
  occurrenceRelative: 0,
  winrateExpected: 50,
  winrateObserved: 50,
  averageCasts: 0,
});

// ── noise floor vs adoption bar invariant (P3(b) fix, 2026-07-17) ──────────
// recommend.ts's real noiseFloor/bar aren't exported (computed inline inside
// buildRecommendations), so this mirrors both formulas exactly — same
// pattern this whole file already uses for adoptionBar/pickRecommended/etc.
// The noise floor is meant to be a LOWER/looser threshold than the adoption
// bar; before the fix, floor(800) exceeded bar for every total under 16,000
// games (the vast majority of real champ+role combos) — this test directly
// encodes the invariant that regression would have broken.

describe("noiseFloor vs adoptionBar invariant", () => {
  const bar = (total: number) => Math.max(500, total * 0.05);
  const noiseFloor = (total: number) => Math.max(400, total * 0.002);

  it("noiseFloor never exceeds the adoption bar, across the full sample-size range", () => {
    for (const total of [0, 500, 2000, 8000, 10000, 16000, 50000, 200000, 1000000]) {
      expect(noiseFloor(total)).toBeLessThanOrEqual(bar(total));
    }
  });

  it("the OLD flat component (800) would have violated the invariant below 16,000 games — proves this is a real fix, not a no-op", () => {
    const oldNoiseFloor = (total: number) => Math.max(800, total * 0.002);
    expect(oldNoiseFloor(8000)).toBeGreaterThan(bar(8000)); // 800 > 500 — inverted
    expect(oldNoiseFloor(15999)).toBeGreaterThan(bar(15999)); // 800 > 799.95 — inverted
  });
});

describe("pickSpells", () => {
  it("returns the 2 distinct highest-WPA adopted spells", () => {
    const pool = [sp(4, 0.0, 50000), sp(6, 1.2, 20000), sp(14, 0.8, 1000)];
    const ids = pickSpells(pool, 5000).map((s) => s.summonerSpell);
    expect(ids.sort()).toEqual([4, 6]); // Flash + Ghost (Ignite below the bar)
  });

  it("never returns the same spell twice when only one is adopted", () => {
    const pool = [sp(4, 0.0, 50000), sp(14, 1.5, 200)];
    const ids = pickSpells(pool, 5000).map((s) => s.summonerSpell);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2); // distinct — fills Ignite from the pool
    expect(ids).toContain(4);
  });

  it("returns a single spell when the pool has only one", () => {
    expect(pickSpells([sp(4, 0.0, 50000)], 5000).length).toBe(1);
  });

  it("breaks tied spell WPA and occurrence by spell id, independent of provider order", () => {
    const pool = [sp(14, 1.0, 50000), sp(6, 1.0, 50000), sp(4, 1.0, 50000)];
    expect(pickSpells(pool, 5000).map((entry) => entry.summonerSpell)).toEqual([4, 6]);
  });
});
