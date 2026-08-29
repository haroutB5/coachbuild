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
/** The champion an in-progress follow attempt is resolving right now (see
 *  beginFollowAttempt). Distinct from lastFollowedChampSelectChampionId so a
 *  failed/superseded attempt can be retried instead of being permanently
 *  recorded as done. */
let followAttemptInFlightChampionId: number | null = null;

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
    followAttemptInFlightChampionId = null;
  }
  lastPhase = phase;
  if (phase !== "ChampSelect") {
    currentChampSelectChampionId = null;
    // Cleared in lockstep with the champion id: a stale enemy comp outliving
    // champ select would label a block for a game that already ended.
    currentEnemyChampionIds = [];
  }
}

/** The enemy champion ids the companion currently reports for champ select,
 *  deduped and capped, or [] outside champ select.
 *
 *  WHY IT LIVES HERE rather than being threaded through the four call sites
 *  that can trigger an item-set write. Those four (the manual "Add to client"
 *  button, the Pro card's apply, the OTP card's apply, and the champ-select
 *  auto-export) already share ONE apply path, and giving each of them its own
 *  way to answer "who are the enemies" is how they would come to answer
 *  differently. This is the same singleton, with the same lifecycle, that
 *  already holds `currentChampSelectChampionId` for exactly the same reason,
 *  written by the same CompanionProvider tick.
 *
 *  Enemy CHAMPIONS only, from champ select, which is information the player can
 *  already see before the game starts. Nothing here touches what anyone buys. */
let currentEnemyChampionIds: number[] = [];

export function setCurrentEnemyChampionIds(ids: readonly number[]): void {
  currentEnemyChampionIds = [...ids];
}

export function getCurrentEnemyChampionIds(): number[] {
  return currentEnemyChampionIds;
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
  return championId !== lastFollowedChampSelectChampionId && championId !== followAttemptInFlightChampionId;
}

/** v0.111.0 — DO NOT reintroduce "mark, then apply."
 *
 *  The bug (reproduced on 2026-08-18 in scripts/bench-champselect.mjs, and
 *  reported live the same day as "I picked Volibear and the Builds page still
 *  showed Wukong"): app/page.tsx's follow effect used to call
 *  markFollowedChampSelectChampion() BEFORE its `/api/champions` fetch, and the
 *  effect's own cleanup cancelled that fetch on EVERY dependency change — which
 *  includes the very first re-render after mount, because the restored
 *  "last champion you looked at" sets `activeLane` in the same commit. So the
 *  application was thrown away while the champion stayed marked as already
 *  followed, and shouldFollowChampSelectChange() then refused to ever retry it.
 *  The page sat on the previous champion for the rest of champ select.
 *
 *  It was invisible in the common case: the defect only fires when the restored
 *  lane DIFFERS from the page's initial lane. Bench, same build, only that lane
 *  changed — restored on "top": never followed (20s timeout); restored on "mid":
 *  followed in 109ms.
 *
 *  The gate is now three-valued: not-yet-attempted, in flight, applied. An
 *  attempt that is superseded or fails ABANDONS (back to not-yet-attempted, so
 *  the next poll tick retries); only a real application COMMITS. The "in flight"
 *  leg is what still stops a 3s (now 1s) poll from stacking a duplicate fetch
 *  every tick, which is the whole reason the mark existed before the fetch. */
export function beginFollowAttempt(championId: number): boolean {
  if (!shouldFollowChampSelectChange(championId)) return false;
  followAttemptInFlightChampionId = championId;
  return true;
}

/** The attempt actually applied the champion to the page. From here a manual
 *  browse away is respected until the champ-select champion genuinely changes
 *  (the Round-B P2 contract above, unchanged). */
export function commitFollowAttempt(championId: number): void {
  if (followAttemptInFlightChampionId === championId) followAttemptInFlightChampionId = null;
  lastFollowedChampSelectChampionId = championId;
}

/** The attempt did NOT apply — superseded by a newer champ-select champion, an
 *  unresolvable id, a network failure, or an unmount. Clears only the in-flight
 *  leg, deliberately leaving the champion eligible again: the alternative is the
 *  exact silent-permanent-loss this whole gate was rewritten to remove. */
export function abandonFollowAttempt(championId: number): void {
  if (followAttemptInFlightChampionId === championId) followAttemptInFlightChampionId = null;
}

/** Forgets that the current champ-select champion was ever followed, so the
 *  next poll tick re-applies it. Backs the "jump back to my champ-select pick"
 *  affordance on the TopBar chip: after a manual browse the follow deliberately
 *  stands down until the pick changes, and this is the user's way to ask for it
 *  back without waiting for that. */
export function resumeChampSelectFollow(): void {
  lastFollowedChampSelectChampionId = null;
  followAttemptInFlightChampionId = null;
}

/** Whether the page has already applied this champ-select champion — the read
 *  side of the same flag, for UI that wants to show "following" vs "jump back".
 *  Never mutates. */
export function hasFollowedChampSelectChampion(championId: number): boolean {
  return championId === lastFollowedChampSelectChampionId;
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
  followAttemptInFlightChampionId = null;
}

const AUTO_EXPORT_LOCK_TTL_MS = 30000;

/** One key per KIND, not one key per (kind, champion, lane) — see the
 *  2026-08-19 note on `tryClaimAutoExportLock`. */
const autoExportLockKey = (kind: AutoExportKind) => `coachbuild:autoExport:last:${kind}`;

/** Keys written by the pre-2026-08-19 per-pair scheme
 *  (`coachbuild:autoExport:items:3:mid`). Nothing reads them any more, and a
 *  user who has been through a few hundred champ selects has a few hundred of
 *  them. Distinguishable from the current key by its third segment: `last` is
 *  not a kind. */
const LEGACY_AUTO_EXPORT_LOCK_PREFIX = /^coachbuild:autoExport:(items|runes):/;
let legacyLocksPruned = false;

function pruneLegacyAutoExportLocks(): void {
  if (legacyLocksPruned) return;
  legacyLocksPruned = true;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && LEGACY_AUTO_EXPORT_LOCK_PREFIX.test(key)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Best-effort housekeeping; never a reason to skip an export.
  }
}

/** Cheap multi-tab dedupe: before auto-exporting, check the shared record of
 *  what was LAST exported for this kind, so two open tabs (the original + one
 *  the companion or the user opened) don't both fire the same write. Fails
 *  OPEN (returns true, proceed) on any storage error/SSR — best-effort only.
 *
 *  ── 2026-08-19: THIS WAS A 30-SECOND COOLDOWN, AND IT SHOWED ─────────────
 *  Reported: *"for like 20s the runes didnt change as i switched to udyr then
 *  went back to galio quickly. It stayed on udyr runes but changed after a
 *  while."* Their companion.log, verbatim: `apply-runes` at 14:30:29 and
 *  14:30:31, then nothing until **14:30:59** — a 28-second gap ending, to the
 *  second, at the TTL boundary below.
 *
 *  The old key was `coachbuild:autoExport:<kind>:<champion>:<lane>` and was
 *  written on claim and never released. So Galio -> Udyr -> Galio inside 30s
 *  found Galio's own key still warm and returned false, every poll tick, until
 *  it expired. The client was left holding Udyr's runes the whole time.
 *
 *  That directly contradicted the in-document dedup two functions up, which
 *  documents "latest wins ... correctly handles a same-champion lane bounce
 *  A -> B -> A: each flip differs from whatever was most recently applied, so
 *  each re-fires." `shouldAutoExportForLane` said fire; this said no. The
 *  in-document one is right, and this is now the same rule, shared across
 *  tabs: ONE key per kind holding the most recently exported (champion, lane).
 *
 *  Fire iff the stored pair differs from the pair being asked about. So:
 *    - A -> B -> A: the record reads B when A comes back, so A re-fires on the
 *      NEXT POLL TICK rather than at the TTL.
 *    - two tabs, same pair, same moment: the second reads the first's record
 *      and stands down — the case this function exists for, unchanged.
 *
 *  Releasing the key on completion instead would have been the other obvious
 *  shape and is WRONG here: the second tab's next tick would find it released,
 *  still have nothing in its own `lastApplied`, and write the same set again.
 *  A completion RECORD is what dedupes tabs; a mutex is not.
 *
 *  The TTL survives only as a staleness bound on that record (a tab that
 *  crashed mid-apply, a record from an old game). It no longer gates a
 *  legitimate re-fire, because a re-fire always carries a different pair.
 *
 *  v0.101.0: the phase EPOCH is not part of the key and the parameter is
 *  ignored. The epoch is a counter this MODULE increments, and the module is
 *  per document — a tab opened mid-champ-select starts at 0 and reaches 1 on
 *  its first poll, while a tab that has been open for five games is at 5. Two
 *  tabs in the same champ select therefore wrote two different keys and the
 *  lock deduped nothing across exactly the case it exists for. The parameter
 *  stays in the signature so call sites and the injected-dep test seam don't
 *  churn. */
export function tryClaimAutoExportLock(
  kind: AutoExportKind,
  _phaseEpoch: number,
  championId: number,
  laneId: string
): boolean {
  if (typeof window === "undefined") return true;
  try {
    pruneLegacyAutoExportLocks();
    const storageKey = autoExportLockKey(kind);
    const now = Date.now();
    const existing = window.localStorage.getItem(storageKey);
    if (existing) {
      const record = JSON.parse(existing) as { championId?: unknown; laneId?: unknown; at?: unknown };
      const at = typeof record?.at === "number" ? record.at : Number.NaN;
      if (
        record?.championId === championId &&
        record?.laneId === laneId &&
        Number.isFinite(at) &&
        now - at < AUTO_EXPORT_LOCK_TTL_MS
      ) {
        return false;
      }
    }
    window.localStorage.setItem(storageKey, JSON.stringify({ championId, laneId, at: now }));
    return true;
  } catch {
    return true;
  }
}

/** Test-only: the legacy-key prune is a once-per-document side effect, and a
 *  vitest worker is one document for the whole file. */
export function resetAutoExportLockPrune(): void {
  legacyLocksPruned = false;
}
