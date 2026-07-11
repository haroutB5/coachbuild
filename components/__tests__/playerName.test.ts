import { describe, it, expect } from "vitest";
import { cleanPlayerName } from "../playerName";

describe("cleanPlayerName", () => {
  it("strips a single trailing parenthetical", () => {
    expect(cleanPlayerName("Saint (Kang Sung-in)")).toBe("Saint");
  });

  it("leaves an already-clean name unchanged", () => {
    expect(cleanPlayerName("Faker")).toBe("Faker");
  });

  it("trims surrounding whitespace even with no parens", () => {
    expect(cleanPlayerName("  Chovy  ")).toBe("Chovy");
  });

  it("only strips the TRAILING group, leaving an earlier one alone", () => {
    expect(cleanPlayerName("Some (A) (B)")).toBe("Some (A)");
  });

  it("does not strip parens that aren't at the end of the string", () => {
    expect(cleanPlayerName("(Old) Name")).toBe("(Old) Name");
  });

  it("passes null/undefined through as null", () => {
    expect(cleanPlayerName(null)).toBeNull();
    expect(cleanPlayerName(undefined)).toBeNull();
  });

  it("falls back to the trimmed original when the whole name is parenthetical", () => {
    expect(cleanPlayerName("(unknown)")).toBe("(unknown)");
  });

  it("handles an empty string without throwing", () => {
    expect(cleanPlayerName("")).toBe("");
  });
});
