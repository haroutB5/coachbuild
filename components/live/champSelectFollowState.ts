// ─────────────────────────────────────────────────────────────────────────────
// champSelectFollowState.ts — v1.3.0 attached-tab live-follow fold-in;
// v0.35.0 generalized to include LANE in the dedup key.
//
// Generalizes auto-export dedup from "once per deep-link page load" to
// "once per (champ-select session, championId, laneId, kind)": with the
// companion no longer opening a new tab on every hover (see companion.ps1's
// Test-CompanionHasAttachedTab), the SAME tab now live-follows the user's
// hovers within one champ-select — hover A should export for A, hover B
// for B, re-hovering A should NOT re-export. `kind` ("items" | "runes")
// keeps the two auto-export features' dedup independent, since a user can
// toggle one on and the other off. A per-mount ref can't express any of
// this (it's one component instance persisting across many champion
// changes), so this is a small module-level singleton instead: app/page.tsx's
// status poll calls noteCompanionPhase() every tick (bumping the epoch and
// clearing state whenever phase transitions INTO ChampSelect);
// BuildTabContent's auto-export effects check/mark per (kind, championId,
// laneId) against the CURRENT epoch's state.
//
// v0.35.0 (user on-device evidence): the ORIGINAL dedup keyed on championId
// ALONE — a USER LANE CHANGE mid-champ-select (e.g. Senna Bot -> Support,
// same champion, same companion-driven session) never re-fired, because
// hasAppliedForChampion("items"/"runes", championId) was already true from
// the FIRST lane's export. The game was left on the OLD lane's build. Fixed
// by tracking, per kind, the single most recently exported (championId,
// laneId) pair (shouldAutoExportForLane/markAutoExported below) rather than
// an ever-growing "have we ever done this championId" Set — see that
// function's own doc comment for why this "latest wins" model is both the
// simplest AND the correct one (handles a same-champion A -> B -> A lane
// bounce correctly, re-firing on every genuine change).
//
// Also tracks WHICH championIds were reached via a companion signal at all
// (the initial deep link, or a later live-follow update) — as opposed to a
// transient fallback-champion render — via markCompanionDriven/
// isCompanionDrivenChampion. This is the generalized form of the P1 audit
// fix (wrong-champion race): app/page.tsx marks a championId the moment it
// ACTUALLY applies it (deep link OR live-follow), so BuildTabContent's
// auto-export effects never fire against a transient default/fallback
// champion that was never a real companion signal. (The OLDER
// isAutoExportEligibleBuild guard this superseded was deleted in Round B,
// 2026-07-21 — see autoExportShared.ts's own deletion note and git history
// for the original implementation, if this needs revisiting.)
//
// v0.35.0 also tracks the companion's OWN live champ-select resolution
// (currentChampSelectChampionId, fed every poll tick by app/page.tsx via
// champSelectFollow.ts's resolveCurrentChampSelectChampionId) — used to
// gate a same-champion LANE re-fire against a champion the user is just
// browsing after champ select has already moved on or ended (companion-
// driven marking alone doesn't expire until the NEXT champ-select entry).
//
// Deliberately a plain singleton (not React state) — it's cross-cutting
// bookkeeping two otherwise-unrelated components (page.tsx, BuildTabContent)
// both need to read/write, not view-model state either one of them owns.
// ─────────────────────────────────────────────────────────────────────────────

export type AutoExportKind = "items" | "runes";

interface AppliedLaneRecord {
  championId: number;
  laneId: string;
}

let phaseEpoch = 0;
let lastApplied: Record<AutoExportKind, AppliedLaneRecord | null> = { items: null, runes: null };
let companionDrivenChampionIds = new Set<number>();
let lastPhase: string | null = null;
let currentChampSelectChampionId: number | null = null;
let lastFollowedChampSelectChampionId: number | null = null;

/** Call on every companion /status poll. Bumps the epoch (and clears
 *  per-epoch state) exactly once per ChampSelect ENTRY — i.e. transitioning
 *  from any other phase INTO ChampSelect — so a champion re-picked in a
 *  LATER champ-select (a different game) is eligible to auto-export again,
 *  while re-hovering it within the SAME champ-select is not. Also clears
 *  currentChampSelectChampionId back to null the moment phase is anything
 *  OTHER than ChampSelect — see that field's own doc comment. */
export function noteCompanionPhase(phase: string): void {
  if (phase === "ChampSelect" && lastPhase !== "ChampSelect") {
    phaseEpoch += 1;
    lastApplied = { items: null, runes: null };
    companionDrivenChampionIds = new Set();
    lastFollowedChampSelectChampionId = null;
  }
  lastPhase = phase;
  if (phase !== "ChampSelect") currentChampSelectChampionId = null;
}

export function getChampSelectPhaseEpoch(): number {
  return phaseEpoch;
}

/** Whether the companion currently reports phase === "ChampSelect" — the
 *  most recent value noteCompanionPhase() was called with. */
export function isInChampSelect(): boolean {
  return lastPhase === "ChampSelect";
}

/** The champion currently resolved by the companion's OWN live champ-select
 *  session (its cellChampionId -> pickIntent -> actionChampionId priority —
 *  see champSelectFollow.ts's resolveCurrentChampSelectChampionId, the exact
 *  helper this is fed from). Null outside ChampSelect or before anything has
 *  resolved yet. Set by app/page.tsx's status-poll tick on EVERY tick,
 *  regardless of whether the resolved champion differs from what the page
 *  is currently showing (unlike resolveChampSelectFollow, which only
 *  returns a value when something SHOULD change) — this is a plain live
 *  mirror of "what does the client currently say," used below to gate a
 *  same-champion lane re-fire against an old companion-driven pick the user
 *  is merely browsing after champ select moved on or ended. */
export function setCurrentChampSelectChampionId(championId: number | null): void {
  currentChampSelectChampionId = championId;
}

export function getCurrentChampSelectChampionId(): number | null {
  return currentChampSelectChampionId;
}

/** Round-B P2 fix — "follow-fights-user": app/page.tsx's live-follow effect
 *  used to gate re-assertion on "does the resolved champ-select champion
 *  differ from whatever the page is CURRENTLY SHOWING" (resolveChampSelectFollow's
 *  own currentChampionId check). That re-fires on EVERY poll tick once a
 *  user manually browses to a different champion mid-champ-select, since
 *  the shown champion (now the user's browse target) permanently diverges
 *  from the unchanged champ-select champion — snapping the view back every
 *  3s and making manual browsing during champ select unusable.
 *
 *  Fixed by tracking the last champ-select championId the follow effect
 *  actually acted on (below), and re-asserting ONLY when THAT changes — a
 *  genuine new hover/lock, never a manual browse away from an unchanged
 *  champ-select champion. A manual browse now persists until the real
 *  champ-select pick changes, at which point the follow fires exactly once
 *  for the new champion (matching the pre-fix "first assert" behavior). */
export function shouldFollowChampSelectChange(championId: number): boolean {
  return championId !== lastFollowedChampSelectChampionId;
}

export function markFollowedChampSelectChampion(championId: number): void {
  lastFollowedChampSelectChampionId = championId;
}

/** v0.35.0 — the auto-export dedup decision. Replaces the old
 *  "hasAppliedForChampion" ever-growing Set (championId-only) with a single
 *  most-recently-applied (championId, laneId) pair per kind: fire whenever
 *  the CURRENT pair differs from it.
 *
 *  - Never applied this epoch at all -> true (first-ever export; the
 *    caller's OWN isCompanionDrivenChampion gate — unchanged — still
 *    applies before this is ever consulted).
 *  - Applied before, but for a DIFFERENT champion -> true. (A genuinely new
 *    companion-driven champion is always eligible; nothing to compare
 *    lanes against.)
 *  - Applied before for the SAME champion and the SAME lane -> false.
 *    Already done, nothing changed.
 *  - Applied before for the SAME champion but a DIFFERENT lane -> a genuine
 *    lane flip (the bug this generalization fixes). Re-fire ONLY when the
 *    client's own live champ-select session still agrees this exact
 *    champion is what's locked/hovered right now (isInChampSelect() +
 *    getCurrentChampSelectChampionId() match) — without this extra check,
 *    browsing back to an old companion-driven pick after champ select has
 *    ENDED (isCompanionDrivenChampion doesn't expire until the NEXT
 *    champ-select entry) and flipping ITS lane would also incorrectly
 *    re-export.
 *
 *  "Latest wins" (a single pair, not a per-championId lane map) also
 *  correctly handles a same-champion lane bounce A -> B -> A: each flip
 *  differs from whatever was most recently applied, so each re-fires. */
export function shouldAutoExportForLane(kind: AutoExportKind, championId: number, laneId: string): boolean {
  const last = lastApplied[kind];
  if (!last) return true;
  if (last.championId !== championId) return true;
  if (last.laneId === laneId) return false;
  return isInChampSelect() && getCurrentChampSelectChampionId() === championId;
}

export function markAutoExported(kind: AutoExportKind, championId: number, laneId: string): void {
  lastApplied[kind] = { championId, laneId };
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
  lastApplied = { items: null, runes: null };
  companionDrivenChampionIds = new Set();
  lastPhase = null;
  currentChampSelectChampionId = null;
  lastFollowedChampSelectChampionId = null;
}

const AUTO_EXPORT_LOCK_TTL_MS = 30000;

/** Cheap multi-tab dedupe: before auto-exporting, claim a localStorage lock
 *  keyed by (kind, phase epoch, championId, laneId) so two open tabs (the
 *  original + one the user opened manually) don't both fire the same write.
 *  laneId joined the key in v0.35.0 alongside the dedup generalization above
 *  — without it, a lock claimed for one lane could wrongly starve a
 *  legitimate re-fire for a DIFFERENT lane on the same champion within the
 *  same 30s window. Writes are merge-safe on the companion side regardless
 *  (item-sets merge logic, rune CoachBuild-page replacement) — this is
 *  waste-avoidance, not a correctness requirement. Fails OPEN (returns true,
 *  proceed) on any storage error/SSR — best-effort only. */
export function tryClaimAutoExportLock(
  kind: AutoExportKind,
  phaseEpoch: number,
  championId: number,
  laneId: string
): boolean {
  if (typeof window === "undefined") return true;
  try {
    const storageKey = `coachbuild:autoExport:${kind}:${phaseEpoch}:${championId}:${laneId}`;
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
