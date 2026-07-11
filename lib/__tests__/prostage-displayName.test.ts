import { describe, it, expect } from "vitest";
import { cleanLeaguepediaName } from "../prostage/displayName";

describe("cleanLeaguepediaName", () => {
  it("strips a trailing team-disambiguation parenthetical", () => {
    expect(cleanLeaguepediaName("LYON (2024 American Team)")).toBe("LYON");
  });

  it("strips a trailing player real-name disambiguator", () => {
    expect(cleanLeaguepediaName("Zeka (Kim Geon-woo)")).toBe("Zeka");
    expect(cleanLeaguepediaName("Saint (Kang Sung-in)")).toBe("Saint");
  });

  it("leaves a name with no trailing parenthetical untouched", () => {
    expect(cleanLeaguepediaName("Zeus")).toBe("Zeus");
    expect(cleanLeaguepediaName("Hanwha Life Esports")).toBe("Hanwha Life Esports");
  });

  it("trims surrounding whitespace even with no parenthetical", () => {
    expect(cleanLeaguepediaName("  Zeus  ")).toBe("Zeus");
  });

  it("strips a name that legitimately ends in something like '(2)' (accepted false positive)", () => {
    expect(cleanLeaguepediaName("Player (2)")).toBe("Player");
  });

  it("only strips the LAST trailing group, never recurses", () => {
    expect(cleanLeaguepediaName("Name (A) (B)")).toBe("Name (A)");
  });

  it("leaves a non-trailing parenthetical alone (no match at the end)", () => {
    expect(cleanLeaguepediaName("Mid (Top) Laner")).toBe("Mid (Top) Laner");
  });

  it("never returns an empty string — falls back to the trimmed original when the whole input is one group", () => {
    expect(cleanLeaguepediaName("(FullyParenthesized)")).toBe("(FullyParenthesized)");
  });

  it("handles an empty string without throwing", () => {
    expect(cleanLeaguepediaName("")).toBe("");
  });
});
