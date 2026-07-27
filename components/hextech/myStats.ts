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

export const MYSTATS_LOW_SAMPLE_THRESHOLD = 10;

// ── Wire shapes (this module's own contract, not imported from lib/) ───────

export interface MyStatsRecord {
  championId: number;
  role: number; // 0-4 concrete, -1 unresolved (e.g. ARAM)
  games: number;
  wins: number;
  winrate: number; // 0-1
  lastPlayed: string; // ISO
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
  priorSplitWinrate?: number | null;
  recentGames?: MyStatsRecentGame[];
}

export interface MyStatsMatchups {
  accountUnresolved: boolean;
  season: string;
  championId: number;
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
  };
}

/** Malformed payload (not even an object) -> null. A malformed individual
 *  record/recentGame entry inside a well-formed envelope is dropped, never
 *  taints the rest of the list — same posture as
 *  normalizeDraftRecommendResponse.
 *
 *  BUG FIX (P1, 2026-07-24): previously rebuilt the return object with ONLY
 *  the legacy accountUnresolved/season/riotId/records fields, silently
 *  stripping buildAdherencePct/winrateOnBuild/winrateOffBuild/
 *  priorSplitWinrate/recentGames even though the server had already been
 *  sending them since this same wave shipped — app/mystats/page.tsx's cast
 *  to its own extended type meant TypeScript never caught the mismatch, and
 *  every one of those fields silently read as undefined/[] on a real page
 *  load (reproduced in this file's test with an actual prod payload). Now
 *  passed through with the same defensive per-entry validation posture as
 *  every other field in this normalizer. */
export function normalizeMyStatsSummary(raw: unknown): MyStatsSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsSummary> & { records?: unknown; recentGames?: unknown };
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
    priorSplitWinrate: numOrNull(r.priorSplitWinrate),
    recentGames: Array.isArray(r.recentGames)
      ? r.recentGames.map(normalizeRecentGame).filter((x): x is MyStatsRecentGame => x !== null)
      : [],
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

export async function fetchMyStatsMatchups(championId: number, deps: MyStatsDeps = {}): Promise<MyStatsMatchups | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`/api/mystats/matchups?championId=${championId}`);
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
