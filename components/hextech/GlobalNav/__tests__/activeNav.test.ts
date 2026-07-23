import { describe, it, expect } from "vitest";
import { isActiveNav } from "../activeNav";

describe("isActiveNav", () => {
  it("root href matches only the exact root path", () => {
    expect(isActiveNav("/", "/")).toBe(true);
    expect(isActiveNav("/draft", "/")).toBe(false);
    expect(isActiveNav("/history", "/")).toBe(false);
  });

  it("non-root href matches its own exact path", () => {
    expect(isActiveNav("/draft", "/draft")).toBe(true);
    expect(isActiveNav("/history", "/history")).toBe(true);
  });

  it("non-root href matches nested sub-paths (prefix case)", () => {
    expect(isActiveNav("/history/123", "/history")).toBe(true);
    expect(isActiveNav("/mystats/detail", "/mystats")).toBe(true);
  });

  it("non-root href does not match an unrelated route, including one with the same prefix text", () => {
    expect(isActiveNav("/draft", "/history")).toBe(false);
    // "/historyfoo" is NOT under "/history" — must not match on bare string prefix.
    expect(isActiveNav("/historyfoo", "/history")).toBe(false);
  });
});
