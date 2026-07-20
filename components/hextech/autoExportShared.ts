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

/** Guards against the wrong-champion race (P1, Fable audit 2026-07-20): a
 *  deep-link tab can render its FIRST successful `build` for a FALLBACK
 *  champion (BuildTabContent's own default, e.g. Viktor) before
 *  app/page.tsx's own /api/champions lookup resolves and swaps in the
 *  actual target champion. If the caller consumes its one-shot "already
 *  exported" tracking against that fallback build, the real champion's
 *  export can be silently skipped or (worse) the wrong champion gets
 *  runes/items written. Returns false ("not yet eligible — wait for the
 *  matching build") only when a specific target championId is known and
 *  doesn't match the build in hand; true when there's no specific target
 *  at all (nothing to race against) or the champion already matches. */
export function isAutoExportEligibleBuild(parsed: { championId: number } | null, buildChampionId: number): boolean {
  if (!parsed) return true;
  return parsed.championId === buildChampionId;
}
