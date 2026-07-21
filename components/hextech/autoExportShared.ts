// ─────────────────────────────────────────────────────────────────────────────
// autoExportShared.ts — generalized gate logic shared by BOTH auto-export
// features (item sets AND runes, v1.3.0). Originally lived only in
// itemSetsApply.ts as item-sets-specific names; extracted here once runes
// needed the exact same "should this even attempt a probe+apply" decision
// and "don't export against a transient fallback-champion build" guard.
// itemSetsApply.ts and runeAutoApply.ts both re-export thin wrappers around
// these so existing call sites/tests keep their original names.
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoApplyGateInput {
  /** True iff parseLiveDeepLink(window.location.search) returned non-null
   *  for THIS page load — role-less deep links (custom/blind-pick/ARAM)
   *  count too; only championId's presence matters here, not role. Also
   *  true for a live-follow-triggered champion change (see
   *  champSelectFollow.ts) even without an actual URL deep link, since
   *  that's an equally deliberate "this is the champion to export for"
   *  signal from the companion's own champ-select session. */
  isDeepLink: boolean;
  autoEnabled: boolean;
  session: string | null;
  port: number | null;
  /** One-shot guard for THIS specific attempt (a ref, or a
   *  hasAppliedForChampion() check from champSelectFollowState.ts) — the
   *  caller decides what "already fired" means for its own dedup model. */
  alreadyFired: boolean;
}

/** Pure decision of whether an auto-export effect should even ATTEMPT a
 *  companion probe + apply. Kept separate from the async probe/apply
 *  itself so "no session -> never", "toggle off -> never", "not a deep
 *  link -> never", and "already fired -> never" are each independently
 *  unit-testable without mounting React or mocking fetch. */
export function shouldAutoExport(input: AutoApplyGateInput): boolean {
  if (input.alreadyFired) return false;
  if (!input.isDeepLink) return false;
  if (!input.autoEnabled) return false;
  if (!input.session || !input.port) return false;
  return true;
}

// isAutoExportEligibleBuild (the P1, Fable audit 2026-07-20, wrong-champion
// race guard) was DELETED in Round B (2026-07-21) — repo-wide grep confirmed
// zero call sites in components/hextech/BuildTabContent.tsx or anywhere else
// in the live decision chain; it had been kept only for its own pinned
// regression tests since the v1.3.0 rewrite (see git history for the
// original implementation/reasoning if this needs revisiting). The race it
// guarded against is closed structurally today by
// champSelectFollowState.ts's isCompanionDrivenChampion instead.
