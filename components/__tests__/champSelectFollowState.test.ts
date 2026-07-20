import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  noteCompanionPhase,
  getChampSelectPhaseEpoch,
  hasAppliedForChampion,
  markAppliedForChampion,
  markCompanionDriven,
  isCompanionDrivenChampion,
  resetChampSelectFollowState,
  tryClaimAutoExportLock,
} from "../live/champSelectFollowState";

function makeLocalStorageShim() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
}

function stubWindow(localStorage: ReturnType<typeof makeLocalStorageShim>): void {
  (globalThis as unknown as { window: { localStorage: typeof localStorage } }).window = { localStorage };
}
function unstubWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe("champSelectFollowState", () => {
  beforeEach(() => resetChampSelectFollowState());

  it("hasAppliedForChampion is false until marked", () => {
    expect(hasAppliedForChampion("items", 103)).toBe(false);
    markAppliedForChampion("items", 103);
    expect(hasAppliedForChampion("items", 103)).toBe(true);
  });

  it("items and runes dedup are independent (a user can toggle one off)", () => {
    markAppliedForChampion("items", 103);
    expect(hasAppliedForChampion("items", 103)).toBe(true);
    expect(hasAppliedForChampion("runes", 103)).toBe(false);
  });

  it("hover A applies once, hover B applies once, re-hovering A does not re-apply", () => {
    noteCompanionPhase("ChampSelect");
    expect(hasAppliedForChampion("runes", 103)).toBe(false);
    markAppliedForChampion("runes", 103); // hover A -> export
    expect(hasAppliedForChampion("runes", 103)).toBe(true);

    expect(hasAppliedForChampion("runes", 7)).toBe(false);
    markAppliedForChampion("runes", 7); // hover B -> export
    expect(hasAppliedForChampion("runes", 7)).toBe(true);

    // Re-hover A within the SAME champ-select -- already applied, no re-export.
    expect(hasAppliedForChampion("runes", 103)).toBe(true);
  });

  it("bumps the phase epoch and clears applied state exactly once per ChampSelect ENTRY", () => {
    const epoch0 = getChampSelectPhaseEpoch();
    noteCompanionPhase("Lobby");
    expect(getChampSelectPhaseEpoch()).toBe(epoch0); // not ChampSelect -- no bump

    noteCompanionPhase("ChampSelect");
    const epoch1 = getChampSelectPhaseEpoch();
    expect(epoch1).toBe(epoch0 + 1);
    markAppliedForChampion("runes", 103);

    // Still in ChampSelect on the next poll -- no re-bump, state persists.
    noteCompanionPhase("ChampSelect");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1);
    expect(hasAppliedForChampion("runes", 103)).toBe(true);

    // Leaves ChampSelect (game starts) -- no bump on exit itself.
    noteCompanionPhase("InProgress");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1);

    // A LATER champ-select (next game) bumps again and clears applied state
    // -- the same champion is eligible to auto-export again.
    noteCompanionPhase("ChampSelect");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1 + 1);
    expect(hasAppliedForChampion("runes", 103)).toBe(false);
  });

  it("markCompanionDriven/isCompanionDrivenChampion — only marked champions are eligible", () => {
    expect(isCompanionDrivenChampion(103)).toBe(false);
    markCompanionDriven(103);
    expect(isCompanionDrivenChampion(103)).toBe(true);
    expect(isCompanionDrivenChampion(64)).toBe(false); // a different (e.g. fallback) champion was never marked
  });

  it("companion-driven marks are cleared on a fresh ChampSelect epoch too", () => {
    markCompanionDriven(103);
    noteCompanionPhase("ChampSelect");
    expect(isCompanionDrivenChampion(103)).toBe(false);
  });
});

describe("tryClaimAutoExportLock", () => {
  afterEach(() => unstubWindow());

  it("fails open (returns true) with no window (SSR)", () => {
    expect(tryClaimAutoExportLock("runes", 1, 103)).toBe(true);
  });

  it("first claim succeeds, a second claim within the TTL for the SAME key fails", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103)).toBe(true);
    expect(tryClaimAutoExportLock("runes", 1, 103)).toBe(false);
  });

  it("different championId/kind/epoch are independent locks", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103)).toBe(true);
    expect(tryClaimAutoExportLock("items", 1, 103)).toBe(true); // different kind
    expect(tryClaimAutoExportLock("runes", 1, 7)).toBe(true); // different championId
    expect(tryClaimAutoExportLock("runes", 2, 103)).toBe(true); // different epoch
  });
});
