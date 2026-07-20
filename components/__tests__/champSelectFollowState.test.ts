// v0.35.0 rewrite (user on-device evidence): the auto-export dedup
// generalized again from "once per (champ-select session, championId)" to
// "...+ laneId" — a LANE CHANGE on the SAME companion-driven champion (e.g.
// Senna Bot -> Support) never re-fired under the old championId-only Set,
// leaving the in-game build on the OLD lane. See champSelectFollowState.ts's
// header + shouldAutoExportForLane's own doc comment for the "latest wins"
// model this replaces hasAppliedForChampion/markAppliedForChampion with.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  noteCompanionPhase,
  getChampSelectPhaseEpoch,
  isInChampSelect,
  setCurrentChampSelectChampionId,
  getCurrentChampSelectChampionId,
  shouldAutoExportForLane,
  markAutoExported,
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

describe("champSelectFollowState — shouldAutoExportForLane / markAutoExported", () => {
  beforeEach(() => resetChampSelectFollowState());

  it("fires on the first-ever export (nothing applied yet)", () => {
    expect(shouldAutoExportForLane("items", 103, "bot")).toBe(true);
  });

  it("does not re-fire for the SAME (championId, laneId) pair already applied", () => {
    markAutoExported("items", 103, "bot");
    expect(shouldAutoExportForLane("items", 103, "bot")).toBe(false);
  });

  it("items and runes dedup are independent (a user can toggle one off)", () => {
    markAutoExported("items", 103, "bot");
    expect(shouldAutoExportForLane("items", 103, "bot")).toBe(false);
    expect(shouldAutoExportForLane("runes", 103, "bot")).toBe(true);
  });

  it("a DIFFERENT champion always fires, regardless of champ-select-follow state", () => {
    markAutoExported("items", 103, "bot");
    expect(shouldAutoExportForLane("items", 7, "bot")).toBe(true);
  });

  it("LANE FLIP on the SAME champion re-fires when still in champ select and the client agrees (the live bug fix)", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);
    markAutoExported("items", 103, "bot");

    expect(shouldAutoExportForLane("items", 103, "support")).toBe(true); // Senna Bot -> Support
    markAutoExported("items", 103, "support");
    expect(shouldAutoExportForLane("items", 103, "support")).toBe(false); // already applied for Support
  });

  it("LANE FLIP A -> B -> A each re-fires ('latest wins', sequence-based)", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);

    expect(shouldAutoExportForLane("runes", 103, "bot")).toBe(true);
    markAutoExported("runes", 103, "bot");

    expect(shouldAutoExportForLane("runes", 103, "support")).toBe(true);
    markAutoExported("runes", 103, "support");

    // Back to bot -- differs from the most recently applied (support) -> re-fires.
    expect(shouldAutoExportForLane("runes", 103, "bot")).toBe(true);
  });

  it("a SAME-(champ,lane) re-render (e.g. a rank-bracket change re-fetching the same build) does NOT re-fire", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);
    markAutoExported("items", 103, "mid");
    expect(shouldAutoExportForLane("items", 103, "mid")).toBe(false);
  });

  it("does NOT re-fire a lane flip when NOT currently in champ select (browsing an old pick post-game)", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);
    markAutoExported("items", 103, "bot");

    noteCompanionPhase("InProgress"); // champ select ended -- isCompanionDrivenChampion(103) would still be true today
    expect(isInChampSelect()).toBe(false);
    expect(shouldAutoExportForLane("items", 103, "support")).toBe(false);
  });

  it("does NOT re-fire a lane flip when the client's live champ-select session has moved to a DIFFERENT champion", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);
    markAutoExported("items", 103, "bot");

    setCurrentChampSelectChampionId(7); // user has since hovered/locked someone else in the real client
    expect(shouldAutoExportForLane("items", 103, "support")).toBe(false);
  });

  it("current champ-select championId getter/setter round-trip, cleared outside ChampSelect", () => {
    expect(getCurrentChampSelectChampionId()).toBeNull();
    setCurrentChampSelectChampionId(103);
    expect(getCurrentChampSelectChampionId()).toBe(103);
    noteCompanionPhase("InProgress");
    expect(getCurrentChampSelectChampionId()).toBeNull();
  });

  it("bumps the phase epoch and clears applied state exactly once per ChampSelect ENTRY", () => {
    const epoch0 = getChampSelectPhaseEpoch();
    noteCompanionPhase("Lobby");
    expect(getChampSelectPhaseEpoch()).toBe(epoch0); // not ChampSelect -- no bump

    noteCompanionPhase("ChampSelect");
    const epoch1 = getChampSelectPhaseEpoch();
    expect(epoch1).toBe(epoch0 + 1);
    markAutoExported("runes", 103, "mid");

    // Still in ChampSelect on the next poll -- no re-bump, state persists.
    noteCompanionPhase("ChampSelect");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1);
    expect(shouldAutoExportForLane("runes", 103, "mid")).toBe(false);

    // Leaves ChampSelect (game starts) -- no bump on exit itself.
    noteCompanionPhase("InProgress");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1);

    // A LATER champ-select (next game) bumps again and clears applied state
    // -- the same champion is eligible to auto-export again.
    noteCompanionPhase("ChampSelect");
    expect(getChampSelectPhaseEpoch()).toBe(epoch1 + 1);
    expect(shouldAutoExportForLane("runes", 103, "mid")).toBe(true);
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
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(true);
  });

  it("first claim succeeds, a second claim within the TTL for the SAME key fails", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(true);
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(false);
  });

  it("different championId/kind/epoch/laneId are independent locks", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(true);
    expect(tryClaimAutoExportLock("items", 1, 103, "mid")).toBe(true); // different kind
    expect(tryClaimAutoExportLock("runes", 1, 7, "mid")).toBe(true); // different championId
    expect(tryClaimAutoExportLock("runes", 2, 103, "mid")).toBe(true); // different epoch
    expect(tryClaimAutoExportLock("runes", 1, 103, "bot")).toBe(true); // different laneId -- a lane flip's lock must not be starved by the OLD lane's lock (v0.35.0)
  });
});
