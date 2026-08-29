import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldAutoExportForLane,
  markAutoExported,
  tryClaimAutoExportLock,
  getLastAppliedSignalKey,
  observeCompSignalTick,
  decideCompReexport,
  noteCompReexportCommitted,
  recordAutoExportDecision,
  getAutoExportDecisions,
  getCompGateState,
  noteCompanionPhase,
  setCurrentChampSelectChampionId,
  markCompanionDriven,
  resetChampSelectFollowState,
} from "../live/champSelectFollowState";
import { MAX_COMP_REEXPORTS_PER_CHAMP_SELECT } from "../live/compReexportGate";

const CHAMP = 412; // Thresh
const LANE = "support";

/** A localStorage stub, because the cross-tab store is the whole point here
 *  and a no-op would make the two stores trivially "agree". */
function installStorage() {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return map;
}

beforeEach(() => {
  resetChampSelectFollowState();
  installStorage();
  noteCompanionPhase("Lobby");
  noteCompanionPhase("ChampSelect");
  setCurrentChampSelectChampionId(CHAMP);
  markCompanionDriven(CHAMP);
});

/** Drives ONE poll tick exactly as AutoExporter does, through the real stores,
 *  and reports whether an item-set write happened. */
function tick(liveKey: string, now: number): { wrote: boolean; reason: string } {
  observeCompSignalTick(liveKey, now);
  const lastKey = getLastAppliedSignalKey("items", CHAMP, LANE);
  const decision = decideCompReexport(liveKey, lastKey, now);
  const effective = decision.allow ? liveKey : lastKey ?? liveKey;

  const inDocument = shouldAutoExportForLane("items", CHAMP, LANE, effective);
  const crossTab = tryClaimAutoExportLock("items", 1, CHAMP, LANE, effective);

  // THE INVARIANT. These are two implementations of one rule and they have
  // disagreed in production before (the 2026-08-19 cooldown, measured at 29.4s).
  // Asserted on EVERY tick of every sequence in this file, not once.
  expect(crossTab, `stores disagreed at ${now}ms on key ${effective}`).toBe(inDocument);

  if (inDocument) {
    markAutoExported("items", CHAMP, LANE, effective);
    if (lastKey !== null && effective !== lastKey) noteCompReexportCommitted();
    recordAutoExportDecision(`wrote ${effective}: ${decision.reason}`);
    return { wrote: true, reason: decision.reason };
  }
  return { wrote: false, reason: decision.reason };
}

/** One champ select at the real 1s champ-select poll cadence. */
function draft(keys: string[]) {
  const writes: Array<{ at: number; reason: string }> = [];
  keys.forEach((key, i) => {
    const at = i * 1000;
    const r = tick(key, at);
    if (r.wrote) writes.push({ at, reason: r.reason });
  });
  return writes;
}

describe("the two dedup stores answer identically, tick by tick", () => {
  it("agrees across a draft where the comp resolves in two genuine steps", () => {
    const writes = draft([
      ...Array(4).fill("none"),
      ...Array(6).fill("damage-ad:3047"),
      ...Array(6).fill("cc:3111"),
    ]);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("agrees across a draft of pure hover flicker", () => {
    const flicker = Array.from({ length: 40 }, (_, i) => (i % 2 ? "cc:3111" : "none"));
    draft(flicker);
  });

  it("agrees when the same key repeats for a long time", () => {
    draft(Array(60).fill("cc:3111"));
  });
});

describe("worst-case whole-document PUTs per champ select", () => {
  it("a 90-second draft at the 1s poll produces at most 1 + the budget", () => {
    // The number to quote. One export from the champion's own resolution, which
    // is never comp-gated, plus at most MAX_COMP_REEXPORTS_PER_CHAMP_SELECT
    // comp-driven re-exports. Every write here is a whole-document LCU PUT.
    const cycle = ["none", "cc:3111", "damage-ap:3111", "damage-ad:3047", "cc:3173"];
    const keys = Array.from({ length: 90 }, (_, i) => cycle[Math.floor(i / 3) % cycle.length]);
    const writes = draft(keys);
    expect(writes.length).toBeLessThanOrEqual(1 + MAX_COMP_REEXPORTS_PER_CHAMP_SELECT);
    expect(writes.length).toBe(3);
  });

  it("hover flicker alone produces exactly ONE write, the un-gated first one", () => {
    const flicker = Array.from({ length: 40 }, (_, i) => (i % 2 ? "cc:3111" : "none"));
    const writes = draft(flicker);
    expect(writes).toHaveLength(1);
    expect(writes[0].at).toBe(0);
    expect(writes[0].reason).toMatch(/first export/i);
  });

  it("a comp that never changes produces exactly ONE write across a whole draft", () => {
    expect(draft(Array(120).fill("cc:3111"))).toHaveLength(1);
  });

  it("the budget is spent only by comp re-exports, never by the first export", () => {
    draft(Array(10).fill("none"));
    expect(getCompGateState().reexports).toBe(0);
  });
});

describe("champ-select entry resets the budget", () => {
  it("a second draft gets its own allowance and its own log", () => {
    const cycle = ["none", "cc:3111", "damage-ap:3111", "damage-ad:3047"];
    draft(Array.from({ length: 40 }, (_, i) => cycle[Math.floor(i / 4) % cycle.length]));
    expect(getCompGateState().reexports).toBe(MAX_COMP_REEXPORTS_PER_CHAMP_SELECT);
    expect(getAutoExportDecisions().length).toBeGreaterThan(0);

    noteCompanionPhase("InProgress");
    noteCompanionPhase("ChampSelect");
    expect(getCompGateState().reexports).toBe(0);
    // A log spanning two drafts reads as one, which is worse than no log.
    expect(getAutoExportDecisions()).toEqual([]);
  });
});

describe("runes are never re-exported by a comp change", () => {
  it("a comp change leaves the runes dedup untouched", () => {
    markAutoExported("runes", CHAMP, LANE, "none");
    expect(shouldAutoExportForLane("runes", CHAMP, LANE, "none")).toBe(false);
    // Even after the items side has churned through its whole budget.
    draft([...Array(4).fill("none"), ...Array(6).fill("cc:3111"), ...Array(6).fill("damage-ad:3047")]);
    expect(shouldAutoExportForLane("runes", CHAMP, LANE, "none")).toBe(false);
  });
});

describe("every write is logged with its reason", () => {
  it("records a reason for each write, naming the transition", () => {
    draft([...Array(4).fill("none"), ...Array(6).fill("cc:3111")]);
    const log = getAutoExportDecisions();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/first export/i);
    expect(log[1]).toMatch(/none -> cc:3111/);
    expect(log[1]).toMatch(/stable for \d+ms/);
  });
});

describe("a pre-0.119.0 cross-tab record does not cause a spurious write", () => {
  it("treats a stored record with no signalKey as `none`", () => {
    // A record written by a tab running the previous build, mid champ select,
    // across the deploy. Reading it as a mismatch would fire one extra
    // whole-document write per open tab for no reason.
    const map = installStorage();
    map.set(
      "coachbuild:autoExport:last:items",
      JSON.stringify({ championId: CHAMP, laneId: LANE, at: Date.now() })
    );
    expect(tryClaimAutoExportLock("items", 1, CHAMP, LANE, "none")).toBe(false);
    expect(tryClaimAutoExportLock("items", 1, CHAMP, LANE, "cc:3111")).toBe(true);
  });
});
