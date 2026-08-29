import { describe, it, expect } from "vitest";
import {
  initialCompGateState,
  observeCompSignal,
  canCompReexport,
  commitCompReexport,
  SIGNAL_STABILITY_MS,
  MAX_COMP_REEXPORTS_PER_CHAMP_SELECT,
  type CompGateState,
} from "../live/compReexportGate";

/** Drives the gate the way the poll does: one observation per tick, then ask. */
function run(
  ticks: Array<{ key: string; at: number }>,
  lastExported: string | null,
  state: CompGateState = initialCompGateState
) {
  let s = state;
  let exported = lastExported;
  const fired: Array<{ at: number; key: string; reason: string }> = [];
  for (const t of ticks) {
    s = observeCompSignal(s, t.key, t.at);
    const d = canCompReexport(s, t.key, t.at, exported);
    if (d.allow) {
      fired.push({ at: t.at, key: t.key, reason: d.reason });
      s = commitCompReexport(s);
      exported = t.key;
    }
  }
  return { fired, state: s, exported };
}

/** A 1s champ-select poll, which is the real cadence (v0.111.0). */
function ticksAt1s(keys: string[], startMs = 0) {
  return keys.map((key, i) => ({ key, at: startMs + i * 1000 }));
}

describe("the first export is not comp-gated", () => {
  it("allows immediately when nothing has been exported for this champion and lane", () => {
    const { fired } = run(ticksAt1s(["none"]), null);
    expect(fired).toHaveLength(1);
    expect(fired[0].reason).toMatch(/first export/i);
  });
});

describe("hovers cannot trigger a write", () => {
  it("a signal that flickers every tick never becomes stable, so nothing fires", () => {
    // The failure this gate exists to prevent. `theirTeam` carries pickIntent,
    // so during bans and picks the derived decision can change on consecutive
    // 1s polls. Each change restarts the stability window, so a flickering
    // signal never reaches it.
    const flicker = ticksAt1s(["cc:3111", "none", "cc:3111", "none", "cc:3111", "none", "cc:3111"]);
    const { fired } = run(flicker, "none");
    expect(fired).toEqual([]);
  });

  it("fires exactly once when a changed signal then holds", () => {
    const keys = ["none", "cc:3111", "cc:3111", "cc:3111", "cc:3111"];
    const { fired } = run(ticksAt1s(keys), "none");
    expect(fired).toHaveLength(1);
    // Held from t=1000; at 1s polls the first tick at or past 1000+1500 is 3000.
    expect(fired[0].at).toBe(3000);
    expect(fired[0].reason).toMatch(/none -> cc:3111/);
  });

  it("needs strictly more than one poll interval, so one stray tick is not enough", () => {
    expect(SIGNAL_STABILITY_MS).toBeGreaterThan(1000);
  });
});

describe("the budget caps writes per champ select", () => {
  it("stops after the cap even when the signal keeps genuinely changing", () => {
    const keys = [
      "none",
      ...Array(4).fill("cc:3111"),
      ...Array(4).fill("damage-ap:3111"),
      ...Array(4).fill("damage-ad:3047"),
      ...Array(4).fill("cc:3173"),
    ];
    const { fired } = run(ticksAt1s(keys), "none");
    expect(fired.length).toBe(MAX_COMP_REEXPORTS_PER_CHAMP_SELECT);
    expect(fired.length).toBeLessThan(4);
  });

  it("says WHY it refused once the budget is spent", () => {
    let s = initialCompGateState;
    for (let i = 0; i < MAX_COMP_REEXPORTS_PER_CHAMP_SELECT; i++) s = commitCompReexport(s);
    s = observeCompSignal(s, "cc:3111", 0);
    const d = canCompReexport(s, "cc:3111", 99999, "none");
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/budget/i);
  });
});

describe("an unchanged signal is never a write", () => {
  it("refuses when the key equals what was already exported, however long it holds", () => {
    const { fired } = run(ticksAt1s(Array(30).fill("cc:3111")), "cc:3111");
    expect(fired).toEqual([]);
  });

  it("a signal that changes and changes BACK before stabilising writes nothing", () => {
    // A -> B -> A inside the window. The end state equals what is already
    // exported, so there is nothing to write even though the key moved twice.
    const { fired } = run(ticksAt1s(["cc:3111", "none", "cc:3111"]), "cc:3111");
    expect(fired).toEqual([]);
  });
});

describe("worst case over a realistic draft at the 1s champ-select poll", () => {
  it("never exceeds the cap, across an adversarial 90-tick draft", () => {
    // 90 seconds of champ select at 1s polls, with the derived signal changing
    // as adversarially as the rules permit: a different decision every other
    // tick, which is faster than five real picks could ever move it.
    const keys: string[] = [];
    const cycle = ["none", "cc:3111", "damage-ap:3111", "damage-ad:3047", "cc:3173"];
    for (let i = 0; i < 90; i++) keys.push(cycle[Math.floor(i / 2) % cycle.length]);
    const { fired } = run(ticksAt1s(keys), "none");
    expect(fired.length).toBeLessThanOrEqual(MAX_COMP_REEXPORTS_PER_CHAMP_SELECT);
  });

  it("worst case is exactly the cap, and that is the number to quote", () => {
    // The realistic bad case: the comp resolves in two genuine steps, each
    // holding long enough to be real. This is the maximum number of
    // comp-driven whole-document PUTs one champ select can produce.
    const keys = [
      ...Array(5).fill("none"),
      ...Array(5).fill("damage-ad:3047"),
      ...Array(5).fill("cc:3111"),
      ...Array(5).fill("damage-ap:3173"),
    ];
    const { fired } = run(ticksAt1s(keys), "none");
    expect(fired).toHaveLength(MAX_COMP_REEXPORTS_PER_CHAMP_SELECT);
    expect(MAX_COMP_REEXPORTS_PER_CHAMP_SELECT).toBe(2);
    // Plus the one export the champion resolution itself triggers, which is
    // not comp-gated: three writes per champ select, worst case.
  });
});

describe("partial comps", () => {
  it("treats going from a real decision back to none as a change worth writing", () => {
    // An enemy is swapped out and the comp stops clearing the threshold. The
    // exported block still says `vs CC` and is now wrong, so reverting it is
    // exactly as important as setting it.
    const { fired } = run(ticksAt1s(["none", "none", "none", "none"]), "cc:3111");
    expect(fired).toHaveLength(1);
    expect(fired[0].key).toBe("none");
    expect(fired[0].reason).toMatch(/cc:3111 -> none/);
  });
});

describe("state handling", () => {
  it("observeCompSignal restarts the window only when the key actually changes", () => {
    let s = observeCompSignal(initialCompGateState, "cc:3111", 1000);
    s = observeCompSignal(s, "cc:3111", 2000);
    s = observeCompSignal(s, "cc:3111", 3000);
    expect(s.pendingSince).toBe(1000);
    s = observeCompSignal(s, "none", 4000);
    expect(s.pendingSince).toBe(4000);
  });

  it("is pure: no call mutates the state handed to it", () => {
    const before = JSON.stringify(initialCompGateState);
    observeCompSignal(initialCompGateState, "cc:3111", 10);
    canCompReexport(initialCompGateState, "cc:3111", 10, "none");
    commitCompReexport(initialCompGateState);
    expect(JSON.stringify(initialCompGateState)).toBe(before);
  });
});
