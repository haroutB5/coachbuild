/**
 * THE EXHAUSTIVE LADDER TABLE (spec §2, 2026-08-20).
 *
 * lib/mystats/ladder.ts turns a (tier, division, lp) reading into ONE absolute
 * integer so that two readings can be subtracted. The spec calls it "the
 * likeliest place for a subtle wrong number" and it is right: the failure mode
 * is not a crash, it is a confident LP figure that is off by a whole tier and
 * that nobody can tell is wrong by looking at it.
 *
 * The two numbers this file exists to pin:
 *
 *   1. Gold I 90 -> Plat IV 10 is +20, NOT -80. A naive `lp - lp` reads the
 *      promotion as an 80-point loss. This is the case the spec names.
 *
 *   2. Master 500 -> Grandmaster 520 is +20, NOT +420 and NOT +3220. Master,
 *      Grandmaster and Challenger are not three stacked 400-point tiers: they
 *      are ONE continuous LP pool whose top slices are relabelled by rank
 *      cutoff. A player sitting at 400 LP can be Grandmaster on Monday and
 *      Master on Tuesday having neither won nor lost a game, because the
 *      cutoff moved under them. Giving the apex tiers separate bases would
 *      manufacture hundreds of LP out of that.
 *
 * Tier ordering is the confirmed enum (lib/rankBrackets.ts's header, read
 * verbatim out of a production bundle): Iron 0 · Bronze 1 · Silver 2 · Gold 3 ·
 * Platinum 4 · Emerald 5 · Diamond 6 · Master 7 · Grandmaster 8 · Challenger 9.
 * EMERALD is in it; a table that forgets Emerald puts every Diamond+ reading
 * 400 LP too low and every Diamond<->Emerald move off by 400.
 */
import { describe, it, expect } from "vitest";
import {
  APEX_BASE,
  APEX_TIERS,
  DIVISIONAL_TIERS,
  LP_PER_DIVISION,
  LP_PER_TIER,
  isApexTier,
  ladderDelta,
  ladderPoints,
} from "@/lib/mystats/ladder";

const P = (tier: string | null, division: string | null, lp: number | null) =>
  ladderPoints({ tier, division, lp });

describe("ladderPoints — the absolute scale", () => {
  it("starts at zero and steps 100 per division, 400 per tier", () => {
    expect(P("IRON", "IV", 0)).toBe(0);
    expect(P("IRON", "IV", 37)).toBe(37);
    expect(P("IRON", "III", 0)).toBe(100);
    expect(P("IRON", "II", 0)).toBe(200);
    expect(P("IRON", "I", 0)).toBe(300);
    expect(P("BRONZE", "IV", 0)).toBe(400);
    expect(LP_PER_DIVISION).toBe(100);
    expect(LP_PER_TIER).toBe(400);
  });

  it("places every divisional tier at its confirmed index", () => {
    // One row per tier, all at IV 0, so the whole ordering is asserted at once.
    const expected: Array<[string, number]> = [
      ["IRON", 0],
      ["BRONZE", 400],
      ["SILVER", 800],
      ["GOLD", 1200],
      ["PLATINUM", 1600],
      ["EMERALD", 2000],
      ["DIAMOND", 2400],
    ];
    expect(expected.map(([t]) => t)).toEqual([...DIVISIONAL_TIERS]);
    for (const [tier, points] of expected) {
      expect(P(tier, "IV", 0), `${tier} IV 0`).toBe(points);
    }
  });

  it("the apex tiers share ONE base and ignore division entirely", () => {
    // Diamond I 100 and Master 0 are the SAME point on the ladder — promotion
    // into Master is continuous, not a 400-point jump.
    expect(P("DIAMOND", "I", 100)).toBe(APEX_BASE);
    expect(APEX_BASE).toBe(2800);
    for (const tier of APEX_TIERS) {
      expect(P(tier, "I", 0), `${tier} 0 LP`).toBe(APEX_BASE);
      expect(P(tier, "I", 742), `${tier} 742 LP`).toBe(APEX_BASE + 742);
      // Riot sends "I" for apex where it is meaningless (migration 0022). A
      // division that leaked into the arithmetic would add 300 LP here.
      expect(P(tier, null, 742)).toBe(P(tier, "I", 742));
      expect(P(tier, "IV", 742)).toBe(P(tier, "I", 742));
      expect(isApexTier(tier)).toBe(true);
    }
    for (const tier of DIVISIONAL_TIERS) expect(isApexTier(tier)).toBe(false);
    expect(isApexTier(null)).toBe(false);
  });

  it("apex LP is unbounded", () => {
    // 2486 is a real Challenger reading from lib/__tests__/otp-leaderboard.test.ts.
    expect(P("CHALLENGER", "I", 2486)).toBe(APEX_BASE + 2486);
    expect(P("MASTER", "I", 10_000)).toBe(APEX_BASE + 10_000);
  });

  it("normalises case and whitespace, and nothing else", () => {
    expect(P(" gold ", " i ", 90)).toBe(P("GOLD", "I", 90));
    expect(P("Master", null, 30)).toBe(P("MASTER", "I", 30));
  });

  describe("fails closed — a reading it cannot place is null, never a guess", () => {
    it("unknown tier", () => {
      // A tier Riot invents next season must NOT be silently placed at 0 or at
      // the top of the scale. Null means "no arithmetic possible", which the
      // caller renders as a dash.
      expect(P("GOLDD", "I", 0)).toBeNull();
      expect(P("UNRANKED", "I", 0)).toBeNull();
      expect(P("", "I", 0)).toBeNull();
    });
    it("null tier is unranked, and unranked has no position", () => {
      expect(P(null, null, null)).toBeNull();
      expect(P(null, "I", 40)).toBeNull();
    });
    it("a divisional tier with no division cannot be placed within its tier", () => {
      expect(P("GOLD", null, 90)).toBeNull();
      expect(P("GOLD", "V", 90)).toBeNull();
      expect(P("GOLD", "0", 90)).toBeNull();
    });
    it("missing or nonsense LP", () => {
      expect(P("GOLD", "I", null)).toBeNull();
      expect(P("GOLD", "I", -1)).toBeNull();
      expect(P("GOLD", "I", 12.5)).toBeNull();
      expect(P("GOLD", "I", Number.NaN)).toBeNull();
      expect(P("GOLD", "I", Number.POSITIVE_INFINITY)).toBeNull();
    });
  });
});

describe("ladderDelta — the exhaustive table", () => {
  interface Case {
    label: string;
    from: [string | null, string | null, number | null];
    to: [string | null, string | null, number | null];
    delta: number | null;
  }

  const CASES: Case[] = [
    // ── within a division ────────────────────────────────────────────────
    { label: "a win inside one division", from: ["GOLD", "II", 40], to: ["GOLD", "II", 62], delta: 22 },
    { label: "a loss inside one division", from: ["GOLD", "II", 40], to: ["GOLD", "II", 21], delta: -19 },
    { label: "no change at all", from: ["GOLD", "II", 40], to: ["GOLD", "II", 40], delta: 0 },

    // ── within a tier, across divisions ──────────────────────────────────
    { label: "division up", from: ["SILVER", "III", 92], to: ["SILVER", "II", 8], delta: 16 },
    { label: "division down", from: ["SILVER", "II", 8], to: ["SILVER", "III", 92], delta: -16 },

    // ── THE HEADLINE: promotion across a tier ────────────────────────────
    { label: "Gold I 90 -> Plat IV 10 is +20, not -80", from: ["GOLD", "I", 90], to: ["PLATINUM", "IV", 10], delta: 20 },
    { label: "and the mirror demotion", from: ["PLATINUM", "IV", 10], to: ["GOLD", "I", 90], delta: -20 },
    { label: "demotion out of a tier", from: ["PLATINUM", "IV", 10], to: ["GOLD", "I", 75], delta: -35 },

    // ── Emerald is real and sits between Platinum and Diamond ────────────
    { label: "Plat I 100 -> Emerald IV 0", from: ["PLATINUM", "I", 100], to: ["EMERALD", "IV", 0], delta: 0 },
    { label: "Emerald I 88 -> Diamond IV 20", from: ["EMERALD", "I", 88], to: ["DIAMOND", "IV", 20], delta: 32 },

    // ── apex entry ───────────────────────────────────────────────────────
    { label: "Diamond I 100 -> Master 0 is a no-op, not +400", from: ["DIAMOND", "I", 100], to: ["MASTER", "I", 0], delta: 0 },
    { label: "Diamond I 75 -> Master 12", from: ["DIAMOND", "I", 75], to: ["MASTER", "I", 12], delta: 37 },
    { label: "Master 0 -> Diamond I 75 (apex demotion)", from: ["MASTER", "I", 0], to: ["DIAMOND", "I", 75], delta: -25 },

    // ── apex to apex: ONE pool, relabelled ───────────────────────────────
    { label: "Master 500 -> Grandmaster 520 is +20", from: ["MASTER", "I", 500], to: ["GRANDMASTER", "I", 520], delta: 20 },
    { label: "Grandmaster 900 -> Challenger 1100", from: ["GRANDMASTER", "I", 900], to: ["CHALLENGER", "I", 1100], delta: 200 },
    { label: "Challenger 1100 -> Grandmaster 1080 (the cutoff moved under them)", from: ["CHALLENGER", "I", 1100], to: ["GRANDMASTER", "I", 1080], delta: -20 },
    { label: "Grandmaster 400 -> Master 400 with NO LP change at all", from: ["GRANDMASTER", "I", 400], to: ["MASTER", "I", 400], delta: 0 },

    // ── the whole scale ──────────────────────────────────────────────────
    { label: "Iron IV 0 -> Challenger 1500", from: ["IRON", "IV", 0], to: ["CHALLENGER", "I", 1500], delta: 4300 },

    // ── unusable readings ────────────────────────────────────────────────
    { label: "unranked start", from: [null, null, null], to: ["IRON", "IV", 0], delta: null },
    { label: "unranked end", from: ["IRON", "IV", 0], to: [null, null, null], delta: null },
    { label: "unknown tier either side", from: ["MYTHIC", "I", 0], to: ["GOLD", "I", 0], delta: null },
  ];

  for (const c of CASES) {
    it(c.label, () => {
      const got = ladderDelta(
        { tier: c.from[0], division: c.from[1], lp: c.from[2] },
        { tier: c.to[0], division: c.to[1], lp: c.to[2] }
      );
      expect(got).toBe(c.delta);
    });
  }

  it("is exactly antisymmetric wherever it is defined", () => {
    // A property over the whole table rather than one more example: if forward
    // and reverse ever disagree in magnitude, one of the two readings is being
    // placed differently depending on which side of the subtraction it sits on.
    for (const c of CASES) {
      if (c.delta === null) continue;
      const from = { tier: c.from[0], division: c.from[1], lp: c.from[2] };
      const to = { tier: c.to[0], division: c.to[1], lp: c.to[2] };
      // `c.delta === 0 ? 0 : -c.delta` rather than a bare `-c.delta`, because
      // `-0` is a distinct value in JavaScript and ladderDelta deliberately
      // never returns it — see the negative-zero test below.
      expect(ladderDelta(to, from), `reverse of: ${c.label}`).toBe(c.delta === 0 ? 0 : -c.delta);
    }
  });

  it("never returns negative zero — a flat session must not render as '-0 LP'", () => {
    // Found by the antisymmetry property above. `b - a` is +0 either way, but a
    // caller (or a future refactor to `-forward`) can produce -0, and a signed
    // formatter turns that into a loss that did not happen.
    const flat = ladderDelta({ tier: "GOLD", division: "II", lp: 40 }, { tier: "GOLD", division: "II", lp: 40 });
    expect(Object.is(flat, -0)).toBe(false);
    expect(Object.is(flat, 0)).toBe(true);
  });

  it("is monotonic across the entire ladder — every step up is positive", () => {
    // Walks every (tier, division) boundary in order and asserts the absolute
    // value strictly increases. This is the check that catches an Emerald-shaped
    // hole, a reversed division order (IV is the LOWEST division, I the
    // highest), or an apex base that overlaps Diamond.
    const walk: number[] = [];
    for (const tier of DIVISIONAL_TIERS) {
      for (const div of ["IV", "III", "II", "I"]) {
        walk.push(P(tier, div, 0)!, P(tier, div, 99)!);
      }
    }
    walk.push(P("MASTER", "I", 0)!, P("MASTER", "I", 1)!, P("CHALLENGER", "I", 2)!);
    for (let i = 1; i < walk.length; i += 1) {
      expect(walk[i], `step ${i} of the ladder walk is not above its predecessor`).toBeGreaterThan(walk[i - 1]);
    }
    expect(walk.some((v) => Number.isNaN(v))).toBe(false);
  });
});
