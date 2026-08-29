// ---------------------------------------------------------------------------
// compReexportGate.ts -- decides WHEN a changed enemy-comp signal is allowed to
// trigger a second item-set export during one champ select.
//
// WHY A GATE AT ALL. Every export is a WHOLE-DOCUMENT PUT to the LCU: the
// bridge replaces the entire item-set file, which measured 61,060 bytes across
// 62 sets on a real account, and the write is all-or-nothing (an oversize
// payload took out every CoachBuild set at once in v0.46.0). The `/status` poll
// runs at 1s inside champ select, and `theirTeam` carries hovering picks via
// pickIntent, so the raw enemy list changes constantly during bans and picks.
// Keying a re-export off that list directly would turn one draft into dozens of
// full-document writes.
//
// TWO THINGS MAKE THAT SAFE, and they are different:
//   1. The KEY is the DERIVED decision (`compSignalKey`), not the enemy list.
//      Two more enemies locking in that do not change what we would export
//      produce the same key and therefore no write at all. This is where almost
//      all of the reduction comes from.
//   2. This gate adds a STABILITY WINDOW and a BUDGET on top, for the residual
//      case where the derived decision itself flickers (a hovered pick that
//      moves the aggregate across a threshold and back).
//
// PURE. Three small functions over an explicit state value, no singleton, no
// clock, no storage. The production singleton wraps these in
// champSelectFollowState.ts, so the policy can be tested without a browser and
// the wiring can be tested without a policy.
// ---------------------------------------------------------------------------

/** How long one derived decision must hold before it may cause a write.
 *
 *  Strictly greater than the 1s champ-select poll interval, which is the whole
 *  point: at 1s ticks a decision has to survive at least two consecutive polls,
 *  so a single stray tick (one hovered pick that briefly tips the aggregate)
 *  can never reach a write. 1500ms rather than, say, 1100ms so the rule still
 *  holds if the poll interval drifts under load or a tick is dropped by a
 *  throttled background tab. */
export const SIGNAL_STABILITY_MS = 1500;

/** How many comp-driven re-exports one champ select may produce, on top of the
 *  one export the champion's own resolution already triggers.
 *
 *  Two, because a real draft resolves the enemy comp in roughly two meaningful
 *  steps (enough picks to clear a threshold, then the last picks confirming or
 *  flipping it), and because the cost of being wrong here is paid in
 *  whole-document writes to the user's live client. A third write during one
 *  draft buys very little and the budget is the backstop for a rules change
 *  that turns out noisier than measured. Worst case per champ select is
 *  therefore 1 + 2 = 3 writes. */
export const MAX_COMP_REEXPORTS_PER_CHAMP_SELECT = 2;

export interface CompGateState {
  /** The signal key currently being watched for stability. */
  pendingKey: string | null;
  /** When `pendingKey` was first observed. The window is measured from here. */
  pendingSince: number;
  /** Comp-driven re-exports already spent this champ select. */
  reexports: number;
}

export const initialCompGateState: CompGateState = Object.freeze({
  pendingKey: null,
  pendingSince: 0,
  reexports: 0,
});

export interface CompGateDecision {
  allow: boolean;
  /** Human-readable, and LOGGED verbatim on every decision that leads to a
   *  write. A re-export that appears in companion.log with no reason beside it
   *  is indistinguishable from a bug, which is the state the auto-export path
   *  was already in once before. */
  reason: string;
}

/** Call on EVERY poll tick with the current derived key. Restarts the stability
 *  window only when the key genuinely changed, so a decision that holds across
 *  many ticks keeps its original `pendingSince` and ages normally. */
export function observeCompSignal(state: CompGateState, key: string, now: number): CompGateState {
  if (state.pendingKey === key) return state;
  return { ...state, pendingKey: key, pendingSince: now };
}

/**
 * Read-only. Whether `key` may cause a write right now.
 *
 * `lastExportedKey` is the signal key of the most recent export for THIS
 * champion and lane, or null when nothing has been exported for it yet.
 */
export function canCompReexport(
  state: CompGateState,
  key: string,
  now: number,
  lastExportedKey: string | null
): CompGateDecision {
  // The champion's own resolution already triggers an export and this gate has
  // no business delaying it. Whatever signal is current at that moment simply
  // rides along, which is why an early draft usually exports with "none".
  if (lastExportedKey === null) {
    return { allow: true, reason: `first export for this champion and lane, signal ${key}` };
  }
  if (key === lastExportedKey) {
    return { allow: false, reason: `signal unchanged (${key})` };
  }
  if (state.reexports >= MAX_COMP_REEXPORTS_PER_CHAMP_SELECT) {
    return {
      allow: false,
      reason: `budget exhausted: ${MAX_COMP_REEXPORTS_PER_CHAMP_SELECT} comp re-exports already used this champ select`,
    };
  }
  // Defensive: a caller that never observed this key has no window to measure,
  // and treating that as "stable" would skip the whole point of the gate.
  if (state.pendingKey !== key) {
    return { allow: false, reason: `signal ${key} not yet observed` };
  }
  const held = now - state.pendingSince;
  if (held < SIGNAL_STABILITY_MS) {
    return {
      allow: false,
      reason: `signal ${key} held ${held}ms, needs ${SIGNAL_STABILITY_MS}ms`,
    };
  }
  return {
    allow: true,
    reason: `comp signal ${lastExportedKey} -> ${key}, stable for ${held}ms`,
  };
}

/** Spend one unit of budget. Call only after an export actually happened. */
export function commitCompReexport(state: CompGateState): CompGateState {
  return { ...state, reexports: state.reexports + 1 };
}
