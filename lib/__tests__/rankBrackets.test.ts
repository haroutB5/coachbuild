/**
 * Feature 3: rank-bracket resolution + validation.
 */
import { describe, it, expect } from "vitest";
import {
  RANK_BRACKETS,
  DEFAULT_RANK_BRACKET,
  resolveRankBracket,
  RANK_FILTERING_SUPPORTED,
} from "../rankBrackets";

describe("RANK_BRACKETS", () => {
  it("has 'all' first and it is the default", () => {
    expect(RANK_BRACKETS[0].id).toBe("all");
    expect(DEFAULT_RANK_BRACKET.id).toBe("all");
  });
  it("the default preserves the app's historical High-Elo tier set [5,6,7]", () => {
    expect(DEFAULT_RANK_BRACKET.apiValue).toEqual([5, 6, 7]);
  });
  it("every bracket's apiValue is a non-empty tier list within the verified 3-8 range", () => {
    for (const b of RANK_BRACKETS) {
      expect(b.apiValue.length).toBeGreaterThan(0);
      for (const t of b.apiValue) {
        expect(t).toBeGreaterThanOrEqual(3);
        expect(t).toBeLessThanOrEqual(8);
      }
    }
  });
  it("bracket ids are unique", () => {
    const ids = RANK_BRACKETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("reports rank filtering as supported (more than just 'all')", () => {
    expect(RANK_FILTERING_SUPPORTED).toBe(true);
  });
});

describe("resolveRankBracket", () => {
  it("null / undefined / '' → default bracket (absent param = historical behaviour)", () => {
    expect(resolveRankBracket(null)?.id).toBe("all");
    expect(resolveRankBracket(undefined)?.id).toBe("all");
    expect(resolveRankBracket("")?.id).toBe("all");
  });
  it("known id → its bracket", () => {
    expect(resolveRankBracket("challenger")?.apiValue).toEqual([8]);
    expect(resolveRankBracket("diamond")?.apiValue).toEqual([5]);
  });
  it("unknown id → null (caller maps to 400)", () => {
    expect(resolveRankBracket("bronze")).toBeNull();
    expect(resolveRankBracket("ALL")).toBeNull(); // case-sensitive
  });
});
