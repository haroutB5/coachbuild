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
  shouldFollowChampSelectChange,
  beginFollowAttempt,
  commitFollowAttempt,
  abandonFollowAttempt,
  resumeChampSelectFollow,
  hasFollowedChampSelectChampion,
  resetChampSelectFollowState,
  tryClaimAutoExportLock,
} from "../live/champSelectFollowState";
import { isBuildForLane } from "../hextech/heroContracts";

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

// Round-B P2 "follow-fights-user" fix — app/page.tsx's live-follow effect
// used to re-assert the champ-select champion every poll tick once a user
// manually browsed to a different champion, because it compared the
// resolved champ-select championId against whatever was CURRENTLY SHOWN
// (which the user's manual browse changes) rather than against the last
// champ-select championId the follow effect itself acted on. See
// shouldFollowChampSelectChange's own doc comment.
describe("champSelectFollowState — the follow gate (begin / commit / abandon)", () => {
  beforeEach(() => resetChampSelectFollowState());

  it("fires on the first-ever resolution (nothing followed yet)", () => {
    expect(shouldFollowChampSelectChange(103)).toBe(true);
  });

  it("does not re-fire once the SAME champ-select championId has been followed", () => {
    beginFollowAttempt(103);
    commitFollowAttempt(103);
    expect(shouldFollowChampSelectChange(103)).toBe(false);
  });

  it("a manual browse away does NOT cause a re-fire on the next tick (Round-B P2) -- champ-select championId is unchanged", () => {
    beginFollowAttempt(103);
    commitFollowAttempt(103);
    // User manually browses to champion 7 -- nothing in this module's state
    // changes as a result (app/page.tsx no longer feeds champ.id into this
    // decision at all), so the champ-select champion (still 103) must not
    // re-assert on subsequent ticks.
    expect(shouldFollowChampSelectChange(103)).toBe(false);
    expect(shouldFollowChampSelectChange(103)).toBe(false); // repeated ticks -- still no re-fire
  });

  it("a genuine champ-select champion CHANGE re-fires exactly once", () => {
    beginFollowAttempt(103);
    commitFollowAttempt(103);
    expect(shouldFollowChampSelectChange(7)).toBe(true); // hover/lock moved to a new champion
    beginFollowAttempt(7);
    commitFollowAttempt(7);
    expect(shouldFollowChampSelectChange(7)).toBe(false); // settles again
  });

  it("a fresh ChampSelect epoch clears the last-followed championId too", () => {
    beginFollowAttempt(103);
    commitFollowAttempt(103);
    noteCompanionPhase("ChampSelect");
    expect(shouldFollowChampSelectChange(103)).toBe(true);
  });

  // ── v0.111.0 lost-follow regression ────────────────────────────────────────
  // The live report (2026-08-18): champ select picked Volibear, the Builds page
  // kept showing the previously-viewed Wukong for the whole draft. The old gate
  // was "mark, then apply" — the mark survived an application that never
  // happened, so nothing ever retried.

  it("an in-flight attempt suppresses a duplicate attempt on the next poll tick", () => {
    expect(beginFollowAttempt(106)).toBe(true);
    // The next /status tick arrives while the champion list is still resolving.
    expect(beginFollowAttempt(106)).toBe(false);
    expect(shouldFollowChampSelectChange(106)).toBe(false);
  });

  it("REGRESSION: an attempt that never applied is retried, not recorded as followed", () => {
    expect(beginFollowAttempt(106)).toBe(true);
    // ...the resolution is discarded (superseded render, unmount, network
    // failure). Under the old mark-then-apply gate this champion was gone for
    // the rest of champ select.
    abandonFollowAttempt(106);
    expect(shouldFollowChampSelectChange(106)).toBe(true);
    expect(beginFollowAttempt(106)).toBe(true);
    commitFollowAttempt(106);
    expect(hasFollowedChampSelectChampion(106)).toBe(true);
  });

  it("abandoning a SUPERSEDED attempt never releases the champion that replaced it", () => {
    beginFollowAttempt(106); // Volibear starts resolving
    // Champ select moves to Ahri and that attempt wins the race.
    abandonFollowAttempt(106);
    expect(beginFollowAttempt(103)).toBe(true);
    commitFollowAttempt(103);
    // The late Volibear response now abandons itself. It must not disturb Ahri.
    abandonFollowAttempt(106);
    expect(hasFollowedChampSelectChampion(103)).toBe(true);
    expect(shouldFollowChampSelectChange(103)).toBe(false);
  });

  it("resumeChampSelectFollow re-arms the CURRENT champion after a manual browse", () => {
    beginFollowAttempt(106);
    commitFollowAttempt(106);
    expect(shouldFollowChampSelectChange(106)).toBe(false); // manual browse is respected
    resumeChampSelectFollow(); // user taps the champ-select chip
    expect(shouldFollowChampSelectChange(106)).toBe(true);
    expect(hasFollowedChampSelectChampion(106)).toBe(false);
  });
});

// v0.36.0 — integration-style: replays the EXACT sequence
// BuildTabContent.tsx's effect runs on a real lane flip, using the real
// gate functions (isBuildForLane + shouldAutoExportForLane +
// markAutoExported), to pin "lane flip fires BOTH kinds; a transient
// stale-build/fresh-lane render never blocks the real one." See
// heroContracts.ts's isBuildForLane doc comment for the live bug
// (runes never followed a lane flip) this closes.
describe("lane-flip auto-export sequence (BuildTabContent effect, replayed)", () => {
  beforeEach(() => resetChampSelectFollowState());

  /** Mirrors BuildTabContent's effect body exactly: guard on isBuildForLane
   *  first, then the dedup gate, returning whether an export would actually
   *  be attempted (and marking dedup state exactly as the real effect does
   *  when it does). */
  function runEffect(kind: "items" | "runes", buildRole: number, lane: "bot" | "support", championId: number): boolean {
    if (!isBuildForLane(buildRole, lane)) return false;
    const epoch = getChampSelectPhaseEpoch();
    if (shouldAutoExportForLane(kind, championId, lane) && tryClaimAutoExportLock(kind, epoch, championId, lane)) {
      markAutoExported(kind, championId, lane);
      return true;
    }
    return false;
  }

  it("a genuine lane flip fires BOTH items and runes for the new lane", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);

    // Ashe Bot resolves first (role 3 == "bot").
    expect(runEffect("items", 3, "bot", 103)).toBe(true);
    expect(runEffect("runes", 3, "bot", 103)).toBe(true);

    // User flips to Support; the CORRECT Support build resolves (role 4 == "support").
    expect(runEffect("items", 4, "support", 103)).toBe(true);
    expect(runEffect("runes", 4, "support", 103)).toBe(true);
  });

  it("a transient stale-build/fresh-lane render (build still Bot, lane already Support) is a no-op for BOTH kinds and does NOT block the real export", () => {
    noteCompanionPhase("ChampSelect");
    setCurrentChampSelectChampionId(103);
    runEffect("items", 3, "bot", 103);
    runEffect("runes", 3, "bot", 103);

    // Transient render: state.build.role is STILL 3 (Bot) but `lane` prop
    // already flipped to "support" — isBuildForLane must reject this for
    // BOTH kinds, and neither should touch dedup state.
    expect(runEffect("items", 3, "support", 103)).toBe(false);
    expect(runEffect("runes", 3, "support", 103)).toBe(false);

    // The REAL Support build resolves moments later (role 4 == "support") —
    // must still fire for BOTH kinds, proving the stale render above did
    // NOT consume the dedup slot.
    expect(runEffect("items", 4, "support", 103)).toBe(true);
    expect(runEffect("runes", 4, "support", 103)).toBe(true);
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

  it("different championId/kind/laneId are independent locks", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(true);
    expect(tryClaimAutoExportLock("items", 1, 103, "mid")).toBe(true); // different kind
    expect(tryClaimAutoExportLock("runes", 1, 7, "mid")).toBe(true); // different championId
    expect(tryClaimAutoExportLock("runes", 1, 103, "bot")).toBe(true); // different laneId -- a lane flip's lock must not be starved by the OLD lane's lock (v0.35.0)
  });

  // v0.101.0, the BLOCK direction of the same change: the epoch is a per-
  // DOCUMENT counter, so a tab opened mid-champ-select and a tab that has been
  // open for five games hold different epochs for the identical champ select.
  // While it was in the key, the cross-tab lock deduped nothing in exactly the
  // case it exists for, and each fresh tab re-fired the auto-export -- which is
  // how a user's manual rune edits got overwritten. Same key now, regardless.
  it("the epoch argument does NOT split the lock -- two tabs in one champ select share it", () => {
    stubWindow(makeLocalStorageShim());
    expect(tryClaimAutoExportLock("runes", 1, 103, "mid")).toBe(true);
    expect(tryClaimAutoExportLock("runes", 2, 103, "mid")).toBe(false);
    expect(tryClaimAutoExportLock("runes", 99, 103, "mid")).toBe(false);
  });
});
