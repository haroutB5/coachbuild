import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldAutoExportForLane,
  markAutoExported,
  tryClaimAutoExportLock,
  getLastAppliedSignalKey,
  observeFinalCompTick,
  decideFinalExport,
  noteFinalExportWritten,
  recordAutoExportDecision,
  getAutoExportDecisions,
  hasWrittenFinalExport,
  noteCompanionPhase,
  setCurrentChampSelectChampionId,
  markCompanionDriven,
  resetChampSelectFollowState,
} from "../live/champSelectFollowState";
import { FINAL_COMP_STABLE_MS } from "../live/compFinalization";

const CHAMP = 412; // Thresh
const LANE = "support";

/** A full enemy comp and a partial one, as real champion ids. */
const FULL = [16, 266, 99, 112, 51];
const PARTIAL = [16, 266, 99];
/** The same five with one swapped -- a champion TRADE during finalization. */
const TRADED = [16, 266, 99, 112, 238];

/** The derived key the exporter would compute for a given comp. Kept crude on
 *  purpose: this file tests the STORES and the TRIGGER, not the plan, and a
 *  real `forThisGameKey` here would couple two lanes of change together. */
const keyFor = (comp: readonly number[]) =>
  comp.length < 5 ? "none" : `ftg:${[...comp].sort((a, b) => a - b).join("+")}`;

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

interface Tick {
  /** What the LCU champ-select timer reports, or null for a queue/companion
   *  that does not report one. */
  timerPhase: string | null;
  enemies: readonly number[];
}

/** Drives ONE poll tick exactly as AutoExporter does, through the real stores
 *  and the real trigger, and reports whether an item-set write happened. */
function tick(t: Tick, now: number): { wrote: boolean; reason: string } {
  const liveKey = keyFor(t.enemies);
  observeFinalCompTick(t.enemies, now);
  const lastKey = getLastAppliedSignalKey("items", CHAMP, LANE);
  const decision = decideFinalExport(
    { timerPhase: t.timerPhase, enemyChampionIds: t.enemies },
    now
  );
  // The BASELINE export is never gated -- see AutoExporter's own comment.
  const effective = lastKey === null || decision.allow ? liveKey : lastKey;

  const inDocument = shouldAutoExportForLane("items", CHAMP, LANE, effective);
  const crossTab = tryClaimAutoExportLock("items", 1, CHAMP, LANE, effective);

  // THE INVARIANT. These are two implementations of one rule and they have
  // disagreed in production before (the 2026-08-19 cooldown, measured at 29.4s).
  // Asserted on EVERY tick of every sequence in this file, not once -- and it
  // matters more now than it did: with only ONE permitted comp-driven write per
  // draft, a disagreement does not merely delay the write, it loses it.
  expect(crossTab, `stores disagreed at ${now}ms on key ${effective}`).toBe(inDocument);

  if (inDocument) {
    markAutoExported("items", CHAMP, LANE, effective);
    if (lastKey !== null && effective !== lastKey) noteFinalExportWritten();
    recordAutoExportDecision(`wrote ${effective}: ${decision.reason}`);
    return { wrote: true, reason: decision.reason };
  }
  return { wrote: false, reason: decision.reason };
}

/** One champ select at the real 1s champ-select poll cadence. */
function draft(ticks: Tick[]) {
  const writes: Array<{ at: number; reason: string }> = [];
  ticks.forEach((t, i) => {
    const at = i * 1000;
    const r = tick(t, at);
    if (r.wrote) writes.push({ at, reason: r.reason });
  });
  return writes;
}

/** A realistic ranked draft: bans, picks trickling in, finalization, then the
 *  game starting. 90 ticks at 1s, which is longer than any real champ select. */
function realisticDraft(): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < 10; i++) out.push({ timerPhase: "PLANNING", enemies: [] });
  for (let i = 0; i < 20; i++) out.push({ timerPhase: "BAN_PICK", enemies: PARTIAL });
  // The full comp is visible for a long time BEFORE finalization. This is the
  // window a naive "five enemies are showing" trigger would fire in.
  for (let i = 0; i < 30; i++) out.push({ timerPhase: "BAN_PICK", enemies: FULL });
  for (let i = 0; i < 25; i++) out.push({ timerPhase: "FINALIZATION", enemies: FULL });
  for (let i = 0; i < 5; i++) out.push({ timerPhase: "GAME_STARTING", enemies: FULL });
  return out;
}

describe("worst-case whole-document PUTs per champ select", () => {
  it("a 90-tick draft produces exactly TWO writes, and never three", () => {
    // The number to quote. One baseline export from the champion's own
    // resolution, which is never gated, plus the ONE comp-driven overwrite at
    // the end of champ select. Every write here is a whole-document LCU PUT.
    const writes = draft(realisticDraft());
    expect(writes).toHaveLength(2);
    expect(writes[0].at).toBe(0);
    expect(writes[1].reason).toContain("FINALIZATION");
  });

  it("the second write lands at FINALIZATION, not when the comp first completes", () => {
    // 30 seconds separate the two on a real draft. Firing at t=30s would export
    // a comp that can still be traded away.
    const writes = draft(realisticDraft());
    expect(writes[1].at).toBe(60_000);
  });

  it("a champion TRADE during finalization is still covered", () => {
    // The whole reason PRE_FINALIZATION_PHASES exists. The comp visible during
    // BAN_PICK is not the comp that plays the game.
    const ticks = realisticDraft();
    for (let i = 60; i < ticks.length; i++) ticks[i] = { ...ticks[i], enemies: TRADED };
    const writes = draft(ticks);
    expect(writes).toHaveLength(2);
    expect(getLastAppliedSignalKey("items", CHAMP, LANE)).toBe(keyFor(TRADED));
  });

  it("hover flicker alone produces exactly ONE write, the un-gated baseline", () => {
    const flicker: Tick[] = Array.from({ length: 40 }, (_, i) => ({
      timerPhase: "BAN_PICK",
      enemies: i % 2 ? FULL : PARTIAL,
    }));
    const writes = draft(flicker);
    expect(writes).toHaveLength(1);
    expect(writes[0].at).toBe(0);
  });

  it("a draft that never reaches finalization writes once, and that is fine", () => {
    // The user dodges, or the client closes. The baseline export stands.
    const writes = draft(Array.from({ length: 60 }, () => ({ timerPhase: "BAN_PICK", enemies: FULL })));
    expect(writes).toHaveLength(1);
  });

  it("a comp that never changes after the baseline writes ONCE, not twice", () => {
    // The baseline already carried the full comp (the app was opened late), so
    // the finalization tick would write byte-identical bytes. The key dedupe is
    // what stops it, independently of the trigger.
    const ticks: Tick[] = [
      ...Array.from({ length: 10 }, () => ({ timerPhase: "BAN_PICK", enemies: FULL })),
      ...Array.from({ length: 10 }, () => ({ timerPhase: "FINALIZATION", enemies: FULL })),
    ];
    expect(draft(ticks)).toHaveLength(1);
    expect(hasWrittenFinalExport()).toBe(false);
  });
});

describe("the fallback fires only when the phase is unobservable", () => {
  it("blind pick / an older companion: writes after the stability window", () => {
    const ticks: Tick[] = [
      ...Array.from({ length: 5 }, () => ({ timerPhase: null, enemies: PARTIAL })),
      ...Array.from({ length: 20 }, () => ({ timerPhase: null, enemies: FULL })),
    ];
    const writes = draft(ticks);
    expect(writes).toHaveLength(2);
    // First full-comp tick is at 5s; the window is 3s, so the earliest allowed
    // tick is 8s.
    expect(writes[1].at).toBe(5000 + FINAL_COMP_STABLE_MS);
    expect(writes[1].reason).toContain("no timer phase reported");
  });

  it("never fires while a real phase says finalization is coming", () => {
    const ticks: Tick[] = Array.from({ length: 30 }, () => ({
      timerPhase: "BAN_PICK",
      enemies: FULL,
    }));
    expect(draft(ticks)).toHaveLength(1);
  });

  it("if the game starts before the window elapses, the baseline stands", () => {
    const ticks: Tick[] = [
      ...Array.from({ length: 5 }, () => ({ timerPhase: null, enemies: PARTIAL })),
      { timerPhase: null, enemies: FULL },
      { timerPhase: null, enemies: FULL },
    ];
    expect(draft(ticks)).toHaveLength(1);
  });
});

describe("champ-select entry resets the trigger", () => {
  it("a second draft gets its own write and its own log", () => {
    draft(realisticDraft());
    expect(hasWrittenFinalExport()).toBe(true);
    expect(getAutoExportDecisions().length).toBeGreaterThan(0);

    noteCompanionPhase("InProgress");
    noteCompanionPhase("ChampSelect");
    expect(hasWrittenFinalExport()).toBe(false);
    // A log spanning two drafts reads as one, which is worse than no log.
    expect(getAutoExportDecisions()).toEqual([]);

    setCurrentChampSelectChampionId(CHAMP);
    markCompanionDriven(CHAMP);
    expect(draft(realisticDraft())).toHaveLength(2);
  });
});

describe("runes are never re-exported by a comp change", () => {
  it("a comp change leaves the runes dedup untouched", () => {
    markAutoExported("runes", CHAMP, LANE, "none");
    expect(shouldAutoExportForLane("runes", CHAMP, LANE, "none")).toBe(false);
    draft(realisticDraft());
    expect(shouldAutoExportForLane("runes", CHAMP, LANE, "none")).toBe(false);
  });
});

describe("every write is logged with its reason", () => {
  it("records a reason for each write, naming why it was allowed", () => {
    draft(realisticDraft());
    const log = getAutoExportDecisions();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/enemy comp incomplete/);
    expect(log[1]).toMatch(/FINALIZATION/);
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
    expect(tryClaimAutoExportLock("items", 1, CHAMP, LANE, keyFor(FULL))).toBe(true);
  });
});
