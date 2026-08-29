// ---------------------------------------------------------------------------
// compFinalization.ts -- decides WHEN the one permitted comp-driven item-set
// overwrite happens during a champ select.
//
// IT REPLACES compReexportGate.ts, which was a stability window plus a budget:
// a decision had to survive two consecutive 1s polls, and at most two
// comp-driven re-exports were allowed per draft. That shape existed because the
// comp signal could legitimately change many times as enemies locked in, so the
// question was "how many of those changes may we act on". The question is
// different now. There is exactly ONE moment worth writing at -- the end of
// champ select, when the enemy comp is complete and can no longer change -- so
// the gate is a trigger, not a budget, and a window that measures whether a
// flicker survives two ticks has nothing left to protect.
//
// WHY A GATE AT ALL, unchanged from that module: every export is a
// WHOLE-DOCUMENT PUT to the LCU. The bridge replaces the entire item-set file,
// which measured 61,060 bytes across 62 sets on a real account, and the write is
// all-or-nothing (an oversize payload took out every CoachBuild set at once in
// v0.46.0). `/status` polls at 1s inside champ select and `theirTeam` carries
// hovering picks via pickIntent, so the raw enemy list changes constantly.
//
// THE SIGNAL IS ALREADY ON THE WIRE. `champSelect.timerPhase` has been part of
// the /status contract since companion v1.4.0 and desktop wire 1.13.0
// (WireContracts.cs, `[JsonPropertyName("timerPhase")]`, read from the LCU
// session's `timer.phase`), and companionClient.ts already normalises it. So
// this needs no desktop release and no new field.
//
// PURE. Three small functions over an explicit state value, no singleton, no
// clock, no storage. The production singleton wraps these in
// champSelectFollowState.ts, so the policy can be tested without a browser and
// the wiring can be tested without a policy.
// ---------------------------------------------------------------------------

import { normalizeDraftEnemyIds } from "./draftLiveSync";
import { MIN_ENEMIES_FOR_PLAN } from "@/lib/enemyComp/scenarios";

/**
 * How long a full enemy comp must hold before the FALLBACK trigger fires.
 *
 * Only reachable when `timerPhase` is missing or unrecognised, i.e. when the
 * phase is genuinely unobservable -- an older companion, or a queue whose
 * session carries no timer at all. Longer than the 1s champ-select poll on
 * purpose, so the comp has to survive at least three consecutive ticks and a
 * single stray hover can never reach a write.
 *
 * If the game starts before this elapses, the baseline export (the one the
 * champion's own resolution already triggered) stands. That is the documented
 * acceptable outcome, and it is strictly better than writing a comp that is
 * still moving.
 */
export const FINAL_COMP_STABLE_MS = 3000;

/** LCU champ-select timer phases that mean picking is OVER. `GAME_STARTING` is
 *  included because a status tick can land there before we ever saw
 *  `FINALIZATION` -- a short finalization window plus a dropped poll is enough,
 *  and treating it as "too late" would silently lose the write on exactly the
 *  drafts that ran fast. */
export const FINALIZATION_PHASES: ReadonlySet<string> = new Set(["FINALIZATION", "GAME_STARTING"]);

/** Phases that mean finalization is STILL COMING.
 *
 *  This set is what makes the trigger correct in draft, and it is the clause
 *  most likely to be deleted by someone tidying. Champion TRADES happen during
 *  FINALIZATION, so a comp that looks complete during BAN_PICK can still change
 *  who is on it. Firing the fallback then would export a comp that is about to
 *  be wrong, and the budget of one write means there would be no second chance
 *  to correct it. */
export const PRE_FINALIZATION_PHASES: ReadonlySet<string> = new Set(["PLANNING", "BAN_PICK"]);

export interface FinalizationState {
  /** The full enemy comp currently being watched for stability, as a stable
   *  key, or null when there is not a full one. */
  pendingComp: string | null;
  /** When `pendingComp` was first observed. The window is measured from here. */
  pendingSince: number;
  /** True once the one permitted overwrite has happened this champ select. */
  written: boolean;
}

export const initialFinalizationState: FinalizationState = Object.freeze({
  pendingComp: null,
  pendingSince: 0,
  written: false,
});

export interface FinalizationDecision {
  allow: boolean;
  /** Human-readable, and LOGGED verbatim on every decision that leads to a
   *  write. A re-export appearing in companion.log with no reason beside it is
   *  indistinguishable from a bug, which is the state the auto-export path was
   *  already in once before. */
  reason: string;
}

/** The comp as one stable string. Order-insensitive by construction (sorted),
 *  because a `theirTeam` array that reshuffles between polls without changing
 *  membership is the same comp and must not restart the window. */
function compKey(enemyIds: readonly number[]): string | null {
  const enemies = normalizeDraftEnemyIds(enemyIds);
  if (enemies.length < MIN_ENEMIES_FOR_PLAN) return null;
  return [...enemies].sort((a, b) => a - b).join(",");
}

/** Call on EVERY poll tick with the current enemy list. Restarts the stability
 *  window only when the comp genuinely changed, so a comp that holds across many
 *  ticks keeps its original `pendingSince` and ages normally. An incomplete comp
 *  clears the window rather than freezing it -- a fifth enemy leaving and
 *  rejoining is a new comp to measure. */
export function observeComp(
  state: FinalizationState,
  enemyIds: readonly number[],
  now: number
): FinalizationState {
  const key = compKey(enemyIds);
  if (state.pendingComp === key) return state;
  return { ...state, pendingComp: key, pendingSince: key === null ? 0 : now };
}

/**
 * Read-only. May the one comp-driven overwrite happen right now?
 *
 * The order of the clauses is the design:
 *
 *   1. Already written this champ select -> no. This is what pins the worst
 *      case at TWO whole-document PUTs (the baseline export plus this one).
 *   2. The comp is not complete -> no. The block does not exist for an
 *      incomplete comp either (resolveForThisGamePlan returns null), so the
 *      content rule and the timing rule agree by construction.
 *   3. The timer says picking is over -> YES. The strict, preferred path, and
 *      the one that actually fires on every modern client.
 *   4. The timer says finalization is still coming -> no, WAIT for it. See
 *      PRE_FINALIZATION_PHASES.
 *   5. No usable timer phase at all -> fall back to comp stability.
 */
export function canWriteFinalExport(
  state: FinalizationState,
  snapshot: { timerPhase: string | null; enemyChampionIds: readonly number[] },
  now: number
): FinalizationDecision {
  if (state.written) {
    return { allow: false, reason: "final export already written this champ select" };
  }

  const enemies = normalizeDraftEnemyIds(snapshot.enemyChampionIds);
  if (enemies.length < MIN_ENEMIES_FOR_PLAN) {
    return {
      allow: false,
      reason: `enemy comp incomplete (${enemies.length} of ${MIN_ENEMIES_FOR_PLAN})`,
    };
  }

  // Upper-cased and trimmed because it is an upstream string arriving through
  // three hops (LCU -> bridge -> browser) and a case change upstream must not
  // silently turn the strict path into the fallback path.
  const phase = (snapshot.timerPhase ?? "").trim().toUpperCase();

  if (FINALIZATION_PHASES.has(phase)) {
    return { allow: true, reason: `champ select reached ${phase}, enemy comp complete` };
  }
  if (PRE_FINALIZATION_PHASES.has(phase)) {
    return { allow: false, reason: `timer phase ${phase}: finalization is still coming` };
  }

  const key = compKey(snapshot.enemyChampionIds);
  if (key === null || state.pendingComp !== key) {
    return { allow: false, reason: "no timer phase, and this comp has not been observed yet" };
  }
  const held = now - state.pendingSince;
  if (held < FINAL_COMP_STABLE_MS) {
    return {
      allow: false,
      reason: `no timer phase; comp held ${held}ms, needs ${FINAL_COMP_STABLE_MS}ms`,
    };
  }
  return {
    allow: true,
    reason: `no timer phase reported; full enemy comp stable for ${held}ms`,
  };
}

/** Spend the one permitted write. Call only after an export actually happened. */
export function commitFinalExport(state: FinalizationState): FinalizationState {
  return { ...state, written: true };
}
