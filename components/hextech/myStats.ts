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

export interface MyStatsSummary {
  accountUnresolved: boolean;
  season: string;
  riotId: string | null;
  records: MyStatsRecord[];
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

/** Malformed payload (not even an object) -> null. A malformed individual
 *  record entry inside a well-formed envelope is dropped, never taints the
 *  rest of the list — same posture as normalizeDraftRecommendResponse. */
export function normalizeMyStatsSummary(raw: unknown): MyStatsSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MyStatsSummary> & { records?: unknown };
  return {
    accountUnresolved: r.accountUnresolved === true,
    season: typeof r.season === "string" ? r.season : "",
    riotId: typeof r.riotId === "string" ? r.riotId : null,
    records: Array.isArray(r.records)
      ? r.records.map(normalizeRecord).filter((x): x is MyStatsRecord => x !== null)
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
