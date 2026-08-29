import { describe, it, expect } from "vitest";
import {
  initialFinalizationState,
  observeComp,
  canWriteFinalExport,
  commitFinalExport,
  FINAL_COMP_STABLE_MS,
  FINALIZATION_PHASES,
  PRE_FINALIZATION_PHASES,
  type FinalizationState,
} from "../live/compFinalization";
import { MIN_ENEMIES_FOR_PLAN } from "@/lib/enemyComp/scenarios";

const FULL = [16, 266, 99, 112, 51];
const FOUR = FULL.slice(0, 4);

const ask = (
  state: FinalizationState,
  timerPhase: string | null,
  enemyChampionIds: readonly number[],
  now = 0
) => canWriteFinalExport(state, { timerPhase, enemyChampionIds }, now);

describe("the strict path: the LCU says picking is over", () => {
  it("fires on FINALIZATION with a full comp", () => {
    const d = ask(initialFinalizationState, "FINALIZATION", FULL);
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("FINALIZATION");
  });

  it("fires on GAME_STARTING too, because a tick can land there first", () => {
    // A short finalization window plus one dropped poll is enough to never see
    // FINALIZATION at all. Treating that as "too late" loses the write on
    // exactly the drafts that ran fast.
    expect(ask(initialFinalizationState, "GAME_STARTING", FULL).allow).toBe(true);
    expect([...FINALIZATION_PHASES].sort()).toEqual(["FINALIZATION", "GAME_STARTING"]);
  });

  it("survives a case or whitespace change upstream", () => {
    // The phase arrives through three hops (LCU -> bridge -> browser). A case
    // change upstream must not silently downgrade the strict path to the
    // fallback -- which would still eventually fire, just later and for the
    // wrong reason, i.e. invisibly.
    expect(ask(initialFinalizationState, " finalization ", FULL).allow).toBe(true);
  });

  it("needs no stability window at all -- the phase IS the signal", () => {
    // The comp cannot change after finalization, so nothing is gained by
    // waiting, and waiting risks the game starting first.
    const fresh = initialFinalizationState;
    expect(fresh.pendingComp).toBeNull();
    expect(ask(fresh, "FINALIZATION", FULL, 0).allow).toBe(true);
  });
});

describe("the clause most likely to be deleted by a tidy-up", () => {
  it("REFUSES during BAN_PICK even with a full comp, because trades happen later", () => {
    // Champion TRADES happen during FINALIZATION, so a comp that looks complete
    // during BAN_PICK can still change who is on it. With a budget of one write
    // there would be no second chance to correct it.
    const d = ask(initialFinalizationState, "BAN_PICK", FULL);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("finalization is still coming");
  });

  it("refuses during PLANNING", () => {
    expect(ask(initialFinalizationState, "PLANNING", FULL).allow).toBe(false);
    expect([...PRE_FINALIZATION_PHASES].sort()).toEqual(["BAN_PICK", "PLANNING"]);
  });

  it("keeps refusing however long the comp has been stable", () => {
    // The fallback window must not leak into the strict path. A comp held for a
    // full minute during BAN_PICK is still a comp that can be traded away.
    let st = observeComp(initialFinalizationState, FULL, 0);
    expect(ask(st, "BAN_PICK", FULL, 60_000).allow).toBe(false);
    st = observeComp(st, FULL, 60_000);
    expect(ask(st, "BAN_PICK", FULL, 120_000).allow).toBe(false);
  });
});

describe("the fallback path: no usable timer phase", () => {
  it("fires only after the comp has held for FINAL_COMP_STABLE_MS", () => {
    const st = observeComp(initialFinalizationState, FULL, 0);
    expect(ask(st, null, FULL, FINAL_COMP_STABLE_MS - 1).allow).toBe(false);
    expect(ask(st, null, FULL, FINAL_COMP_STABLE_MS).allow).toBe(true);
  });

  it("is longer than the 1s champ-select poll, so one stray tick cannot reach it", () => {
    expect(FINAL_COMP_STABLE_MS).toBeGreaterThan(2000);
  });

  it("restarts the window when the comp genuinely changes", () => {
    let st = observeComp(initialFinalizationState, FULL, 0);
    st = observeComp(st, [16, 266, 99, 112, 238], 2000); // Caitlyn -> Zed
    expect(ask(st, null, [16, 266, 99, 112, 238], 4000).allow).toBe(false);
    expect(ask(st, null, [16, 266, 99, 112, 238], 5000).allow).toBe(true);
  });

  it("does NOT restart when the same comp merely reshuffles", () => {
    // `theirTeam` is slot-ordered and a re-hover can reorder it without
    // changing membership. Restarting on that would push the write past the end
    // of champ select on a lively draft.
    let st = observeComp(initialFinalizationState, FULL, 0);
    st = observeComp(st, [...FULL].reverse(), 2000);
    expect(st.pendingSince).toBe(0);
    expect(ask(st, null, [...FULL].reverse(), FINAL_COMP_STABLE_MS).allow).toBe(true);
  });

  it("refuses a comp it has never observed", () => {
    // Defensive: a caller that never observed this comp has no window to
    // measure, and treating that as stable would skip the whole point.
    const d = ask(initialFinalizationState, null, FULL, 999_999);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("has not been observed");
  });

  it("an unrecognised phase takes the fallback rather than being trusted", () => {
    // A queue whose session carries a phase this app has never heard of is the
    // same situation as no phase at all: unobservable.
    const st = observeComp(initialFinalizationState, FULL, 0);
    expect(ask(st, "SOME_NEW_PHASE", FULL, FINAL_COMP_STABLE_MS).allow).toBe(true);
  });
});

describe("an incomplete comp never writes, on any path", () => {
  it("refuses four enemies even at FINALIZATION", () => {
    // The block does not exist for an incomplete comp either
    // (resolveForThisGamePlan returns null), so the content rule and the timing
    // rule agree by construction rather than by coincidence.
    const d = ask(initialFinalizationState, "FINALIZATION", FOUR);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(`enemy comp incomplete (4 of ${MIN_ENEMIES_FOR_PLAN})`);
  });

  it("refuses an empty enemy list", () => {
    expect(ask(initialFinalizationState, "FINALIZATION", []).allow).toBe(false);
  });

  it("normalises through draftLiveSync -- duplicates do not pad a comp", () => {
    expect(ask(initialFinalizationState, "FINALIZATION", [16, 266, 99, 112, 16, 0]).allow).toBe(false);
  });

  it("clears a pending window when the comp stops being complete", () => {
    // A fifth enemy leaving and rejoining is a NEW comp to measure, not a
    // continuation of the old window.
    let st = observeComp(initialFinalizationState, FULL, 0);
    expect(st.pendingComp).not.toBeNull();
    st = observeComp(st, FOUR, 1000);
    expect(st.pendingComp).toBeNull();
    st = observeComp(st, FULL, 2000);
    expect(st.pendingSince).toBe(2000);
    expect(ask(st, null, FULL, 2000 + FINAL_COMP_STABLE_MS - 1).allow).toBe(false);
  });
});

describe("exactly one overwrite per champ select", () => {
  it("refuses everything once the write has happened", () => {
    const st = commitFinalExport(observeComp(initialFinalizationState, FULL, 0));
    for (const phase of ["FINALIZATION", "GAME_STARTING", "BAN_PICK", null, "WHATEVER"]) {
      const d = ask(st, phase, FULL, 999_999);
      expect(d.allow, `phase ${phase}`).toBe(false);
      expect(d.reason).toBe("final export already written this champ select");
    }
  });

  it("the written flag is checked FIRST, before anything else can allow", () => {
    // Order matters: a later clause returning true would make the budget
    // advisory rather than binding.
    const st = commitFinalExport(initialFinalizationState);
    expect(ask(st, "FINALIZATION", FULL).allow).toBe(false);
  });
});

describe("the policy is pure", () => {
  it("never mutates the state it is given", () => {
    const st = observeComp(initialFinalizationState, FULL, 0);
    const before = JSON.stringify(st);
    ask(st, "FINALIZATION", FULL, 5000);
    ask(st, null, FULL, 5000);
    expect(JSON.stringify(st)).toBe(before);
  });

  it("the initial state is frozen, so a caller cannot poison the module", () => {
    expect(Object.isFrozen(initialFinalizationState)).toBe(true);
  });

  it("observing an unchanged comp returns the SAME object", () => {
    // Cheap and idempotent: this runs on every 1s poll tick for a whole draft.
    const st = observeComp(initialFinalizationState, FULL, 0);
    expect(observeComp(st, FULL, 5000)).toBe(st);
  });

  it("every decision carries a reason", () => {
    for (const [state, phase, comp] of [
      [initialFinalizationState, "FINALIZATION", FULL],
      [initialFinalizationState, "BAN_PICK", FULL],
      [initialFinalizationState, null, FULL],
      [initialFinalizationState, "FINALIZATION", FOUR],
      [commitFinalExport(initialFinalizationState), "FINALIZATION", FULL],
    ] as const) {
      const d = ask(state, phase, comp, 0);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});
