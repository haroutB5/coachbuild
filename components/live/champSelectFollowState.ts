// ─────────────────────────────────────────────────────────────────────────────
// champSelectFollowState.ts — v1.3.0 attached-tab live-follow fold-in.
//
// Generalizes auto-export dedup from "once per deep-link page load" to
// "once per (champ-select session, championId, kind)": with the companion
// no longer opening a new tab on every hover (see companion.ps1's
// Test-CompanionHasAttachedTab), the SAME tab now live-follows the user's
// hovers within one champ-select — hover A should export for A, hover B
// for B, re-hovering A should NOT re-export. `kind` ("items" | "runes")
// keeps the two auto-export features' dedup independent, since a user can
// toggle one on and the other off. A per-mount ref can't express any of
// this (it's one component instance persisting across many champion
// changes), so this is a small module-level singleton instead: app/page.tsx's
// status poll calls noteCompanionPhase() every tick (bumping the epoch and
// clearing state whenever phase transitions INTO ChampSelect);
// BuildTabContent's auto-export effects check/mark per (kind, championId)
// against the CURRENT epoch's state.
//
// Also tracks WHICH championIds were reached via a companion signal at all
// (the initial deep link, or a later live-follow update) — as opposed to a
// transient fallback-champion render — via markCompanionDriven/
// isCompanionDrivenChampion. This is the generalized form of the P1 audit
// fix (wrong-champion race): app/page.tsx marks a championId the moment it
// ACTUALLY applies it (deep link OR live-follow), so BuildTabContent's
// auto-export effects never fire against a transient default/fallback
// champion that was never a real companion signal.
//
// Deliberately a plain singleton (not React state) — it's cross-cutting
// bookkeeping two otherwise-unrelated components (page.tsx, BuildTabContent)
// both need to read/write, not view-model state either one of them owns.
// ─────────────────────────────────────────────────────────────────────────────

export type AutoExportKind = "items" | "runes";

let phaseEpoch = 0;
let appliedKeys = new Set<string>();
let companionDrivenChampionIds = new Set<number>();
let lastPhase: string | null = null;

/** Call on every companion /status poll. Bumps the epoch (and clears
 *  per-epoch state) exactly once per ChampSelect ENTRY — i.e. transitioning
 *  from any other phase INTO ChampSelect — so a champion re-picked in a
 *  LATER champ-select (a different game) is eligible to auto-export again,
 *  while re-hovering it within the SAME champ-select is not. */
export function noteCompanionPhase(phase: string): void {
  if (phase === "ChampSelect" && lastPhase !== "ChampSelect") {
    phaseEpoch += 1;
    appliedKeys = new Set();
    companionDrivenChampionIds = new Set();
  }
  lastPhase = phase;
}

export function getChampSelectPhaseEpoch(): number {
  return phaseEpoch;
}

function key(kind: AutoExportKind, championId: number): string {
  return `${kind}:${championId}`;
}

export function hasAppliedForChampion(kind: AutoExportKind, championId: number): boolean {
  return appliedKeys.has(key(kind, championId));
}

export function markAppliedForChampion(kind: AutoExportKind, championId: number): void {
  appliedKeys.add(key(kind, championId));
}

/** Marks that `championId` was reached via an ACTUAL companion signal
 *  (app/page.tsx's deep-link mount effect, or its live-follow poll) — never
 *  called for a manual sidebar search or a transient fallback/default
 *  champion. */
export function markCompanionDriven(championId: number): void {
  companionDrivenChampionIds.add(championId);
}

export function isCompanionDrivenChampion(championId: number): boolean {
  return companionDrivenChampionIds.has(championId);
}

/** Test-only reset — module-level singleton state would otherwise leak
 *  between test cases in the same vitest worker. */
export function resetChampSelectFollowState(): void {
  phaseEpoch = 0;
  appliedKeys = new Set();
  companionDrivenChampionIds = new Set();
  lastPhase = null;
}

const AUTO_EXPORT_LOCK_TTL_MS = 30000;

/** Cheap multi-tab dedupe: before auto-exporting, claim a localStorage lock
 *  keyed by (kind, phase epoch, championId) so two open tabs (the original
 *  + one the user opened manually) don't both fire the same write. Writes
 *  are merge-safe on the companion side regardless (item-sets merge logic,
 *  rune CoachBuild-page replacement) — this is waste-avoidance, not a
 *  correctness requirement. Fails OPEN (returns true, proceed) on any
 *  storage error/SSR — best-effort only. */
export function tryClaimAutoExportLock(kind: AutoExportKind, phaseEpoch: number, championId: number): boolean {
  if (typeof window === "undefined") return true;
  try {
    const storageKey = `coachbuild:autoExport:${kind}:${phaseEpoch}:${championId}`;
    const now = Date.now();
    const existing = window.localStorage.getItem(storageKey);
    if (existing) {
      const at = parseInt(existing, 10);
      if (Number.isFinite(at) && now - at < AUTO_EXPORT_LOCK_TTL_MS) return false;
    }
    window.localStorage.setItem(storageKey, String(now));
    return true;
  } catch {
    return true;
  }
}
