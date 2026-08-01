// ─────────────────────────────────────────────────────────────────────────────
// components/hextech/myStats.ts — client wiring + pure display shaping for
// GET /api/mystats/summary and GET /api/mystats/matchups ("My Stats" personal
// match tracker, backend by engy — see HANDOFF's 2026-07-21 entries and
// lib/mystats/aggregate.ts for the server-side math this mirrors).
//
// Same posture as components/live/draftRecommend.ts: this module owns its
// OWN wire-shape parsing rather than importing lib/mystats/aggregate.ts's
// types (that file is server-side internal math, not a declared frontend
// contract — see lib/mystats/types.ts's header) — a malformed/older response
// degrades gracefully instead of crashing the page. Fetch wrappers never
// throw. Shaping helpers below are kept JSX-free (plain .ts) so they're
// directly unit-testable without a DOM harness, same convention as
// runesPage.ts / StatBadge.tsx's exported helpers.
//
// HARD USER DIRECTIVE (ratified 2026-07-21): this is DISPLAY-ONLY personal
// data, current-season-only ("Season 2026" — see lib/mystats/season.ts).
// Nothing here computes a score or a ranking; buildMyStatsRows/
// buildMyStatsMatchupRows explicitly do NOT re-sort — the server's own
// games-DESC tie-break order (summarizeByChampion / summarizeMatchupsByOpponent)
// is preserved as-is, only decorated with display fields.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountSummary } from "@/components/live/mystatsAccount";

export const MYSTATS_LOW_SAMPLE_THRESHOLD = 10;

/** The one coverage-aware vocabulary used by every season-scoped My Stats
 *  label. `label` fits after "of games" / in a compact panel meta line;
 *  `phrase` fits after "last N games" and in a standalone sentence. */
export interface MyStatsScopeLabels {
  label: "this season" | "recorded so far";
  phrase: "this season" | "so far this season";
}

export function getMyStatsScopeLabels(seasonClaimSafe: boolean): MyStatsScopeLabels {
  return seasonClaimSafe
    ? { label: "this season", phrase: "this season" }
    : { label: "recorded so far", phrase: "so far this season" };
}

// ── Wire shapes (this module's own contract, not imported from lib/) ───────

export interface MyStatsRecord {
  championId: number;
  role: number; // 0-4 concrete, -1 unresolved (e.g. ARAM)
  games: number;
  wins: number;
  winrate: number; // 0-1
  lastPlayed: string; // ISO
  /** TIME-WEIGHTED CS per minute across this (champion, role) — engy,
   *  HANDOFF-engy.md §1b, computed by lib/mystats/cs.ts's aggregateCs as
   *  sum(cs) / (sum(duration) / 60), NOT the mean of per-game rates. null when
   *  `csGames` is 0. Never coerced to 0: a support who genuinely farmed nothing
   *  is a real 0.0, so the absence has to be a different value. */
  csPerMin: number | null;
  /** How many of `games` are actually behind `csPerMin` — ALWAYS <= games and
   *  frequently much smaller (rows ingested before that ship carry no CS, and
   *  games under CS_MIN_GAME_SEC are excluded from every rate). This is the
   *  DENOMINATOR: a rate over 3 games must not render like one over 300, which
   *  is the v0.73.1 defect class. Render it, or withhold the rate. */
  csGames: number;
}

export interface MyStatsMatchupRecord {
  oppChampionId: number;
  games: number;
  wins: number;
  winrate: number; // 0-1
}

/** v0.51 Wave B extended field (GET /api/mystats/summary — see
 *  lib/mystats/aggregate.ts's RecentGame / app/api/mystats/summary/route.ts).
 *  `onWpaBuild` mirrors the server's own null/false distinction (see
 *  lib/mystats/adherence.ts's computeAdherence doc comment): null = no
 *  recommendation was available to compare against at ingest time, never
 *  coerced to false. Structurally identical to
 *  components/hextech/mystats/RecentGamesList.tsx's `RecentGameRow` (that
 *  file's own consumer type) on purpose — keeps the two interfaces mutually
 *  assignable regardless of which extends which. */
export interface MyStatsRecentGame {
  championId: number;
  role: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  onWpaBuild: boolean | null | undefined;
  /** Raw creep score for this ONE game (minions + neutral monsters). null =
   *  not stored for this row (pre-ship, not yet backfilled). engy §1c. */
  cs: number | null;
  /** Game length in seconds. null on pre-ship rows. */
  gameDurationSec: number | null;
  /** This game's own CS/min, 1 decimal. null when either input above is null OR
   *  the game ran under CS_MIN_GAME_SEC (300s) — a 4-minute remake's "rate" is
   *  noise, so the RATE is withheld while `cs`/`gameDurationSec` stay populated
   *  and a surface may still say "12 CS in 3:41". */
  csPerMin: number | null;
  /** 2026-07-31 audit P2 (#4) — true when `onWpaBuild` is null specifically
   *  because this game's own patch is ahead of coachless's populated data
   *  (upstream ingest lag), not because nothing was recorded for this match.
   *  See lib/mystats/adherence.ts's isWaitingForPatchData for the full
   *  reasoning. Only meaningful when `onWpaBuild` is null/undefined; ignored
   *  otherwise. Always a real boolean from the server (never undefined) —
   *  see normalizeRecentGame's default below for the one place that matters. */
  patchDataPending: boolean;
}

export interface MyStatsSummary {
  accountUnresolved: boolean;
  season: string;
  riotId: string | null;
  records: MyStatsRecord[];
  /** v0.51 Wave B additions — all optional (not just possibly-empty) so a
   *  consumer's own extended interface (see app/mystats/page.tsx's
   *  MyStatsSummaryExtended) can redeclare them without a TS2430
   *  "incorrectly extends" error: a base interface can't declare a member
   *  required when a derived interface declares the same member optional.
   *  normalizeMyStatsSummary below ALWAYS populates real values for these
   *  (never leaves them genuinely absent) — optional here is a type-level
   *  compatibility choice, not a runtime gap.
   *  BUG FIX (2026-07-24, P1): these five fields were previously dropped
   *  entirely by normalizeMyStatsSummary, even though the server has sent
   *  them since the same wave shipped — the page's cast to
   *  MyStatsSummaryExtended silently degraded every one of them to
   *  undefined/[] on every real load. Root-caused and fixed here; see this
   *  file's test for the exact reproduction (a real prod payload fixture). */
  buildAdherencePct?: number | null;
  winrateOnBuild?: number | null;
  winrateOffBuild?: number | null;
  recentGames?: MyStatsRecentGame[];
  /** v0.74 additions — row counts behind winrateOnBuild/winrateOffBuild
   *  respectively (lib/mystats/aggregate.ts's computeBuildAdherence /
   *  app/api/mystats/summary/route.ts). Same null-exactly-when-the-
   *  corresponding-winrate-is-null convention as every other field here,
   *  never a fabricated 0 — feed these straight into
   *  computeBuildWinrateDelta's nOnBuild/nOffBuild params. Landed
   *  specifically so that function can return `comparable: true` on a real
   *  page load (previously never sent — see this file's git history /
   *  HANDOFF-engo.md for the v0.51-P1-style gap this closes). Optional for
   *  the same TS2430 reason as the fields above, and normalizeMyStatsSummary
   *  below ALWAYS populates a real value (number or null), never leaves it
   *  genuinely absent. */
  nOnBuild?: number | null;
  nOffBuild?: number | null;
  /** v0.83 (migration 0020) — WHICH linked account every figure above belongs
   *  to, and the full list so a picker costs no second round trip and can never
   *  render a list that disagrees with the stats beside it. Both are present on
   *  the accountUnresolved response too (`accountId: null`, `accounts` possibly
   *  non-empty), so a user with nothing active can still be offered a choice.
   *  See HANDOFF-engy.md §1b. Optional for the same TS2430 reason as every
   *  field above; normalizeMyStatsSummary ALWAYS populates a real value.
   *  Deliberately carries NO puuid — the picker switches by opaque `id`. */
  accountId?: number | null;
  accounts?: AccountSummary[];
  /** 2026-07-30 — has the ACTIVE account's season window actually been walked
   *  all the way, or is every figure on this response computed over a PARTIAL
   *  history? Sent by `GET /api/mystats/summary` (from
   *  lib/mystats/ingest.ts's readHistoryComplete over
   *  my_ingest_cursor.backfill_done). `false` is normal and temporary for a
   *  just-linked account: the catch-up walk converges over several runs inside a
   *  60s serverless budget.
   *
   *  `boolOrNull` on purpose, and the null is load-bearing: a payload that does
   *  not carry the field at all (older cached bundle, a wire regression) means we
   *  do not KNOW whether the history is whole, which is a different thing from
   *  knowing it is. computeHistoryCoverage below maps that third case to a state
   *  that withdraws the season claim without asserting a sync is in progress —
   *  see its doc comment. Never coerced to `true`, which would be a coverage
   *  claim made from an absent field. */
  historyComplete?: boolean | null;

  // ── 2026-07-30, engy §1d + §1a top-level mirror ───────────────────────────
  /** Account-wide, current-season time-weighted CS/min — same scope as
   *  `buildAdherencePct`. null when `csGames` is 0. */
  csPerMin?: number | null;
  /** Games behind `csPerMin`. 0 => csPerMin is null. Always rendered with it. */
  csGames?: number;
  /** The ACTIVE account's ranked solo/duo standing, mirrored top-level so the
   *  hero does not have to hunt through `accounts[]`. Identical semantics and
   *  identical values to `accounts.find(a => a.active)` — see AccountSummary's
   *  comment for the rankUnknown discriminator, which is the load-bearing part.
   *  On the accountUnresolved response these are null / rankUnknown:true. */
  tier?: string | null;
  division?: string | null;
  lp?: number | null;
  rankWins?: number | null;
  rankLosses?: number | null;
  rankUnknown?: boolean;
  rankCheckedAt?: string | null;
}

export interface MyStatsMatchups {
  accountUnresolved: boolean;
  season: string;
  championId: number;
  /** null = champion-wide (no role filter was requested/echoed), else the
   *  (championId, role) scope the server applied — see
   *  app/api/mystats/matchups/route.ts's doc comment. -1 is a real,
   *  distinct-from-null value (unresolved lane, e.g. ARAM). */
  role: number | null;
  matchups: MyStatsMatchupRecord[];
}

// ── Normalizers (defensive; never throw, drop malformed entries) ──────────

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeRecord(raw: unknown): MyStatsRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsRecord>;
  if (typeof r.championId !== "number") return null;
  return {
    championId: r.championId,
    role: typeof r.role === "number" ? r.role : -1,
    games: num(r.games),
    wins: num(r.wins),
    winrate: num(r.winrate),
    lastPlayed: typeof r.lastPlayed === "string" ? r.lastPlayed : "",
    // `numOrNull`, NOT `num`: a missing rate must stay null so the UI renders an
    // em dash. `num(...)` would default it to 0, which is a real CS/min value and
    // would read as "this champion farms nothing" on every pre-backfill row.
    csPerMin: numOrNull(r.csPerMin),
    // csGames IS safe to default to 0 — zero games behind the rate is exactly
    // what an absent field means, and it is the value that makes the UI withhold
    // the rate rather than show it.
    csGames: num(r.csGames),
  };
}

/** null when `v` isn't a finite number — distinct from `0`, which is a real
 *  value every one of these fields can legitimately hold (0% adherence, 0%
 *  win rate on a real 0-win sample). Never coerced to 0 as a fallback. */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** true/false pass through as-is; anything else (missing, null, a stray
 *  string/number from a malformed payload) degrades to null — the server's
 *  own "no recommendation available" signal, never fabricated as false. */
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function normalizeRecentGame(raw: unknown): MyStatsRecentGame | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsRecentGame>;
  if (typeof r.championId !== "number") return null;
  if (typeof r.win !== "boolean") return null;
  return {
    championId: r.championId,
    role: typeof r.role === "number" ? r.role : -1,
    win: r.win,
    kills: num(r.kills),
    deaths: num(r.deaths),
    assists: num(r.assists),
    onWpaBuild: boolOrNull(r.onWpaBuild),
    // All three stay null on absence. `cs: 0` is a real reading (a 3-minute
    // remake where nobody farmed) and must not be manufactured from a missing
    // field — see engy §1c for why the raw pair survives even when the RATE is
    // deliberately withheld on a sub-300s game.
    cs: numOrNull(r.cs),
    gameDurationSec: numOrNull(r.gameDurationSec),
    csPerMin: numOrNull(r.csPerMin),
    // Defaults to false (never true) on an absent/malformed field — an older
    // cached bundle or a wire regression must degrade to the existing
    // "not-recorded" copy, never a fabricated "waiting for patch data" claim.
    patchDataPending: r.patchDataPending === true,
  };
}

/** Malformed payload (not even an object) -> null. A malformed individual
 *  record/recentGame entry inside a well-formed envelope is dropped, never
 *  taints the rest of the list — same posture as
 *  normalizeDraftRecommendResponse.
 *
 *  BUG FIX (P1, 2026-07-24): previously rebuilt the return object with ONLY
 *  the legacy accountUnresolved/season/riotId/records fields, silently
 *  stripping buildAdherencePct/winrateOnBuild/winrateOffBuild/recentGames even though the server had already been
 *  sending them since this same wave shipped — app/mystats/page.tsx's cast
 *  to its own extended type meant TypeScript never caught the mismatch, and
 *  every one of those fields silently read as undefined/[] on a real page
 *  load (reproduced in this file's test with an actual prod payload). Now
 *  passed through with the same defensive per-entry validation posture as
 *  every other field in this normalizer.
 *
 *  DO NOT repeat the P1 bug above: any new field added to the wire response
 *  (nOnBuild/nOffBuild, v0.74) must be added BOTH to MyStatsSummary's
 *  interface AND here, or it silently degrades to undefined on every real
 *  load exactly like the original five did. See this file's test for a
 *  round-trip check against a realistic payload. */
/** One picker row. Same defensive posture as normalizeRecord: a malformed entry
 *  is dropped rather than tainting the list, and a missing `id`/`riotId` makes
 *  the row unusable (the id is the ONLY handle a switch has), so those two are
 *  required and everything else has an honest fallback. */
function normalizeAccountSummary(raw: unknown): AccountSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<AccountSummary>;
  if (typeof a.id !== "number" || !Number.isFinite(a.id)) return null;
  if (typeof a.riotId !== "string" || a.riotId.length === 0) return null;
  return {
    id: a.id,
    riotId: a.riotId,
    gameName: typeof a.gameName === "string" ? a.gameName : "",
    tagLine: typeof a.tagLine === "string" ? a.tagLine : "",
    region: typeof a.region === "string" ? a.region : "",
    active: a.active === true,
    lastSeenAt: typeof a.lastSeenAt === "string" ? a.lastSeenAt : null,
    games: num(a.games),
    // PASS THESE THROUGH, do not "tidy them away". A client normalizer that
    // silently drops a field the server already sends is this repo's most
    // repeated frontend bug (four occurrences on this page alone): both sides
    // pass their own tests and the surface renders nothing. `numOrNull`, never
    // `num` — 0 is a real win count and a real 0% win rate, so an absent field
    // must stay null and reach the em dash, not become a confident zero.
    //
    // All three are read by `resolveAccountWinrate`, which is the only place
    // that decides which one wins. See AccountSummary's comment for why the
    // field name is deliberately not assumed here.
    wins: numOrNull((a as { wins?: unknown }).wins),
    winrate: numOrNull((a as { winrate?: unknown }).winrate),
    winRate: numOrNull((a as { winRate?: unknown }).winRate),
    ...normalizeRank(a),
  };
}

/**
 * The seven ranked-standing fields, shared by `normalizeAccountSummary` and the
 * top-level mirror in `normalizeMyStatsSummary` — one implementation so the two
 * can never disagree about the same account's rank.
 *
 * THE DEFAULT IS THE WHOLE POINT: an absent/malformed `rankUnknown` normalizes
 * to **true**, not false. `false` asserts "we looked and this account has no
 * ranked standing", which a payload that never carried the field has not earned.
 * A response predating engy's rank ship therefore renders as "not synced yet"
 * rather than parading every account as Unranked — and the same defence covers a
 * future wire regression.
 *
 * A stray non-boolean (`"false"`, 0, null) is likewise unknown. Note that a
 * truthiness test would be actively wrong here: the string "false" is truthy.
 */
function normalizeRank(raw: unknown): {
  tier: string | null;
  division: string | null;
  lp: number | null;
  rankWins: number | null;
  rankLosses: number | null;
  rankUnknown: boolean;
  rankCheckedAt: string | null;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  const known = r.rankUnknown === false;
  if (!known) {
    // Unknown means every field means NOTHING — they are blanked here rather
    // than passed through, so no consumer can accidentally read a stale tier
    // sitting beside `rankUnknown: true`.
    return {
      tier: null,
      division: null,
      lp: null,
      rankWins: null,
      rankLosses: null,
      rankUnknown: true,
      rankCheckedAt: typeof r.rankCheckedAt === "string" ? r.rankCheckedAt : null,
    };
  }
  return {
    tier: typeof r.tier === "string" && r.tier.length > 0 ? r.tier.toUpperCase() : null,
    division: typeof r.division === "string" && r.division.length > 0 ? r.division.toUpperCase() : null,
    lp: numOrNull(r.lp),
    rankWins: numOrNull(r.rankWins),
    rankLosses: numOrNull(r.rankLosses),
    rankUnknown: false,
    rankCheckedAt: typeof r.rankCheckedAt === "string" ? r.rankCheckedAt : null,
  };
}

export function normalizeMyStatsSummary(raw: unknown): MyStatsSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsSummary> & { records?: unknown; recentGames?: unknown; accounts?: unknown };
  return {
    accountUnresolved: r.accountUnresolved === true,
    season: typeof r.season === "string" ? r.season : "",
    riotId: typeof r.riotId === "string" ? r.riotId : null,
    records: Array.isArray(r.records)
      ? r.records.map(normalizeRecord).filter((x): x is MyStatsRecord => x !== null)
      : [],
    buildAdherencePct: numOrNull(r.buildAdherencePct),
    winrateOnBuild: numOrNull(r.winrateOnBuild),
    winrateOffBuild: numOrNull(r.winrateOffBuild),
    nOnBuild: numOrNull(r.nOnBuild),
    nOffBuild: numOrNull(r.nOffBuild),
    recentGames: Array.isArray(r.recentGames)
      ? r.recentGames.map(normalizeRecentGame).filter((x): x is MyStatsRecentGame => x !== null)
      : [],
    accountId: numOrNull(r.accountId),
    accounts: Array.isArray(r.accounts)
      ? r.accounts.map(normalizeAccountSummary).filter((x): x is AccountSummary => x !== null)
      : [],
    // The route has sent this since 2026-07-30 and this normalizer dropped it,
    // which is exactly the P1 shape recorded above (the server sends a field, the
    // page's cast to its own extended type hides that it never arrives). Passed
    // through as boolean|null — see the field's doc comment for why the null case
    // is not collapsed into either boolean.
    historyComplete: boolOrNull(r.historyComplete),
    // 2026-07-30 (engy §1d + §1a). Added to the interface AND here in the same
    // edit, per this normalizer's own standing warning — three separate P1s in
    // this file came from doing only the former.
    csPerMin: numOrNull(r.csPerMin),
    csGames: num(r.csGames),
    ...normalizeRank(r),
  };
}

function normalizeMatchupRecord(raw: unknown): MyStatsMatchupRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsMatchupRecord>;
  if (typeof r.oppChampionId !== "number") return null;
  return { oppChampionId: r.oppChampionId, games: num(r.games), wins: num(r.wins), winrate: num(r.winrate) };
}

export function normalizeMyStatsMatchups(raw: unknown): MyStatsMatchups | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsMatchups> & { matchups?: unknown };
  return {
    accountUnresolved: r.accountUnresolved === true,
    season: typeof r.season === "string" ? r.season : "",
    championId: typeof r.championId === "number" ? r.championId : 0,
    role: typeof r.role === "number" ? r.role : null,
    matchups: Array.isArray(r.matchups)
      ? r.matchups.map(normalizeMatchupRecord).filter((x): x is MyStatsMatchupRecord => x !== null)
      : [],
  };
}

// ── Fetch wrappers (never throw; degrade to null, caller renders its own
//    "couldn't load" state) — both routes are no-store server-side, so no
//    extra cache-busting is needed client-side. ─────────────────────────────

export interface MyStatsDeps {
  fetchImpl?: typeof fetch;
}

export async function fetchMyStatsSummary(deps: MyStatsDeps = {}): Promise<MyStatsSummary | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f("/api/mystats/summary");
    if (!res.ok) return null;
    return normalizeMyStatsSummary(await res.json());
  } catch {
    return null;
  }
}

/** `role`, when given, scopes the request to one (championId, role) pair —
 *  this is what the /mystats "Matchup History" row expansion must pass, so
 *  the expanded detail matches the row's own header instead of the whole
 *  champion. `undefined` (the default) requests the champion-wide matchups
 *  instead — a different, still-legitimate question. `role=-1` (unresolved
 *  lane, e.g. ARAM) is a real value, distinct from omitting the param. */
export async function fetchMyStatsMatchups(
  championId: number,
  role?: number,
  deps: MyStatsDeps = {}
): Promise<MyStatsMatchups | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const qs = role !== undefined ? `?championId=${championId}&role=${role}` : `?championId=${championId}`;
    const res = await f(`/api/mystats/matchups${qs}`);
    if (!res.ok) return null;
    return normalizeMyStatsMatchups(await res.json());
  } catch {
    return null;
  }
}

// ── Display shaping (pure) ──────────────────────────────────────────────────

const ROLE_LABEL: Record<number, string> = { 0: "Top", 1: "Jungle", 2: "Mid", 3: "Bot", 4: "Support" };

/** -1 (or anything else unrecognized) reads as "Other" — covers Riot's
 *  unresolved-lane sentinel (ARAM, and any teamPosition string
 *  lib/mystats/extract.ts couldn't map), never a raw "-1" in the UI. */
export function myStatsRoleLabel(role: number): string {
  return ROLE_LABEL[role] ?? "Other";
}

export interface IconEntry {
  name: string;
  icon: string;
}
export type IconLookup = (championId: number) => IconEntry | undefined;

export interface MyStatsChampionRow {
  championId: number;
  role: number;
  roleLabel: string;
  name: string;
  icon: string;
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  /** Below MYSTATS_LOW_SAMPLE_THRESHOLD games — the UI mutes these rows
   *  (dimmer text, no bold winrate) rather than hiding them; a genuinely
   *  new champion with 2 games is still real data, just not yet a stable
   *  trend. */
  lowSample: boolean;
  /** Time-weighted CS/min for this (champion, role), straight from the record —
   *  null when `csGames` is 0. See MyStatsRecord for why this is not `games`. */
  csPerMin: number | null;
  /** The denominator behind `csPerMin`. Rendered with it, always. */
  csGames: number;
}

/** Records already arrive games-DESC / winrate-DESC / championId-ASC sorted
 *  from the server (summarizeByChampion) — this does NOT re-sort, only
 *  decorates each row with display fields (name/icon/label/lowSample).
 *  Re-sorting here would risk silently drifting from the server's own
 *  tie-break rules. */
export function buildMyStatsRows(records: MyStatsRecord[], iconOf: IconLookup): MyStatsChampionRow[] {
  return records.map((r) => {
    const entry = iconOf(r.championId);
    return {
      championId: r.championId,
      role: r.role,
      roleLabel: myStatsRoleLabel(r.role),
      name: entry?.name ?? `Champion #${r.championId}`,
      icon: entry?.icon ?? "",
      games: r.games,
      wins: r.wins,
      losses: r.games - r.wins,
      winrate: r.winrate,
      lowSample: r.games < MYSTATS_LOW_SAMPLE_THRESHOLD,
      csPerMin: r.csPerMin,
      csGames: r.csGames,
    };
  });
}

/**
 * The account's main CHAMPION, summed across every role they played it in.
 *
 * `records` are per (champion, ROLE) pairs, so `rows[0]` — which the /mystats
 * MAIN tile used to read — is the biggest single (champion, role) record, NOT
 * the champion's total. On a real account that understated the headline: Viktor
 * showed as 15 games when the true total across mid/top was 19 (15 + 3 + 1).
 * A user reads "MAIN: Viktor, 15g" as "I have played 15 games of Viktor", and
 * that reading was simply wrong.
 *
 * The win rate is recomputed from the summed wins and games rather than
 * averaged across the per-role rates — averaging rates weights a 1-game role
 * equally with a 15-game one.
 *
 * Returns null when there are no records at all.
 */
export function computeMainChampion(
  records: MyStatsRecord[],
  iconOf: IconLookup
): { championId: number; name: string; games: number; wins: number; winrate: number } | null {
  if (records.length === 0) return null;

  const totals = new Map<number, { games: number; wins: number }>();
  for (const r of records) {
    const acc = totals.get(r.championId) ?? { games: 0, wins: 0 };
    acc.games += r.games;
    acc.wins += r.wins;
    totals.set(r.championId, acc);
  }

  let bestId: number | null = null;
  let best = { games: 0, wins: 0 };
  // `.forEach` rather than `for…of` over the Map: this project's tsconfig target
  // predates downlevelIteration, so iterating a Map directly does not compile.
  totals.forEach((acc, championId) => {
    // Strictly greater, so ties keep the first-seen champion — `records` arrive
    // sorted by games desc, making that the more-played-recently one.
    if (acc.games > best.games) {
      bestId = championId;
      best = acc;
    }
  });
  if (bestId === null) return null;

  return {
    championId: bestId,
    name: iconOf(bestId)?.name ?? `Champion #${bestId}`,
    games: best.games,
    wins: best.wins,
    winrate: best.games > 0 ? best.wins / best.games : 0,
  };
}

export interface MyStatsOverall {
  games: number;
  wins: number;
  losses: number;
  winrate: number; // 0-1, 0 when games === 0 (nothing to divide)
}

/** Sums across every (champion, role) record — deliberately NOT the same
 *  number as "total ranked games" or similar; this is exactly the set of
 *  rows the table below shows, so the header total always matches what a
 *  user sees if they add up every row themselves. */
export function computeMyStatsOverall(records: MyStatsRecord[]): MyStatsOverall {
  const games = records.reduce((sum, r) => sum + r.games, 0);
  const wins = records.reduce((sum, r) => sum + r.wins, 0);
  return { games, wins, losses: games - wins, winrate: games > 0 ? wins / games : 0 };
}

export interface MyStatsMatchupRow {
  oppChampionId: number;
  name: string;
  icon: string;
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  lowSample: boolean;
}

/** Matchup records already arrive games-DESC / oppChampionId-ASC sorted from
 *  the server (summarizeMatchupsByOpponent) — same no-re-sort posture as
 *  buildMyStatsRows above. */
export function buildMyStatsMatchupRows(matchups: MyStatsMatchupRecord[], iconOf: IconLookup): MyStatsMatchupRow[] {
  return matchups.map((m) => {
    const entry = iconOf(m.oppChampionId);
    return {
      oppChampionId: m.oppChampionId,
      name: entry?.name ?? `Champion #${m.oppChampionId}`,
      icon: entry?.icon ?? "",
      games: m.games,
      wins: m.wins,
      losses: m.games - m.wins,
      winrate: m.winrate,
      lowSample: m.games < MYSTATS_LOW_SAMPLE_THRESHOLD,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.74 wave — KPI-strip + per-game bar-chart helpers (engo) for the /mystats
// redesign (fronty). Pure, JSX-free, same posture as everything above: total
// functions (empty input / all-zero / single-game are real inputs, not edge
// cases), never fabricate a confident number where the data doesn't support
// one. Operate on the KILLS/DEATHS/ASSISTS/WIN shape shared by both
// MyStatsRecentGame (this file) and RecentGamesList.tsx's RecentGameRow (that
// file's own consumer type, structurally identical on purpose — see
// MyStatsRecentGame's doc comment above), so either can be passed in as-is.
// ─────────────────────────────────────────────────────────────────────────────

type KdaInput = Pick<MyStatsRecentGame, "kills" | "deaths" | "assists">;

/** KDA convention used everywhere below: (kills + assists) / deaths, with a
 *  zero-deaths floor of dividing by 1 rather than 0 — so a perfect (0-death)
 *  game reads as a real finite number (kills+assists), matching the
 *  "Perfect KDA" convention op.gg/u.gg use, and never renders `Infinity` or
 *  `NaN` in the UI. Callers that want to badge a 0-death game as "Perfect"
 *  do so off `deaths === 0` directly (see MyStatsGameKda.perfect below) —
 *  this only guarantees the NUMBER itself stays finite either way. */
function kdaRatio(kills: number, deaths: number, assists: number): number {
  return deaths === 0 ? kills + assists : (kills + assists) / deaths;
}

export interface MyStatsAverageKda {
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  /** Computed from the AVERAGED components — (avgKills + avgAssists) /
   *  avgDeaths — not an average of each game's own ratio. Averaging the
   *  ratios would let one low-death outlier game dominate the mean the same
   *  way an unweighted average always does; summing components first and
   *  dividing once matches how "7.7 / 4.5 / 5.8 -> 3.0 KDA" is meant to add
   *  up on screen. */
  kda: number;
  n: number;
}

/** Zero games -> all-zero, kda 0 (not NaN) — an empty state, not an error. */
export function computeAverageKda(games: KdaInput[]): MyStatsAverageKda {
  const n = games.length;
  if (n === 0) return { avgKills: 0, avgDeaths: 0, avgAssists: 0, kda: 0, n: 0 };
  const totals = games.reduce(
    (acc, g) => ({ kills: acc.kills + g.kills, deaths: acc.deaths + g.deaths, assists: acc.assists + g.assists }),
    { kills: 0, deaths: 0, assists: 0 }
  );
  const avgKills = totals.kills / n;
  const avgDeaths = totals.deaths / n;
  const avgAssists = totals.assists / n;
  return { avgKills, avgDeaths, avgAssists, kda: kdaRatio(avgKills, avgDeaths, avgAssists), n };
}

export interface MyStatsGameKda {
  kda: number;
  /** true when the game had 0 deaths — the UI's "Perfect" badge convention.
   *  `kda` is always finite regardless (see kdaRatio's doc comment), so a
   *  consumer that ignores this flag still renders a sane number/bar. */
  perfect: boolean;
}

export function computeGameKda(game: KdaInput): MyStatsGameKda {
  return { kda: kdaRatio(game.kills, game.deaths, game.assists), perfect: game.deaths === 0 };
}

/** Ceiling used to normalise a per-game KDA into a 0..1 bar-chart fraction.
 *  Clamping at a FIXED ceiling — rather than normalising against the actual
 *  max KDA in the set — is deliberate: max-based normalisation lets a single
 *  outlier game (a 0-death 15-assist stomp) flatten every other bar toward
 *  invisibility. 10 is chosen because a KDA of 10 is already an exceptional
 *  game by any LoL convention: high enough that ordinary good games (2-6
 *  KDA) stay visually distinct from each other, low enough that one blowout
 *  doesn't need its own scale. A game at or above the ceiling renders as a
 *  full bar, never a taller one. */
export const MYSTATS_KDA_BAR_CEILING = 10;

export interface MyStatsKdaBar {
  kda: number;
  perfect: boolean;
  /** 0..1, clamped — see MYSTATS_KDA_BAR_CEILING's doc comment. */
  fraction: number;
}

/** Does NOT re-sort — one bar per input game, in input order, same
 *  no-re-sort posture as buildMyStatsRows/buildMyStatsMatchupRows above. */
export function normalizeKdaBars(games: KdaInput[]): MyStatsKdaBar[] {
  return games.map((g) => {
    const { kda, perfect } = computeGameKda(g);
    const fraction = Math.max(0, Math.min(kda, MYSTATS_KDA_BAR_CEILING)) / MYSTATS_KDA_BAR_CEILING;
    return { kda, perfect, fraction };
  });
}

export type MyStatsBuildWinrateDelta =
  | {
      comparable: true;
      /** onBuild winrate minus offBuild winrate, signed — positive means the
       *  account wins more often ON the WPA build. */
      delta: number;
      onBuild: { winrate: number; n: number };
      offBuild: { winrate: number; n: number };
    }
  | { comparable: false; reason: "no-on-build-data" | "no-off-build-data" | "sample-unknown" | "low-sample" };

/**
 * DISPLAY ONLY (HARD RULE 3, CLAUDE.md) — never feeds a score/ranking.
 *
 * `nOnBuild`/`nOffBuild` are the sample sizes BEHIND `winrateOnBuild`/
 * `winrateOffBuild` (how many current-season games actually landed in each
 * bucket) — as of v0.74, `GET /api/mystats/summary` sends both
 * (`MyStatsSummary.nOnBuild`/`nOffBuild`, from
 * `lib/mystats/aggregate.ts`'s `computeBuildAdherence`); feed them straight
 * through from a normalized `MyStatsSummary`. They are still separate
 * OPTIONAL params, not folded into the two winrate args, so this function
 * still compiles and safely degrades to `"sample-unknown"` if ever called
 * without them (an older cached bundle, a hand-built fixture, a future wire
 * regression) — it deliberately never reconstructs a count from an unrelated
 * total (e.g. `buildAdherencePct`, which is a % of *resolved* rows, not a
 * bucket count, or a champion record's `games`) — that exact move, quoting a
 * number against the wrong denominator, is the bug that shipped in v0.73.1.
 *
 * Precedence when multiple conditions apply: `winrateOnBuild === null` is
 * checked before `winrateOffBuild === null`, which is checked before the
 * sample-size checks — so a genuinely empty response (both null, no counts)
 * reports `"no-on-build-data"`, not `"sample-unknown"`.
 */
export function computeBuildWinrateDelta(
  winrateOnBuild: number | null,
  winrateOffBuild: number | null,
  nOnBuild?: number | null,
  nOffBuild?: number | null
): MyStatsBuildWinrateDelta {
  if (winrateOnBuild === null) return { comparable: false, reason: "no-on-build-data" };
  if (winrateOffBuild === null) return { comparable: false, reason: "no-off-build-data" };
  if (nOnBuild == null || nOffBuild == null) return { comparable: false, reason: "sample-unknown" };
  if (nOnBuild < MYSTATS_LOW_SAMPLE_THRESHOLD || nOffBuild < MYSTATS_LOW_SAMPLE_THRESHOLD) {
    return { comparable: false, reason: "low-sample" };
  }
  return {
    comparable: true,
    delta: winrateOnBuild - winrateOffBuild,
    onBuild: { winrate: winrateOnBuild, n: nOnBuild },
    offBuild: { winrate: winrateOffBuild, n: nOffBuild },
  };
}

export interface MyStatsWinLossCounts {
  wins: number;
  losses: number;
  n: number;
  /** Same MYSTATS_LOW_SAMPLE_THRESHOLD convention as buildMyStatsRows/
   *  buildMyStatsMatchupRows — lets the count pills mute themselves on a
   *  thin window instead of inventing a second threshold. */
  lowSample: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY COVERAGE (2026-07-30) — is a "Season 2026" number actually a season?
//
// /mystats presents every figure under a season label. Those figures are computed
// over whatever rows my_matches happens to hold, and a refresh run can be cut off
// by its per-run Riot-call budget before it has walked the account's whole season
// window (lib/mystats/ingest.ts's INCREMENTAL_CALL_BUDGET, sized for the refresh
// route's maxDuration = 60). When that happens the backend says so
// (`historyComplete: false`), and until this helper existed no surface said
// anything: a partially synced account showed confident percentages under a
// heading that claimed the whole season. That is HARD RULE 4 (CLAUDE.md) — a
// confident number over a truncated denominator.
//
// What this deliberately does NOT do is quote progress. Nothing anywhere knows
// the true denominator — that is the entire reason the flag exists rather than a
// count — so there is no "62% synced" here and there must never be one. The only
// numbers this helper hands back are games we actually hold.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * At or below this many stored games, an incomplete history is treated as THIN
 * rather than merely filling, and the page says so in a sentence instead of a
 * chip — see MyStatsHistoryCoverage.
 *
 * 30 is not a taste number: `lib/mystats/ingest.ts`'s `INCREMENTAL_CALL_BUDGET`
 * is 30 Riot calls per run, one of which is the id page, so a single truncated
 * run can store at most ~29 games. An account sitting at or below 30 has
 * effectively had ONE pass and nothing more — its win rate is one run's slice of
 * a season, not a season. Above it, several runs have landed and the numbers are
 * worth reading with a caveat rather than a paragraph.
 *
 * Duplicated rather than imported: `lib/mystats/ingest.ts` is server-side (Neon +
 * Riot) and importing it here would drag both into the client bundle — the same
 * reason this module owns its own wire shapes (see this file's header). If that
 * budget changes, change this with it.
 */
export const MYSTATS_THIN_HISTORY_GAMES = 30;

export type MyStatsHistoryCoverageState =
  /** No active account — there are no figures, so there is no claim to make. */
  | "none"
  /** The season window has been walked. Numbers mean what their labels say. */
  | "complete"
  /** The response did not carry `historyComplete` at all. We do not know. */
  | "unknown"
  /** Known incomplete, with enough games stored to be worth reading. */
  | "filling"
  /** Known incomplete and at/below one truncated run's yield. */
  | "thin";

export interface MyStatsHistoryCoverage {
  state: MyStatsHistoryCoverageState;
  /**
   * May a surface present its figures as covering the whole season?
   *
   * `true` ONLY for `"complete"`. Both `"unknown"` and the two incomplete states
   * withdraw the claim — a label that cannot be justified is downgraded ("Games
   * so far") rather than kept and footnoted.
   */
  seasonClaimSafe: boolean;
  /** Games actually held, echoed so no consumer re-derives it from a different
   *  denominator (the v0.73.1 bug class). Never negative. */
  games: number;
  /**
   * A short badge for the identity header, or null when nothing should render.
   *
   * Null for `"unknown"` on purpose: we cannot say a sync is in progress when we
   * were not told whether it is. Withdrawing the label is honest; announcing a
   * sync would be a second invented fact.
   */
  pill: { text: string; title: string } | null;
  /** ≤18-character note for the GAMES KPI cell (KpiStrip reserves that row
   *  already, so this costs no layout shift), or null. */
  gamesNote: string | null;
}

export interface MyStatsHistoryCoverageInput {
  accountUnresolved: boolean;
  /** Straight from a normalized MyStatsSummary — boolean, or null when the
   *  response never carried it. */
  historyComplete: boolean | null | undefined;
  /** Games the page is actually showing (computeMyStatsOverall's `games`). */
  games: number;
}

/**
 * Pure. DISPLAY ONLY (HARD RULE 3) — nothing here feeds a score or a ranking; it
 * only decides how honestly a heading may be worded.
 *
 * Precedence: `accountUnresolved` wins over everything (no account, no claim),
 * then an absent flag, then the games count splits the two incomplete states.
 */
export function computeHistoryCoverage(input: MyStatsHistoryCoverageInput): MyStatsHistoryCoverage {
  const games = Math.max(0, num(input.games));

  if (input.accountUnresolved) {
    return { state: "none", seasonClaimSafe: false, games, pill: null, gamesNote: null };
  }
  if (typeof input.historyComplete !== "boolean") {
    return { state: "unknown", seasonClaimSafe: false, games, pill: null, gamesNote: null };
  }
  if (input.historyComplete) {
    return { state: "complete", seasonClaimSafe: true, games, pill: null, gamesNote: null };
  }

  // Wording note: "Still syncing" / "still collecting", never "incomplete",
  // "missing" or "error". Nothing is broken — the history is filling, and each
  // refresh brings more. But it is also not whisper-quiet: the badge sits on the
  // identity header ABOVE the numbers it qualifies, and the GAMES cell stops
  // claiming a season, so the caveat is read before the figures are.
  const pill = {
    text: "Still syncing",
    title:
      `Your match history is still being collected — ${games} games stored so far. ` +
      "Every figure below is computed over those games, not your full season. More arrive with each refresh.",
  };
  return {
    state: games <= MYSTATS_THIN_HISTORY_GAMES ? "thin" : "filling",
    seasonClaimSafe: false,
    games,
    pill,
    gamesNote: "still syncing",
  };
}

/** Win/loss counts over whatever window of games is passed in (e.g.
 *  `recentGames`) — `n` is always the exact length of that input, so a
 *  consumer can never render the counts without the sample size that
 *  produced them. Does not filter or re-sort. */
export function computeRecentWinLoss(games: Pick<MyStatsRecentGame, "win">[]): MyStatsWinLossCounts {
  const n = games.length;
  const wins = games.filter((g) => g.win).length;
  return { wins, losses: n - wins, n, lowSample: n < MYSTATS_LOW_SAMPLE_THRESHOLD };
}
