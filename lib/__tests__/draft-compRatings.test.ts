/**
 * Draft redesign plan §2.2/§6 — lib/draft/compRatings.ts's curated map +
 * aggregateEnemyComp + deriveFallbackRating. Covers: every live champ
 * resolves (curated); aggregate with 0/1/5 enemies + missing (uncurated)
 * ids; fallback flags estimated; spot-checks on named exemplar champions
 * (Leona, Malphite, Yuumi, Zed, Ashe, Ornn) matching the archetype rubric
 * in this file's header comment.
 */
import { describe, it, expect } from "vitest";
import {
  COMP_RATINGS,
  aggregateEnemyComp,
  deriveFallbackRating,
  getCompRating,
} from "../draft/compRatings";

const AXES = ["cc", "damage", "tankiness", "mobility", "utility", "engage"] as const;

describe("COMP_RATINGS — curated coverage", () => {
  it("covers exactly 173 live champions (2026-07-21 roster snapshot)", () => {
    expect(Object.keys(COMP_RATINGS)).toHaveLength(173);
  });

  it("every curated row has all 6 axes as integers in [0,3]", () => {
    for (const [champId, vector] of Object.entries(COMP_RATINGS)) {
      for (const axis of AXES) {
        const v = vector[axis];
        expect(Number.isInteger(v), `champ ${champId} axis ${axis} not an integer`).toBe(true);
        expect(v, `champ ${champId} axis ${axis} out of range`).toBeGreaterThanOrEqual(0);
        expect(v, `champ ${champId} axis ${axis} out of range`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("every curated id resolves via getCompRating with estimated:false", () => {
    for (const champId of Object.keys(COMP_RATINGS).map(Number)) {
      const r = getCompRating(champId);
      expect(r.estimated).toBe(false);
    }
  });
});

describe("getCompRating — un-curated (future) champion falls back, never blank", () => {
  it("an id with no curated row resolves via deriveFallbackRating, flagged estimated:true", () => {
    const r = getCompRating(999999);
    expect(r.estimated).toBe(true);
    for (const axis of AXES) {
      expect(r[axis]).toBeGreaterThanOrEqual(0);
      expect(r[axis]).toBeLessThanOrEqual(3);
    }
  });
});

describe("deriveFallbackRating — tag-driven coarse vector", () => {
  it("Tank tag -> tankiness 2, cc 1 at minimum", () => {
    const v = deriveFallbackRating(["Tank"]);
    expect(v.tankiness).toBe(2);
    expect(v.cc).toBe(1);
  });

  it("Mage tag -> damage 2", () => {
    const v = deriveFallbackRating(["Mage"]);
    expect(v.damage).toBe(2);
  });

  it("Marksman tag -> damage 3, mobility 1", () => {
    const v = deriveFallbackRating(["Marksman"]);
    expect(v.damage).toBe(3);
    expect(v.mobility).toBe(1);
  });

  it("Assassin tag -> mobility 3", () => {
    const v = deriveFallbackRating(["Assassin"]);
    expect(v.mobility).toBe(3);
  });

  it("Support tag -> utility 2", () => {
    const v = deriveFallbackRating(["Support"]);
    expect(v.utility).toBe(2);
  });

  it("multi-tag champion takes the MAX per axis across tags, not a sum", () => {
    // Fighter (damage 2) + Assassin (damage 2, mobility 3) -- damage should
    // stay 2 (max, not 4), mobility should be 3 (Assassin's contribution).
    const v = deriveFallbackRating(["Fighter", "Assassin"]);
    expect(v.damage).toBe(2);
    expect(v.mobility).toBe(3);
  });

  it("no tags, no info -> an all-zero vector", () => {
    const v = deriveFallbackRating([]);
    for (const axis of AXES) expect(v[axis]).toBe(0);
  });

  it("no tags but high attack/magic info fills in a coarse damage guess (never downgrades a tag-derived value)", () => {
    const v = deriveFallbackRating([], { attack: 8, defense: 3, magic: 2 });
    expect(v.damage).toBe(2);
  });

  it("info never DOWNGRADES a tag-derived axis", () => {
    // Marksman already sets damage:3 -- a low attack/magic info block must not pull it down.
    const v = deriveFallbackRating(["Marksman"], { attack: 1, defense: 1, magic: 1 });
    expect(v.damage).toBe(3);
  });

  it("every axis stays clamped to [0,3]", () => {
    const v = deriveFallbackRating(["Tank", "Fighter", "Assassin"], { attack: 10, defense: 10, magic: 10 });
    for (const axis of AXES) {
      expect(v[axis]).toBeGreaterThanOrEqual(0);
      expect(v[axis]).toBeLessThanOrEqual(3);
    }
  });
});

describe("aggregateEnemyComp — mean per axis, handles 0/1/5 enemies + missing ids", () => {
  it("0 enemies -> all-zero, estimatedCount 0 (handles gracefully, no divide-by-zero)", () => {
    const agg = aggregateEnemyComp([]);
    for (const axis of AXES) expect(agg[axis]).toBe(0);
    expect(agg.estimatedCount).toBe(0);
  });

  it("1 enemy -> exactly that champion's curated vector", () => {
    // Leona (89): cc3 damage0 tankiness3 mobility1 utility2 engage3
    const agg = aggregateEnemyComp([89]);
    expect(agg).toEqual({ cc: 3, damage: 0, tankiness: 3, mobility: 1, utility: 2, engage: 3, estimatedCount: 0 });
  });

  it("5 enemies -> a plain arithmetic mean per axis", () => {
    const ids = [89, 54, 350, 238, 22]; // Leona, Malphite, Yuumi, Zed, Ashe
    const agg = aggregateEnemyComp(ids);
    const expectedCC = (3 + 3 + 1 + 1 + 3) / 5;
    expect(agg.cc).toBeCloseTo(expectedCC, 10);
    expect(agg.estimatedCount).toBe(0); // all 5 are curated
  });

  it("a missing (uncurated) id resolves via fallback and is counted in estimatedCount", () => {
    const agg = aggregateEnemyComp([89, 999999]);
    expect(agg.estimatedCount).toBe(1);
    // mean of Leona's real cc(3) and the neutral fallback's cc(0) -> 1.5
    expect(agg.cc).toBeCloseTo(1.5, 10);
  });

  it("every-missing set -> estimatedCount equals the full count", () => {
    const agg = aggregateEnemyComp([999997, 999998, 999999]);
    expect(agg.estimatedCount).toBe(3);
  });
});

describe("exemplar spot-checks (archetype sanity, plan §2.2 header worked examples)", () => {
  it("Leona (89) — engage tank: cc3 engage3 tankiness3 damage0 mobility1 utility2", () => {
    expect(COMP_RATINGS[89]).toEqual({ cc: 3, damage: 0, tankiness: 3, mobility: 1, utility: 2, engage: 3 });
  });

  it("Malphite (54) — engage tank: tankiness3 cc3 engage3, low damage/mobility, no utility", () => {
    const r = COMP_RATINGS[54];
    expect(r.tankiness).toBe(3);
    expect(r.cc).toBe(3);
    expect(r.engage).toBe(3);
    expect(r.damage).toBeLessThanOrEqual(1);
    expect(r.utility).toBe(0);
  });

  it("Yuumi (350) — pure enchanter: utility3, damage0, tankiness0, mobility0", () => {
    const r = COMP_RATINGS[350];
    expect(r.utility).toBe(3);
    expect(r.damage).toBe(0);
    expect(r.tankiness).toBe(0);
    expect(r.mobility).toBe(0);
  });

  it("Zed (238) — pure assassin: mobility3 damage3, low cc (0-1), no tankiness/utility", () => {
    const r = COMP_RATINGS[238];
    expect(r.mobility).toBe(3);
    expect(r.damage).toBe(3);
    expect(r.cc).toBeLessThanOrEqual(1);
    expect(r.tankiness).toBe(0);
    expect(r.utility).toBe(0);
  });

  it("Ashe (22) — CC-marksman hybrid: cc3 (unusual for an ADC), real damage, no mobility", () => {
    const r = COMP_RATINGS[22];
    expect(r.cc).toBe(3);
    expect(r.damage).toBeGreaterThanOrEqual(2);
    expect(r.mobility).toBe(0);
  });

  it("Ornn (516) — tank enabler: tankiness3 cc3 engage3, low damage/mobility, real utility", () => {
    const r = COMP_RATINGS[516];
    expect(r.tankiness).toBe(3);
    expect(r.cc).toBe(3);
    expect(r.engage).toBe(3);
    expect(r.damage).toBeLessThanOrEqual(1);
    expect(r.utility).toBeGreaterThanOrEqual(1);
  });
});
