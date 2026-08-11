/**
 * Rank-bracket resolution + validation, after the 2026-08-11 collapse to a
 * SINGLE Diamond+ bracket.
 *
 * The tier NUMBERS are the point of most of these assertions. The confirmed
 * coachless enum (read out of their production bundle — see lib/rankBrackets.ts's
 * header) is Iron 0 … Emerald 5, Diamond 6, Master 7, Grandmaster 8,
 * Challenger 9. The previous version of this file pinned [5,6,7] under the name
 * "High Elo", which was really Emerald+Diamond+Master and silently excluded
 * Grandmaster and Challenger. A test that pins a NUMBER to a NAME is the thing
 * that would have caught that, so these do it explicitly.
 */
import { describe, it, expect } from "vitest";
import {
  RANK_BRACKETS,
  DEFAULT_RANK_BRACKET,
  DIAMOND_PLUS_BRACKET,
  DRAFT_BRACKET,
  resolveRankBracket,
  rankQueryParam,
  RANK_FILTERING_SUPPORTED,
} from "../rankBrackets";
import { DIAMOND_2_PLUS_TIER } from "../draft/ugg";

// v0.109.0 — the DRAFT side's bracket, added so /draft can finally LABEL the
// population its win rates describe (it rendered no rank at all, while Builds
// has carried a scope note since v0.107.0). Two things need pinning, and both
// are failures this codebase has actually shipped:
//   1. the label must track the tier id it claims to describe, and
//   2. it must NOT leak into the Builds selector, whose provider uses a
//      completely unrelated tier enum.
describe("DRAFT_BRACKET (u.gg side)", () => {
  it("is pinned to the u.gg tier the draft engine actually queries", () => {
    expect(DRAFT_BRACKET.apiValue).toEqual([DIAMOND_2_PLUS_TIER]);
    expect(DIAMOND_2_PLUS_TIER).toBe(15);
  });

  it("says Diamond II, which is exactly what tier 15 is — no rounding to 'Diamond+'", () => {
    expect(DRAFT_BRACKET.label).toBe("Diamond II+");
    expect(DRAFT_BRACKET.description).toContain("Diamond II and above");
    // The two halves of the app run on different brackets deliberately; the
    // labels must not be interchangeable, or the difference reads as a bug.
    expect(DRAFT_BRACKET.label).not.toBe(DIAMOND_PLUS_BRACKET.label);
  });

  it("is NOT selectable on the Builds side — its tier id belongs to a different provider's enum", () => {
    expect(RANK_BRACKETS).not.toContain(DRAFT_BRACKET);
    expect(resolveRankBracket(DRAFT_BRACKET.id)).toBeNull();
    // Guard the specific confusion: 15 is DIAMOND_2_PLUS in u.gg's enum and
    // means nothing at all in coachless's (which stops at Challenger = 9).
    expect(DIAMOND_PLUS_BRACKET.apiValue).not.toContain(DIAMOND_2_PLUS_TIER);
  });
});

describe("RANK_BRACKETS", () => {
  it("contains exactly one bracket, and it is the default", () => {
    expect(RANK_BRACKETS).toHaveLength(1);
    expect(RANK_BRACKETS[0]).toBe(DIAMOND_PLUS_BRACKET);
    expect(DEFAULT_RANK_BRACKET).toBe(DIAMOND_PLUS_BRACKET);
  });

  it("the default is Diamond+ = tiers [6,7,8,9] (Diamond, Master, Grandmaster, Challenger)", () => {
    expect(DEFAULT_RANK_BRACKET.apiValue).toEqual([6, 7, 8, 9]);
  });

  it("does NOT include tier 5 — that is EMERALD in the confirmed enum, not Diamond", () => {
    expect(DEFAULT_RANK_BRACKET.apiValue).not.toContain(5);
  });

  it("includes Grandmaster (8) and Challenger (9), which the old [5,6,7] default excluded", () => {
    expect(DEFAULT_RANK_BRACKET.apiValue).toContain(8);
    expect(DEFAULT_RANK_BRACKET.apiValue).toContain(9);
  });

  it("does not reuse any retired bracket id — every stored id must fail validation and migrate", () => {
    const retired = ["all", "challenger", "grandmaster", "master", "diamond", "emerald", "platinum"];
    const ids = RANK_BRACKETS.map((b) => b.id);
    for (const old of retired) {
      expect(ids).not.toContain(old);
    }
  });

  it("every bracket carries a label and an honest description of its span", () => {
    for (const b of RANK_BRACKETS) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it("reports rank filtering as UNSUPPORTED — the UI must render a scope note, not a selector", () => {
    expect(RANK_FILTERING_SUPPORTED).toBe(false);
  });
});

describe("resolveRankBracket", () => {
  it("null / undefined / '' → the default bracket (an absent param is never an error)", () => {
    expect(resolveRankBracket(null)).toBe(DIAMOND_PLUS_BRACKET);
    expect(resolveRankBracket(undefined)).toBe(DIAMOND_PLUS_BRACKET);
    expect(resolveRankBracket("")).toBe(DIAMOND_PLUS_BRACKET);
  });

  it("the one known id → its bracket", () => {
    expect(resolveRankBracket("diamond-plus")).toBe(DIAMOND_PLUS_BRACKET);
  });

  it("every RETIRED id → null, so the API routes answer 400 rather than serving old tiers", () => {
    for (const old of ["all", "challenger", "grandmaster", "master", "diamond", "emerald", "platinum"]) {
      expect(resolveRankBracket(old)).toBeNull();
    }
  });

  it("unknown id → null (caller maps to 400), and matching stays case-sensitive", () => {
    expect(resolveRankBracket("bronze")).toBeNull();
    expect(resolveRankBracket("Diamond-Plus")).toBeNull();
  });
});

describe("rankQueryParam", () => {
  // This helper exists to move the CDN cache key. Both /api/build and
  // /api/hero-stats send Cache-Control: s-maxage=21600 keyed on the query
  // string, so an omitted param would let a shared cache keep serving builds
  // computed from the old [5,6,7] tiers under the new Diamond+ label.
  it("ALWAYS emits the param, including for the default bracket", () => {
    expect(rankQueryParam(undefined)).toBe("&rank=diamond-plus");
    expect(rankQueryParam(null)).toBe("&rank=diamond-plus");
    expect(rankQueryParam("")).toBe("&rank=diamond-plus");
    expect(rankQueryParam("diamond-plus")).toBe("&rank=diamond-plus");
  });

  it("falls back to the default for a stale or unknown id rather than forwarding it", () => {
    // A stale localStorage value must never reach the route as `rank=emerald`,
    // which the route would (correctly) reject with a 400.
    expect(rankQueryParam("emerald")).toBe("&rank=diamond-plus");
    expect(rankQueryParam("all")).toBe("&rank=diamond-plus");
  });

  it("produces a URL fragment that differs from the pre-change request (cache key moves)", () => {
    const before = `/api/build?champ=112&role=2`;
    const after = `/api/build?champ=112&role=2${rankQueryParam(undefined)}`;
    expect(after).not.toBe(before);
  });
});
