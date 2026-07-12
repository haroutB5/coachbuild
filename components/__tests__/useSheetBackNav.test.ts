import { describe, it, expect } from "vitest";
import { isNavSheetState, type NavSheetState } from "../useSheetBackNav";

describe("isNavSheetState", () => {
  it("accepts a well-formed v1 entry with a selection and an open sheet", () => {
    const state: NavSheetState<{ mode: "player" }> = {
      v: 1,
      selection: { mode: "player" },
      openGameId: "game-1",
    };
    expect(isNavSheetState(state)).toBe(true);
  });

  it("accepts a well-formed v1 entry with no selection and no open sheet (the home tab's shape)", () => {
    const state: NavSheetState<null> = { v: 1, selection: null, openGameId: null };
    expect(isNavSheetState(state)).toBe(true);
  });

  it("rejects null (a fresh, never-annotated history entry)", () => {
    expect(isNavSheetState(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isNavSheetState(undefined)).toBe(false);
  });

  it("rejects a non-object primitive", () => {
    expect(isNavSheetState("some-string")).toBe(false);
    expect(isNavSheetState(42)).toBe(false);
  });

  it("rejects an object missing the v:1 discriminant (a foreign/legacy history entry)", () => {
    expect(isNavSheetState({ selection: null, openGameId: null })).toBe(false);
  });

  it("rejects a mismatched version number", () => {
    expect(isNavSheetState({ v: 2, selection: null, openGameId: null })).toBe(false);
  });
});
