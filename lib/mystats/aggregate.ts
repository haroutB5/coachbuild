// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/aggregate.ts — PURE aggregation math over already-fetched
// coachbuild.my_matches rows. No DB/network — the routes do one broad,
// already-filtered SELECT and hand the rows here, same "queries in the
// route/orchestration layer, arithmetic in a pure module" split as
// lib/draft/score.ts (which this feature's data explicitly must NOT feed
// into — see PersonalRecord's doc comment in lib/draft/recommend.ts).
//
// A personal account has at most a few hundred rows ever (one player's own
// match history, not a roster) — aggregating in JS rather than SQL GROUP BY
// is deliberate: it keeps this file dependency-free and directly unit-
// testable with plain fixtures, and the data volume makes the performance
// difference between the two approaches immaterial.
// ─────────────────────────────────────────────────────────────────────────────

import { aggregateCs, csPerMinForGame, type CsInput } from "./cs";

export interface MyMatchRecord {
  championId: number;
  role: number;
  oppChampionId: number | null;
  win: boolean;
  gameCreation: string; // ISO
  /** Migration 0021. OPTIONAL on this input shape so every existing caller
   *  (and every existing fixture) compiles unchanged; absent is treated
   *  identically to null, i.e. NOT MEASURED — see lib/mystats/cs.ts. */
  cs?: number | null;
  gameDurationSec?: number | null;
}

export interface ChampionSummary {
  championId: number;
  role: number;
  games: number;
  wins: number;
  winrate: number;
  lastPlayed: string; // ISO
  /** TIME-WEIGHTED CS/min for this champion+role — sum(cs)/(sum(sec)/60), NOT
   *  the mean of per-game rates (lib/mystats/cs.ts's header has the worked
   *  example of how far apart those two answers land). null when csGames is 0. */
  csPerMin: number | null;
  /** How many of `games` are actually behind csPerMin. ALWAYS <= games and
   *  routinely smaller — unbackfilled pre-0021 rows and sub-CS_MIN_GAME_SEC
   *  games are excluded. Shipped BESIDE csPerMin for the same reason
   *  nOnBuild/nOffBuild were added to BuildAdherenceSummary in v0.74: a rate
   *  over 3 games and a rate over 300 must not be renderable identically. */
  csGames: number;
}

export interface OpponentMatchup {
  oppChampionId: number;
  games: number;
  wins: number;
  winrate: number;
}

/** Per-(championId, role) records, sorted by games DESC then winrate DESC
 *  (most-played first — ties broken by the stronger record, championId ASC
 *  as a final stable tiebreak so output order is deterministic). */
export function summarizeByChampion(rows: MyMatchRecord[]): ChampionSummary[] {
  const map = new Map<
    string,
    {
      championId: number;
      role: number;
      games: number;
      wins: number;
      lastPlayed: string;
      /** Raw CS rows for this group, aggregated ONLY at the end via
       *  lib/mystats/cs.ts. Accumulating a running rate here instead would
       *  reintroduce exactly the mean-of-rates error that module exists to
       *  prevent. */
      csRows: CsInput[];
    }
  >();
  for (const r of rows) {
    const key = `${r.championId}:${r.role}`;
    const entry = map.get(key) ?? {
      championId: r.championId,
      role: r.role,
      games: 0,
      wins: 0,
      lastPlayed: r.gameCreation,
      csRows: [] as CsInput[],
    };
    entry.games += 1;
    if (r.win) entry.wins += 1;
    if (r.gameCreation > entry.lastPlayed) entry.lastPlayed = r.gameCreation;
    // Pushed unconditionally, including rows whose cs is absent/null or whose
    // game was too short -- aggregateCs owns that filtering, so there is one
    // place to change it and `csGames` always reports what actually counted.
    entry.csRows.push({ cs: r.cs ?? null, gameDurationSec: r.gameDurationSec ?? null });
    map.set(key, entry);
  }
  return Array.from(map.values())
    .map(({ csRows, ...e }) => {
      const cs = aggregateCs(csRows);
      return { ...e, winrate: e.wins / e.games, csPerMin: cs.csPerMin, csGames: cs.games };
    })
    .sort((a, b) => b.games - a.games || b.winrate - a.winrate || a.championId - b.championId);
}

/** My record playing `championId` against exactly `oppChampionId` (any
 *  role present in `rows` — callers filter rows to one role beforehand if
 *  they want a role-scoped record). Null when there are zero such games —
 *  distinct from a real {games:0,...}, since there's nothing to report at
 *  all (see this feature's `/api/mystats/summary` doc comment for how the
 *  route surfaces this). */
export function summarizeMatchup(rows: MyMatchRecord[], oppChampionId: number): { games: number; wins: number; winrate: number } | null {
  const matching = rows.filter((r) => r.oppChampionId === oppChampionId);
  if (matching.length === 0) return null;
  const wins = matching.filter((r) => r.win).length;
  return { games: matching.length, wins, winrate: wins / matching.length };
}

/** All of my matchups on one champion, grouped by lane opponent, sorted by
 *  games DESC then championId ASC. Rows with a null oppChampionId (role
 *  unresolved, e.g. ARAM) are excluded — there's no opponent to group by. */
export function summarizeMatchupsByOpponent(rows: MyMatchRecord[]): OpponentMatchup[] {
  const map = new Map<number, { games: number; wins: number }>();
  for (const r of rows) {
    if (r.oppChampionId === null) continue;
    const entry = map.get(r.oppChampionId) ?? { games: 0, wins: 0 };
    entry.games += 1;
    if (r.win) entry.wins += 1;
    map.set(r.oppChampionId, entry);
  }
  return Array.from(map.entries())
    .map(([oppChampionId, e]) => ({ oppChampionId, games: e.games, wins: e.wins, winrate: e.wins / e.games }))
    .sort((a, b) => b.games - a.games || a.oppChampionId - b.oppChampionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.51 additions — My Stats build-adherence + KDA (see lib/mystats/
// adherence.ts / ingest.ts / season.ts for the upstream pieces these
// aggregate). Same pure-arithmetic posture as everything else in this file.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdherenceRecord {
  win: boolean;
  /** null = no recommendation was available for this row at ingest time
   *  (see lib/mystats/adherence.ts's computeAdherence doc comment) — these
   *  rows are excluded from EVERY figure below, not counted as "off build". */
  onWpaBuild: boolean | null;
}

export interface BuildAdherenceSummary {
  /** % (0-100, one decimal) of rows WITH a resolved recommendation that were
   *  on-build. null when there are zero such rows (e.g. brand-new account,
   *  or every row predates the v0.51 ship / recommend resolution). */
  buildAdherencePct: number | null;
  /** Win rate (0-1) restricted to on-build rows; null when there are none. */
  winrateOnBuild: number | null;
  /** Win rate (0-1) restricted to off-build rows; null when there are none. */
  winrateOffBuild: number | null;
  /** Row count BEHIND winrateOnBuild -- null exactly when winrateOnBuild is
   *  null (same "no such rows" condition, never a fabricated 0). Added
   *  v0.74 so a consumer can tell a real 55% from 2 games apart from a real
   *  55% from 200 -- deliberately a DIFFERENT denominator than
   *  buildAdherencePct (which is a % of resolved rows, not a bucket count)
   *  and than any per-champion `games` total -- do not conflate them, see
   *  computeBuildWinrateDelta's doc comment in components/hextech/myStats.ts
   *  for the exact bug (v0.73.1) that conflating denominators caused here. */
  nOnBuild: number | null;
  /** Row count BEHIND winrateOffBuild -- same null convention as nOnBuild. */
  nOffBuild: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** DISPLAY ONLY (see lib/mystats/adherence.ts's header) — never feeds any
 *  score/ranking. */
export function computeBuildAdherence(rows: AdherenceRecord[]): BuildAdherenceSummary {
  const resolved = rows.filter((r) => r.onWpaBuild !== null);
  if (resolved.length === 0) {
    return { buildAdherencePct: null, winrateOnBuild: null, winrateOffBuild: null, nOnBuild: null, nOffBuild: null };
  }
  const onBuild = resolved.filter((r) => r.onWpaBuild === true);
  const offBuild = resolved.filter((r) => r.onWpaBuild === false);
  return {
    buildAdherencePct: round1((onBuild.length / resolved.length) * 100),
    winrateOnBuild: onBuild.length > 0 ? onBuild.filter((r) => r.win).length / onBuild.length : null,
    winrateOffBuild: offBuild.length > 0 ? offBuild.filter((r) => r.win).length / offBuild.length : null,
    nOnBuild: onBuild.length > 0 ? onBuild.length : null,
    nOffBuild: offBuild.length > 0 ? offBuild.length : null,
  };
}

/** Overall win rate (0-1) for a set of rows, all assumed already scoped to
 *  the prior split by the caller (this function itself is split-agnostic —
 *  it just averages whatever rows it's given). null when there are zero rows
 *  (no prior-split data at all — e.g. the account is still in its first
 *  split) rather than 0, so the UI can render "—" instead of a misleading
 *  0% delta. */
export function computePriorSplitWinrate(rows: { win: boolean }[]): number | null {
  if (rows.length === 0) return null;
  return rows.filter((r) => r.win).length / rows.length;
}

export interface RecentGameInput {
  championId: number;
  role: number;
  win: boolean;
  /** NULL on rows stored before migration 0014's KDA additions were populated.
   * Missing KDA is not the same fact as a measured 0/0/0 game. */
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  onWpaBuild: boolean | null;
  gameCreation: string; // ISO
  /** Migration 0021 — optional for the same back-compat reason as
   *  MyMatchRecord's; absent === null === NOT MEASURED. */
  cs?: number | null;
  gameDurationSec?: number | null;
  /** 2026-07-31 audit P2 (#4) — true iff `onWpaBuild === null` because this
   *  game's own patch is newer than coachless's populated data (upstream
   *  ingest lag), not because the app failed to record anything for this
   *  match. See lib/mystats/adherence.ts's isWaitingForPatchData for the
   *  full reasoning; the route computes this per-row before calling
   *  buildRecentGames, since it's the only layer that knows both this game's
   *  patch AND the currently-populated one. Optional/defaulted to false for
   *  the same back-compat reason as cs/gameDurationSec above. */
  patchDataPending?: boolean;
}

export interface RecentGame {
  championId: number;
  role: number;
  win: boolean;
  /** NULL means this historical row has no measured KDA, never a fabricated
   * zero. */
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  onWpaBuild: boolean | null;
  /** RAW creep score for this one game. null = not stored for this row. */
  cs: number | null;
  /** Game length in SECONDS. null = not stored for this row. */
  gameDurationSec: number | null;
  /** This game's own rate, 1 decimal. null when either raw field is null OR
   *  the game is under CS_MIN_GAME_SEC — a 4-minute remake's "rate" measures
   *  the game ending, not farming, so it is WITHHELD rather than shown. `cs`
   *  and `gameDurationSec` survive on such a row regardless, so a caller can
   *  still render "12 CS in 3:41" if it wants to. */
  csPerMin: number | null;
  /** See RecentGameInput's doc comment — always populated (never left
   *  optional) on the way out, so a consumer never has to guess a default. */
  patchDataPending: boolean;
}

/** Latest `limit` games, newest first — sorts here (rather than trusting the
 *  caller's SQL ORDER BY) so this stays independently correct/testable with
 *  out-of-order fixtures, same posture as every other function in this file. */
export function buildRecentGames(rows: RecentGameInput[], limit = 5): RecentGame[] {
  return rows
    .slice()
    .sort((a, b) => (a.gameCreation < b.gameCreation ? 1 : a.gameCreation > b.gameCreation ? -1 : 0))
    .slice(0, limit)
    .map(({ gameCreation: _gameCreation, cs = null, gameDurationSec = null, patchDataPending = false, ...rest }) => ({
      ...rest,
      cs,
      gameDurationSec,
      csPerMin: csPerMinForGame({ cs, gameDurationSec }),
      patchDataPending,
    }));
}

/** Account-wide CS/min headline — the KPI tile. Same TIME-WEIGHTED arithmetic
 *  as every other figure here, over whatever scope the caller's rows represent
 *  (the summary route passes the CURRENT SPLIT, matching buildAdherencePct).
 *
 *  Deliberately NOT derived by averaging summarizeByChampion's per-champion
 *  csPerMin values: that would be a mean of rates one level up, weighting a
 *  3-game champion equally with a 90-game one. It re-aggregates from the raw
 *  rows instead, which is the whole reason migration 0021 stores raw columns. */
export function computeCsSummary(rows: MyMatchRecord[]): { csPerMin: number | null; csGames: number } {
  const cs = aggregateCs(rows.map((r) => ({ cs: r.cs ?? null, gameDurationSec: r.gameDurationSec ?? null })));
  return { csPerMin: cs.csPerMin, csGames: cs.games };
}
