import { describe, it, expect } from "vitest";
import { resolveTabKeydown, isTabNavigationKey } from "../hextech/tabKeyboard";

describe("resolveTabKeydown", () => {
  it("ArrowRight advances", () => {
    expect(resolveTabKeydown("ArrowRight", 0, 3)).toBe(1);
    expect(resolveTabKeydown("ArrowRight", 1, 3)).toBe(2);
  });

  it("ArrowLeft retreats", () => {
    expect(resolveTabKeydown("ArrowLeft", 2, 3)).toBe(1);
    expect(resolveTabKeydown("ArrowLeft", 1, 3)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(resolveTabKeydown("ArrowRight", 2, 3)).toBe(0);
    expect(resolveTabKeydown("ArrowLeft", 0, 3)).toBe(2);
  });

  it("Home and End jump to the ends", () => {
    expect(resolveTabKeydown("Home", 2, 3)).toBe(0);
    expect(resolveTabKeydown("End", 0, 3)).toBe(2);
    expect(resolveTabKeydown("Home", 0, 3)).toBe(0);
    expect(resolveTabKeydown("End", 2, 3)).toBe(2);
  });

  // The tablist is horizontal. Swallowing the vertical arrows would stop the
  // page scrolling for the one user this module exists for.
  it("ignores vertical arrows", () => {
    expect(resolveTabKeydown("ArrowUp", 1, 3)).toBeNull();
    expect(resolveTabKeydown("ArrowDown", 1, 3)).toBeNull();
  });

  it("ignores keys the browser owns", () => {
    for (const k of ["Tab", "Enter", " ", "Escape", "a", "PageDown"]) {
      expect(resolveTabKeydown(k, 1, 3)).toBeNull();
    }
  });

  it("never returns an out-of-range index", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      for (let i = 0; i < 3; i++) {
        const next = resolveTabKeydown(key, i, 3);
        expect(next).not.toBeNull();
        expect(next! >= 0 && next! < 3).toBe(true);
      }
    }
  });

  it("survives an out-of-range starting index rather than returning NaN", () => {
    expect(resolveTabKeydown("ArrowRight", 99, 3)).toBe(1);
    expect(resolveTabKeydown("ArrowLeft", -4, 3)).toBe(2);
  });

  it("does nothing for an empty tablist", () => {
    expect(resolveTabKeydown("ArrowRight", 0, 0)).toBeNull();
    expect(resolveTabKeydown("End", 0, 0)).toBeNull();
  });

  it("is a no-op move on a single tab", () => {
    expect(resolveTabKeydown("ArrowRight", 0, 1)).toBe(0);
    expect(resolveTabKeydown("ArrowLeft", 0, 1)).toBe(0);
  });
});

describe("isTabNavigationKey", () => {
  // The component calls preventDefault off this and computes the destination
  // off resolveTabKeydown. If the two disagreed, the tablist would either eat a
  // key it does not act on or scroll the page while moving focus.
  it("agrees with resolveTabKeydown on every key", () => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "ArrowUp", "ArrowDown", "Tab", "Enter", "x"];
    for (const k of keys) {
      expect(isTabNavigationKey(k)).toBe(resolveTabKeydown(k, 0, 3) !== null);
    }
  });
});
