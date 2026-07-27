// ─────────────────────────────────────────────────────────────────────────────
// companionClient.ts — browser-side wire client for the companion.ps1 bridge
// (engy owns the .ps1 + the wire contract's server side; this file is the
// contract's CLIENT side — see live-companion-plan.md §5 "WIRE CONTRACT").
//
// Contract (agreed in the plan, mirrored in companion.ps1's own header
// comment): ports [48291,48292,48293]; `?session=<token>` on every
// non-OPTIONS request; exact Origin https://coachbuild.vercel.app (enforced
// server-side, nothing to do here); shapes:
//   GET  /status       -> {version, port, phase, clientConnected,
//                          lastOpen:{championId,roleId|null,at}|null,
//                          champSelect:{localPlayerCellId, cellChampionId|null,
//                            pickIntent|null, actionChampionId|null,
//                            roleId|null}|null (null outside ChampSelect)}
//                          -- v1.5.0: the REQUEST may carry an optional
//                          `&follow=1` (not part of the response shape) to
//                          declare this poller follow-capable. v1.6.0 widens
//                          this to page IDENTITY: `&follow=builds` or
//                          `&follow=draft` — see followKindForRoute's doc
//                          comment below and companion.ps1's
//                          Test-CompanionHasAttachedTab -Kind. A legacy
//                          `follow=1` (pre-1.6.0 cached web build) is treated
//                          server-side as builds-kind (back-compat — see
//                          companion.ps1's /status handler). Omitting it
//                          (older web build, or a non-follow-capable route)
//                          sends no follow param at all. v1.7.0 adds
//                          `&detach=1` ALONGSIDE `follow=<kind>`: the page
//                          declaring it is going away, which CLEARS that
//                          kind's attach stamp server-side instead of
//                          refreshing it (see detachFollow below). An older
//                          companion ignores the unknown param and re-stamps
//                          instead, which pushes its stale-attach window out
//                          by the ~3s since that tab's last poll and no more
//                          — the pre-1.7.0 behaviour, not a new failure mode.
//   GET  /live         -> raw allgamedata passthrough | {error:'no-live'}
//   POST /apply-runes  body {..., mode:'auto'|'manual'} ->
//                          {ok:true, selected, verified, mismatch} |
//                          {ok:false, reason, hint?}
//   POST /apply-itemsets body {championId, sets:ItemSet[], replacePrefix?:string} ->
//                          {ok:true, count} | {ok:false, reason, hint?}
//
// v0.35.0 / companion 1.3.1: `replacePrefix` is an explicit, CHAMP-SCOPED
// (not champ+role-scoped) stale-removal prefix — see itemSetBody.ts's
// champScopedReplacePrefix for why (a lane flip left a stale set for the
// OLD lane behind, since the companion's own title-derived prefix was
// role-scoped). Optional: an older web build omitting it, or an older
// companion that doesn't read it, both fall back to the pre-1.3.1
// title-derived behavior — never a hard requirement either side.
//
// v1.3.0 COMPLIANCE UPDATE: rune writes may now auto-export too, same as
// item sets (both are inert loadout/shop SUGGESTIONS, same class as a
// Blitz/Moba auto-import — see companion.ps1's header for the full
// reasoning). The one bright line that does NOT move: `mode:'auto'` on
// /apply-runes must NEVER delete a rune page the companion doesn't own —
// it only replaces a page it PREVIOUSLY created or uses a free slot; if
// neither is available it returns {reason:'slots-full'} untouched. Manual
// mode (the click-through button) keeps the original consented behavior.
// Both item-set and rune auto-export share the same gate pattern (see
// components/hextech/autoExportShared.ts, used by both itemSetsApply.ts
// and runeAutoApply.ts) and the same toggle convention (AUTO_ITEMSETS_KEY /
// AUTO_RUNES_STORAGE_KEY below, surfaced on /live-setup).
//
// Every network call here is fail-soft (never throws to the caller) and
// takes an injectable `deps.fetchImpl` so companionClient.test.ts can drive
// it with a mocked fetch instead of a real loopback server (the bridge is
// fundamentally untestable off a real gaming PC — see plan §5's
// "Untestable off gaming PC" note).
//
// v0.43.0 diagnosability — user hit "Couldn't add item builds — try again,
// or add them manually in-client" repeatedly on-device and can no longer
// retrieve the companion log, so this round hardens BLIND: every failure
// mode applyItemSets/applyRunes can hit now gets its own classified `hint`
// string (previously several distinct failure modes — a non-2xx HTTP
// status, a malformed-but-2xx body, an ok:false companion response with no
// `hint` field — all fell through to the SAME generic caller-side fallback
// message, indistinguishable from each other and from "the companion
// itself said nothing useful"). See recordCompanionError below for the
// second half: every classified failure is also appended to a small
// rolling localStorage ring buffer so /live-setup can show recent failure
// history on a return visit, even without PowerShell/log access.
// ─────────────────────────────────────────────────────────────────────────────

import { parseLiveSkillState, type LiveSkillState } from "@/lib/nextSkill";

export const COMPANION_PORTS = [48291, 48292, 48293] as const;
export type CompanionPort = (typeof COMPANION_PORTS)[number];

/** Page-level "is there a live game" status poll cadence — deliberately much
 *  slower than the in-game /live poll (LIVE_POLL_MS below); this only needs
 *  to catch a ChampSelect->InProgress transition, not track anything
 *  frame-accurate. */
export const COMPANION_STATUS_POLL_MS = 3000;
/** In-game live-client-data poll cadence. Originally 1000ms (the plan's spec
 *  and the community-established Live Client Data polling norm, research
 *  §B) — slowed to 3000ms in Round-B (P2 "LivePanel churn" fix): the enemy
 *  roster LivePanel derives from this poll is fixed for the whole game (no
 *  champion changes once InProgress), so the extra cadence bought nothing
 *  but a subtree re-render every second, all game. Paired with a
 *  shallow-compare skip in LivePanel.tsx's tick() (belt and braces — there
 *  are no cooldowns/timers derived from this data by design, so neither fix
 *  trades away anything time-sensitive). */
export const LIVE_POLL_MS = 3000;
/** GET /skills poll cadence for the /compact next-ability panel. 1000ms is the
 *  brief's stated ceiling and the community-established Live Client Data norm.
 *  Unlike LIVE_POLL_MS's enemy roster (fixed for the whole game, hence slowed
 *  to 3s), this data changes at every level-up and the panel's entire value is
 *  being right the moment the point lands — 3s would mean a third of the
 *  glances land on stale state. The poll only runs while the companion reports
 *  phase InProgress (see SkillOrderNextPanel), so a closed game costs zero
 *  requests rather than one per second all day. */
export const SKILL_POLL_MS = 1000;

const SESSION_STORAGE_KEY = "coachbuild:companion:session";
const PORT_STORAGE_KEY = "coachbuild:companion:port";
/** Auto-export toggles (v1.3.0: BOTH item sets AND runes may now auto-export
 *  — see this file's header comment for the compliance update). Default ON
 *  the first time a session ever exists (the user explicitly asked for
 *  automatic export) — see getAutoItemSetsEnabled's own doc comment for the
 *  exact default rule; getAutoRunesEnabled mirrors it exactly. */
const AUTO_ITEMSETS_STORAGE_KEY = "coachbuild:companion:autoItemSets";
const AUTO_RUNES_STORAGE_KEY = "coachbuild:companion:autoRunes";

/** The companion's most recent champ-select deep-link open THIS launch —
 *  null until the first one. Diagnostic only (surfaced on /live-setup),
 *  never used to drive any decision client-side. */
export interface CompanionLastOpen {
  championId: number;
  roleId: number | null;
  at: string;
}

/** Diagnostic snapshot of champ-select cell/action resolution — present
 *  only while phase === "ChampSelect" (companion.ps1 nulls it outside that
 *  phase). Lets /live-setup show WHY a champion did/didn't resolve during a
 *  live-reported "nothing opens" investigation, without needing a
 *  screen-share. Never contains a name — only ids. */
export interface CompanionChampSelectSnapshot {
  localPlayerCellId: number;
  cellChampionId: number | null;
  pickIntent: number | null;
  actionChampionId: number | null;
  roleId: number | null;
  /** v1.4.0 (Draft recommender, plan §5) — the enemy team's championId per
   *  slot (>0 only; a hovering-but-unlocked enemy is represented by their
   *  pickIntent in that slot, same "visible info, IDs only, never names"
   *  posture as every other champSelect field here). Absent on a companion
   *  older than 1.4.0 (or outside ChampSelect) degrades to `[]` — an empty
   *  enemy list is indistinguishable from "not reported yet," and /draft's
   *  live-sync (draftLiveSync.ts) already treats an empty array as "nothing
   *  to auto-fill," so this degrades safely without a separate sentinel.
   *  NOT lane-tagged in the wire contract (the LCU champ-select session
   *  doesn't expose the enemy team's assigned positions) — draftLiveSync.ts
   *  infers the direct-lane-opponent as the entry at the SAME index as the
   *  local player's own roleId, the standard convention community overlays
   *  (porofessor/op.gg-style) rely on for ranked/draft queues where both
   *  teams' cell order matches display position; flagged as an off-device
   *  assumption in HANDOFF-fronty.md pending a real-LCU shape check (plan
   *  §8's "real LCU theirTeam shape" verification). */
  theirTeam: number[];
  /** v1.4.0 — champ-select's session timer phase (e.g. "PLANNING", "BAN_PICK",
   *  "FINALIZATION") straight off the LCU session, null outside ChampSelect
   *  or on an older companion that never sends it. Diagnostic/UX only
   *  (nothing in the scoring or live-sync decision path depends on it today)
   *  — never rejects the whole status over a missing/malformed value. */
  timerPhase: string | null;
}

export interface CompanionStatus {
  version: string;
  port: number;
  phase: string;
  clientConnected: boolean;
  /** Absent/malformed on an OLDER companion (pre-1.2.0) degrades to null —
   *  never rejects the whole status over a missing diagnostic field. */
  lastOpen: CompanionLastOpen | null;
  champSelect: CompanionChampSelectSnapshot | null;
  /** v1.2.1+ — ISO timestamp of the most recent gameflow-poll tick,
   *  regardless of whether a real LCU is present. The single most
   *  important diagnostic field: if this is null or stops advancing across
   *  two /status reads, the real-mode loop itself is dead. Absent on an
   *  older companion (pre-1.2.1) degrades to null. */
  lastPollAt: string | null;
  /** v1.2.2 — most recent UNEXPECTED failure message (throttled to ~1 per
   *  60s per distinct failure server-side), e.g. an LCU HTTPS call dying at
   *  the TLS handshake. Never contains the session token or a name. Absent
   *  on an older companion degrades to null. */
  lastError: string | null;
}

/** Result of an apply-runes call — mirrors the wire contract's own
 *  discriminated shape verbatim (no local reinterpretation) so a `reason`/
 *  `hint` string from the companion (e.g. bug #1013's delete-failed path,
 *  or v1.3.0's 'slots-full') reaches the UI unchanged. v1.3.0: a success
 *  now also carries `selected`/`verified`/`mismatch` — the page WAS created
 *  even when `selected` or `verified` come back false (a failed
 *  post-create selection PUT, or a content readback that didn't match what
 *  was sent), so the UI can report that honestly instead of implying full
 *  success on any 2xx. */
export type ApplyRunesResult =
  | { ok: true; selected: boolean; verified: boolean; mismatch: string[] }
  | { ok: false; reason: string; hint?: string };

/** Result of an apply-itemsets call — same discriminated shape convention
 *  as ApplyRunesResult, plus `count` (how many sets were written) on
 *  success. */
export type ApplyItemSetsResult = { ok: true; count: number } | { ok: false; reason: string; hint?: string };

/** Raw Live Client Data passthrough (allgamedata) — deliberately typed as an
 *  open record; components/live/livePanelModel.ts is the ONLY place that
 *  reads specific fields off this, and it reads at most
 *  championName/team/position (see that file's compliance note) — never
 *  hold onto or forward this value beyond that one narrow read. */
export type LiveDataRaw = Record<string, unknown>;
export type LiveResult = LiveDataRaw | { error: string };

export function isLiveError(result: LiveResult): result is { error: string } {
  return typeof (result as { error?: unknown }).error === "string";
}

/** Which failure mode a probe hit. Chrome's Local Network Access block and a
 *  genuine "nothing listening on this port" both surface as the same
 *  `TypeError: Failed to fetch` to JS (by design — the browser doesn't leak
 *  which one it was, see research §E). We can't distinguish them from the
 *  error alone, so the caller's INTENT disambiguates: a `trigger:
 *  "user-click"` probe (the deliberate LNA-prompt moment — /live-setup's
 *  Test Connection button) that still fails is reported as `lna-denied`
 *  (the user just triggered the permission dialog, so a continued failure
 *  most likely means they denied it or it's still pending); a `"passive"`
 *  background probe (e.g. app/page.tsx's periodic phase poll, which never
 *  wants to surface its own permission prompt UX) reports the same failure
 *  as the quieter `no-companion`. This is a heuristic, not a real signal —
 *  documented here so it's never mistaken for one. */
export type ProbeState =
  | { kind: "no-companion" }
  | { kind: "lna-denied" }
  | { kind: "connected"; port: CompanionPort; status: CompanionStatus };

export type ProbeTrigger = "passive" | "user-click";

export interface CompanionClientDeps {
  fetchImpl?: typeof fetch;
}

// ── Persistence (localStorage: coachbuild:companion:session / :port) ───────

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled (private mode, policy, etc.)
  }
}

// ── Companion error ring buffer (v0.43.0 diagnosability) ────────────────────
// Small rolling localStorage log of classified companion-call failures
// (network refused, HTTP status, malformed body, or a companion ok:false)
// so /live-setup can show recent failure history on a LATER visit — the
// whole point being the user can report from their phone next time without
// needing PowerShell/log access at all. Best-effort only (same posture as
// every other localStorage write in this file): a quota/policy failure here
// must never break the apply call itself.

const LAST_ERRORS_STORAGE_KEY = "coachbuild:companion:lastErrors:v1";
const LAST_ERRORS_CAP = 20;

export interface CompanionErrorLogEntry {
  ts: string; // ISO timestamp
  kind: string; // classification, e.g. "network-error" | "http-503" | "slots-full"
  detail: string; // the same hint text shown to the user
}

function isErrorLogEntry(v: unknown): v is CompanionErrorLogEntry {
  const e = v as Partial<CompanionErrorLogEntry> | null;
  return !!e && typeof e === "object" && typeof e.ts === "string" && typeof e.kind === "string" && typeof e.detail === "string";
}

function parseErrorLog(raw: string): CompanionErrorLogEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isErrorLogEntry) : [];
  } catch {
    return [];
  }
}

/** Appends one classified failure to the ring buffer, capped at
 *  LAST_ERRORS_CAP (oldest dropped first). Called from applyItemSets'/
 *  applyRunes' own failure paths below — never from a passive poll
 *  (getStatus/probeCompanion), which would flood the log with routine
 *  "companion not open yet" noise instead of an actual apply failure. */
export function recordCompanionError(kind: string, detail: string): void {
  try {
    const store = safeLocalStorage();
    if (!store) return;
    const raw = store.getItem(LAST_ERRORS_STORAGE_KEY);
    const list = raw ? parseErrorLog(raw) : [];
    list.push({ ts: new Date().toISOString(), kind, detail });
    while (list.length > LAST_ERRORS_CAP) list.shift();
    store.setItem(LAST_ERRORS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* best-effort only -- never let logging break the actual apply call */
  }
}

/** Most-recent-last list of recent companion-call failures, for
 *  /live-setup's status panel. Never throws; degrades to []. */
export function getCompanionErrorLog(): CompanionErrorLogEntry[] {
  try {
    const store = safeLocalStorage();
    const raw = store?.getItem(LAST_ERRORS_STORAGE_KEY);
    return raw ? parseErrorLog(raw) : [];
  } catch {
    return [];
  }
}

export function clearCompanionErrorLog(): void {
  try {
    safeLocalStorage()?.removeItem(LAST_ERRORS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredSession(): string | null {
  return safeLocalStorage()?.getItem(SESSION_STORAGE_KEY) ?? null;
}

export function setStoredSession(session: string): void {
  try {
    safeLocalStorage()?.setItem(SESSION_STORAGE_KEY, session);
  } catch {
    /* quota/policy failure — session just won't persist across reloads */
  }
}

export function getStoredPort(): CompanionPort | null {
  const raw = safeLocalStorage()?.getItem(PORT_STORAGE_KEY);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return (COMPANION_PORTS as readonly number[]).includes(n) ? (n as CompanionPort) : null;
}

export function setStoredPort(port: CompanionPort): void {
  try {
    safeLocalStorage()?.setItem(PORT_STORAGE_KEY, String(port));
  } catch {
    /* ignore */
  }
}

/** Whether ANY session is currently paired — the sole gate the
 *  Apply-runes button (RunesSummonersCard) uses to decide whether to render
 *  at all. Deliberately does not verify the companion is actually reachable
 *  right now (that's what Test Connection / the status poll are for) — a
 *  stored session with a since-closed companion still shows the button, and
 *  the click itself will surface the failure via applyRunes' own result. */
export function hasSession(): boolean {
  return getStoredSession() !== null;
}

/** Auto-export toggle for item sets (item sets ONLY — runes stay strictly
 *  manual, see this file's header). Default ON the first time it's ever
 *  read for a session that already exists (the user explicitly asked for
 *  "automatic" — see the fold-in note this shipped under); once the user
 *  has EXPLICITLY set it via /live-setup, that stored value always wins
 *  regardless of session state. No session yet -> defaults false (nothing
 *  to toggle for), but callers gate on hasSession() anyway before this ever
 *  matters. */
export function getAutoItemSetsEnabled(): boolean {
  const raw = safeLocalStorage()?.getItem(AUTO_ITEMSETS_STORAGE_KEY);
  if (raw === null || raw === undefined) return hasSession();
  return raw === "true";
}

export function setAutoItemSetsEnabled(enabled: boolean): void {
  try {
    safeLocalStorage()?.setItem(AUTO_ITEMSETS_STORAGE_KEY, String(enabled));
  } catch {
    /* ignore */
  }
}

/** v1.3.0 compliance update: rune WRITES may now auto-export too (same
 *  class as a Blitz/Moba auto-import — an inert loadout write, not a game
 *  action; see companion.ps1's header for the full reasoning and the one
 *  bright line that does NOT move — auto mode never deletes a page it
 *  doesn't own). Same default rule as getAutoItemSetsEnabled. */
export function getAutoRunesEnabled(): boolean {
  const raw = safeLocalStorage()?.getItem(AUTO_RUNES_STORAGE_KEY);
  if (raw === null || raw === undefined) return hasSession();
  return raw === "true";
}

export function setAutoRunesEnabled(enabled: boolean): void {
  try {
    safeLocalStorage()?.setItem(AUTO_RUNES_STORAGE_KEY, String(enabled));
  } catch {
    /* ignore */
  }
}

// ── Wire calls ──────────────────────────────────────────────────────────────

function bridgeUrl(port: number, path: string, session: string, followKind: FollowKind = null, detach = false): string {
  const base = `http://127.0.0.1:${port}${path}?session=${encodeURIComponent(session)}`;
  if (!followKind) return base;
  return detach ? `${base}&follow=${followKind}&detach=1` : `${base}&follow=${followKind}`;
}

/** v1.7.0 (companion 1.7.0) — tells the companion this page is GOING AWAY, so
 *  it stops counting as an attached tab immediately instead of decaying out of
 *  the companion's 150s attach window.
 *
 *  WHY IT EXISTS. The companion suppresses opening a page it believes is
 *  already open, and "already open" is inferred from how recently that page
 *  polled /status. The window has to be generous (150s) because Chrome
 *  throttles a hidden tab behind a fullscreen game to roughly one timer tick
 *  per minute — which means a CLOSED browser also looked attached for up to
 *  150s, i.e. most of a champ-select, and the companion opened nothing at all
 *  (live-reported 2026-07-26). A poll cadence cannot distinguish "throttled"
 *  from "gone"; only the page itself can say which, and this is it.
 *
 *  Fired on `pagehide` (tab/window close, browser exit, bfcache eviction — the
 *  one unload event that is actually reliable on mobile and modern Chrome) and
 *  when a client-side nav leaves a follow-capable route. `keepalive` is what
 *  lets the request outlive the document; a GET with no custom headers stays a
 *  CORS-simple request, so no preflight has to survive the unload either.
 *
 *  Fire-and-forget by construction: it returns whether the beacon was ATTEMPTED
 *  (for tests), never whether it arrived — the companion's browser-liveness
 *  guard is the backstop for the hard-kill case where nothing could be sent. */
export function detachFollow(kind: FollowKind, session: string, deps: CompanionClientDeps = {}): boolean {
  if (!kind || !session) return false;
  const port = getStoredPort();
  // No known-good port means this tab never reached the bridge, so it never
  // stamped an attach either — there is nothing to detach from, and a 3-port
  // walk during unload would not complete anyway.
  if (port == null) return false;
  const f = deps.fetchImpl ?? fetch;
  try {
    const p = f(bridgeUrl(port, "/status", session, kind, true), { method: "GET", keepalive: true }) as
      | Promise<unknown>
      | undefined;
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch {
    return false; // unload-time throw (fetch unavailable, blocked) — nothing to do
  }
}

/** v1.6.0 (companion 1.6.0, "two pages simultaneously" ship) — PAGE IDENTITY
 *  for the follow signal, not just capability. Every route polls /status
 *  once a session token exists (CompanionProvider is mounted app-wide,
 *  app/layout.tsx), but only `/` (Builds) and `/draft` actually REACT to a
 *  live champ-select change — a poll from anywhere else (e.g. /live-setup,
 *  /mystats, /history, /movers) proves nothing is listening. Previously this
 *  only reported a boolean (`follow=1`); now the bridge needs to know WHICH
 *  of the two follow-capable pages is attached, since companion.ps1 opens
 *  Builds and /draft independently (see Test-CompanionHasAttachedTab -Kind
 *  and Update-ChampSelectState's per-kind open logic) — a `/draft` tab
 *  attached must never suppress opening Builds, and vice versa.
 *
 *  Exact-match only, no prefix matching — a new live-aware route must be
 *  added here explicitly, not inferred from a path segment. Extracted as a
 *  pure function (rather than inlined in CompanionProvider) specifically so
 *  the route→follow decision is unit-testable without mounting React. */
export type FollowKind = "builds" | "draft" | null;

export function followKindForRoute(pathname: string | null | undefined): FollowKind {
  if (pathname === "/") return "builds";
  if (pathname === "/draft") return "draft";
  return null;
}

/** Back-compat boolean wrapper over followKindForRoute — kept in case any
 *  future caller only needs "is this route follow-capable at all" without
 *  caring which kind. No current caller uses this (CompanionProvider moved
 *  to followKindForRoute directly in v1.6.0); retained per the design note
 *  that other callers of the boolean should keep working. */
export function isFollowCapableRoute(pathname: string | null | undefined): boolean {
  return followKindForRoute(pathname) !== null;
}

/** Defensive parse of /status's `lastOpen` diagnostic field — absent
 *  (older companion, pre-1.2.0) or malformed degrades to null rather than
 *  rejecting the whole /status response over a field nothing depends on
 *  functionally. */
function normalizeLastOpen(raw: unknown): CompanionLastOpen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CompanionLastOpen>;
  if (typeof r.championId !== "number" || typeof r.at !== "string") return null;
  const roleId = typeof r.roleId === "number" ? r.roleId : null;
  return { championId: r.championId, roleId, at: r.at };
}

/** `lastPollAt`/`lastError`/`timerPhase` are all plain nullable strings —
 *  absent (older companion) or any non-string degrades to null, same
 *  defensive posture as the id normalizers below. Declared above
 *  normalizeChampSelect (which now uses it for `timerPhase`) — function
 *  declarations hoist, but keeping the read order matches call order. */
function normalizeNullableString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/** v1.4.0 — defensive normalize for `theirTeam`: anything other than an
 *  array degrades to `[]` (older companion, or a mid-transition malformed
 *  value), and non-finite/non-positive entries are dropped rather than
 *  rejecting the whole array — a single garbage slot must never take down
 *  every other (legitimately visible) enemy pick. */
function normalizeTheirTeam(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/** Same defensive posture as normalizeLastOpen, for `champSelect`. */
function normalizeChampSelect(raw: unknown): CompanionChampSelectSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CompanionChampSelectSnapshot>;
  if (typeof r.localPlayerCellId !== "number") return null;
  const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    localPlayerCellId: r.localPlayerCellId,
    cellChampionId: numOrNull(r.cellChampionId),
    pickIntent: numOrNull(r.pickIntent),
    actionChampionId: numOrNull(r.actionChampionId),
    roleId: numOrNull(r.roleId),
    theirTeam: normalizeTheirTeam(r.theirTeam),
    timerPhase: normalizeNullableString(r.timerPhase),
  };
}

export async function getStatus(
  port: CompanionPort,
  session: string,
  deps: CompanionClientDeps = {},
  followKind: FollowKind = null
): Promise<CompanionStatus | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/status", session, followKind), { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<CompanionStatus>;
    if (
      typeof data.version !== "string" ||
      typeof data.phase !== "string" ||
      typeof data.clientConnected !== "boolean"
    ) {
      return null; // malformed — treat exactly like unreachable
    }
    return {
      version: data.version,
      port,
      phase: data.phase,
      clientConnected: data.clientConnected,
      lastOpen: normalizeLastOpen(data.lastOpen),
      champSelect: normalizeChampSelect(data.champSelect),
      lastPollAt: normalizeNullableString(data.lastPollAt),
      lastError: normalizeNullableString(data.lastError),
    };
  } catch {
    return null;
  }
}

/** Walks COMPANION_PORTS (trying a previously-known-good port first, if any)
 *  looking for a live /status response. See ProbeState's doc comment for how
 *  `trigger` affects failure classification. */
export async function probeCompanion(
  session: string,
  trigger: ProbeTrigger,
  deps: CompanionClientDeps = {},
  followKind: FollowKind = null
): Promise<ProbeState> {
  const f = deps.fetchImpl ?? fetch;
  const known = getStoredPort();
  const ports: CompanionPort[] = known
    ? [known, ...COMPANION_PORTS.filter((p) => p !== known)]
    : [...COMPANION_PORTS];

  let sawTypeError = false;
  for (const port of ports) {
    try {
      const res = await f(bridgeUrl(port, "/status", session, followKind), { method: "GET" });
      if (!res.ok) continue;
      const data = (await res.json()) as Partial<CompanionStatus>;
      if (
        typeof data.version !== "string" ||
        typeof data.phase !== "string" ||
        typeof data.clientConnected !== "boolean"
      ) {
        continue;
      }
      setStoredPort(port);
      return {
        kind: "connected",
        port,
        status: {
          version: data.version,
          port,
          phase: data.phase,
          clientConnected: data.clientConnected,
          lastOpen: normalizeLastOpen(data.lastOpen),
          champSelect: normalizeChampSelect(data.champSelect),
          lastPollAt: normalizeNullableString(data.lastPollAt),
          lastError: normalizeNullableString(data.lastError),
        },
      };
    } catch (err) {
      if (err instanceof TypeError) sawTypeError = true;
      // Any other thrown shape (e.g. a JSON parse error on a non-JSON 200)
      // is treated the same as "this port didn't answer" — keep walking.
    }
  }

  if (sawTypeError && trigger === "user-click") return { kind: "lna-denied" };
  return { kind: "no-companion" };
}

/** One status refresh, reusing the last-known-good port when we have one
 *  (cheap — no 3-port walk) and falling back to a full probeCompanion when
 *  that port no longer answers (companion restarted on a different port, or
 *  was closed). Always a "passive" probe — page-level polling must never
 *  itself trigger a fresh LNA prompt UX; that's Test Connection's job. */
export async function refreshStatus(
  session: string,
  deps: CompanionClientDeps = {},
  followKind: FollowKind = null
): Promise<ProbeState> {
  const port = getStoredPort();
  if (port != null) {
    const status = await getStatus(port, session, deps, followKind);
    if (status) return { kind: "connected", port, status };
  }
  return probeCompanion(session, "passive", deps, followKind);
}

/** Raw allgamedata passthrough (or {error:'no-live'} outside a live game).
 *  Returns null on any transport failure (port closed, session rotated,
 *  malformed response) — callers treat null exactly like {error:'no-live'}:
 *  no live panel to show, never a thrown error surfaced to the user. */
export async function getLive(
  port: CompanionPort,
  session: string,
  deps: CompanionClientDeps = {}
): Promise<LiveResult | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/live", session), { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as LiveResult;
  } catch {
    return null;
  }
}

/**
 * GET /skills — the ACTIVE PLAYER's own champion level + own ability ranks,
 * read by the companion off the in-game Live Client Data API (companion
 * 1.8.0+). Feeds the /compact "level this next" panel via
 * lib/nextSkill.ts's resolveNextSkill.
 *
 * Returns null for EVERY failure that is not a well-formed reading — transport
 * error, 404 from a pre-1.8.0 companion, `{error:'no-live'}`, or a body that
 * doesn't narrow. Callers treat null as "render nothing", which is the same
 * thing they do when there is no game. That collapse is intentional: from the
 * panel's point of view "the companion is too old to answer" and "no game is
 * running" are the same state (nothing to show), and giving them separate
 * handling would only produce a placeholder where the design calls for
 * absence.
 *
 * Narrowing happens HERE (parseLiveSkillState), not at the call site, because
 * the companion updates on its own schedule over `irm | iex` — a browser can
 * be talking to an older or newer companion than the page was built against,
 * so the wire shape is never assumed.
 */
export async function getSkills(
  port: CompanionPort,
  session: string,
  deps: CompanionClientDeps = {}
): Promise<LiveSkillState | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/skills", session), { method: "GET" });
    if (!res.ok) return null;
    return parseLiveSkillState(await res.json());
  } catch {
    return null;
  }
}

/** POSTs a rune-page apply request. v1.3.0: callable from EITHER a
 *  user-clicked handler (`mode: "manual"` — RunesSummonersCard's button)
 *  OR the champ-select auto-export path (`mode: "auto"` —
 *  runeAutoApply.ts). The companion enforces the actual safety difference
 *  server-side (auto mode never deletes a non-CoachBuild page); this
 *  function just forwards whichever mode the caller declares. */
export async function applyRunes(
  port: CompanionPort,
  session: string,
  body: { name: string; primaryStyleId: number; subStyleId: number; selectedPerkIds: number[]; current: true; replacePrefix?: string },
  mode: "auto" | "manual",
  deps: CompanionClientDeps = {}
): Promise<ApplyRunesResult> {
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(bridgeUrl(port, "/apply-runes", session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, mode }),
    });
  } catch {
    // fetch itself threw -- classified as "the companion isn't reachable at
    // all" (port closed / tray app not running / LNA blocked). Distinct from
    // every OTHER failure mode below, which all imply a real HTTP round trip.
    const result: ApplyRunesResult = {
      ok: false,
      reason: "network-error",
      hint: "Companion not reachable — is the tray app running?",
    };
    recordCompanionError(result.reason, result.hint!);
    return result;
  }

  if (!res.ok) {
    const result: ApplyRunesResult = {
      ok: false,
      reason: `http-${res.status}`,
      hint: `League client refused the rune-page write (code ${res.status}) — is the client open?`,
    };
    recordCompanionError(result.reason, result.hint!);
    return result;
  }

  const data = await res.json().catch(() => null);
  if (data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean") {
    const parsed = data as ApplyRunesResult;
    if (!parsed.ok) {
      // The companion answered but didn't supply its own `hint` -- surface
      // its raw `reason` rather than dropping straight to the caller's
      // generic fallback text, same fix as applyItemSets below.
      const hint = parsed.hint ?? `Companion reported "${parsed.reason}" — try again, or set runes manually in-client.`;
      recordCompanionError(parsed.reason, hint);
      return { ...parsed, hint };
    }
    return parsed;
  }

  const result: ApplyRunesResult = {
    ok: false,
    reason: "malformed-response",
    hint: "Companion sent an unexpected response — try again or restart the tray app.",
  };
  recordCompanionError(result.reason, result.hint!);
  return result;
}

/** POSTs an item-sets apply request. Unlike applyRunes, this is NOT
 *  required to be user-clicked — item sets may be exported automatically
 *  on a champ-select deep-link (see itemSetsApply.ts's auto-export gate),
 *  since a written item set is an inert shop-panel suggestion, not a
 *  gameplay action (see this file's header comment for the compliance
 *  distinction). The manual "Add item builds" button and the auto-export
 *  path both call this SAME function with the SAME body shape.
 *
 *  `replacePrefix` (v0.35.0 / companion 1.3.1+) — see this file's header
 *  comment and itemSetBody.ts's champScopedReplacePrefix. */
export async function applyItemSets(
  port: CompanionPort,
  session: string,
  body: { championId: number; sets: unknown[]; replacePrefix?: string },
  deps: CompanionClientDeps = {}
): Promise<ApplyItemSetsResult> {
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(bridgeUrl(port, "/apply-itemsets", session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch itself threw -- same "not reachable at all" classification as
    // applyRunes above (port closed / tray app not running / LNA blocked).
    // This is the failure mode the user's on-device report most plausibly
    // hits if the companion had quietly stopped running or restarted on a
    // different port mid-session (see this file's v0.43.0 header note).
    const result: ApplyItemSetsResult = {
      ok: false,
      reason: "network-error",
      hint: "Companion not reachable — is the tray app running?",
    };
    recordCompanionError(result.reason, result.hint!);
    return result;
  }

  if (!res.ok) {
    // A real HTTP round trip happened but came back non-2xx -- distinct
    // from "not reachable at all" (network-error above): the companion (or
    // something in front of it) IS there, but rejected/errored the write.
    const result: ApplyItemSetsResult = {
      ok: false,
      reason: `http-${res.status}`,
      hint: `League client refused the item-set write (code ${res.status}) — is the client open?`,
    };
    recordCompanionError(result.reason, result.hint!);
    return result;
  }

  const data = await res.json().catch(() => null);
  if (data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean") {
    const parsed = data as ApplyItemSetsResult;
    if (!parsed.ok) {
      // 2xx + a well-formed {ok:false,...} -- the companion answered but
      // may not have supplied its own `hint` (older companion, or a reason
      // it never bothered to explain). Surface the raw `reason` instead of
      // falling all the way through to RunesSummonersCard's generic
      // "Couldn't add item builds" fallback -- THIS is the exact gap that
      // made every ok:false-without-hint response indistinguishable from
      // every other failure mode on-device.
      const hint = parsed.hint ?? `Companion reported "${parsed.reason}" — try again, or add manually in-client.`;
      recordCompanionError(parsed.reason, hint);
      return { ...parsed, hint };
    }
    return parsed;
  }

  // 2xx but the body wasn't the expected {ok:boolean,...} shape at all.
  const result: ApplyItemSetsResult = {
    ok: false,
    reason: "malformed-response",
    hint: "Companion sent an unexpected response — try again or restart the tray app.",
  };
  recordCompanionError(result.reason, result.hint!);
  return result;
}
