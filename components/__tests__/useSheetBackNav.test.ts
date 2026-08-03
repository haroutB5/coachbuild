import { describe, it, expect, vi } from "vitest";
import {
  HISTORY_NAV_NAMESPACE,
  HOME_NAV_NAMESPACE,
  isNavSheetState,
  runNavRestore,
  type NavSheetState,
} from "../useSheetBackNav";

describe("isNavSheetState", () => {
  it("accepts a well-formed v1 entry with a selection and an open sheet", () => {
    const state: NavSheetState<{ mode: "player" }> = {
      v: 1,
      namespace: HISTORY_NAV_NAMESPACE,
      selection: { mode: "player" },
      openGameId: "game-1",
    };
    expect(isNavSheetState(state, HISTORY_NAV_NAMESPACE)).toBe(true);
  });

  it("accepts a well-formed v1 entry with no selection and no open sheet (the home tab's shape)", () => {
    const state: NavSheetState<null> = { v: 1, namespace: HOME_NAV_NAMESPACE, selection: null, openGameId: null };
    expect(isNavSheetState(state, HOME_NAV_NAMESPACE)).toBe(true);
  });

  it("rejects null (a fresh, never-annotated history entry)", () => {
    expect(isNavSheetState(null, HOME_NAV_NAMESPACE)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isNavSheetState(undefined, HOME_NAV_NAMESPACE)).toBe(false);
  });

  it("rejects a non-object primitive", () => {
    expect(isNavSheetState("some-string", HOME_NAV_NAMESPACE)).toBe(false);
    expect(isNavSheetState(42, HOME_NAV_NAMESPACE)).toBe(false);
  });

  it("rejects an object missing the v:1 discriminant (a foreign/legacy history entry)", () => {
    expect(isNavSheetState({ selection: null, openGameId: null }, HOME_NAV_NAMESPACE)).toBe(false);
  });

  it("rejects a mismatched version number", () => {
    expect(isNavSheetState({ v: 2, namespace: HOME_NAV_NAMESPACE, selection: null, openGameId: null }, HOME_NAV_NAMESPACE)).toBe(false);
  });

  it("rejects another page's v1 entry even when its payload has the right top-level fields", () => {
    const historyEntry: NavSheetState<{ mode: "player" }> = {
      v: 1,
      namespace: HISTORY_NAV_NAMESPACE,
      selection: { mode: "player" },
      openGameId: null,
    };
    expect(isNavSheetState(historyEntry, HOME_NAV_NAMESPACE)).toBe(false);
    expect(isNavSheetState(historyEntry, HISTORY_NAV_NAMESPACE)).toBe(true);
  });

  it("releases isRestoring after a restore callback throws", async () => {
    const restoringRef = { current: false };
    const isRestoring = () => restoringRef.current;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runNavRestore(restoringRef, () => { throw new Error("bad payload"); })).not.toThrow();
    expect(isRestoring()).toBe(true);
    await Promise.resolve();
    expect(isRestoring()).toBe(false);

    errorSpy.mockRestore();
  });
});
