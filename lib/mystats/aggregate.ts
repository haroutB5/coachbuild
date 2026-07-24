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

export interface MyMatchRecord {
  championId: number;
  role: number;
  oppChampionId: number | null;
  win: boolean;
  gameCreation: string; // ISO
}

export interface ChampionSummary {
  championId: number;
  role: number;
  games: number;
  wins: number;
  winrate: number;
  lastPlayed: string; // ISO
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
    { championId: number; role: number; games: number; wins: number; lastPlayed: string }
  >();
  for (const r of rows) {
    const key = `${r.championId}:${r.role}`;
    const entry = map.get(key) ?? {
      championId: r.championId,
      role: r.role,
      games: 0,
      wins: 0,
      lastPlayed: r.gameCreation,
    };
    entry.games += 1;
    if (r.win) entry.wins += 1;
    if (r.gameCreation > entry.lastPlayed) entry.lastPlayed = r.gameCreation;
    map.set(key, entry);
  }
  return Array.from(map.values())
    .map((e) => ({ ...e, winrate: e.wins / e.games }))
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
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** DISPLAY ONLY (see lib/mystats/adherence.ts's header) — never feeds any
 *  score/ranking. */
export function computeBuildAdherence(rows: AdherenceRecord[]): BuildAdherenceSummary {
  const resolved = rows.filter((r) => r.onWpaBuild !== null);
  if (resolved.length === 0) {
    return { buildAdherencePct: null, winrateOnBuild: null, winrateOffBuild: null };
  }
  const onBuild = resolved.filter((r) => r.onWpaBuild === true);
  const offBuild = resolved.filter((r) => r.onWpaBuild === false);
  return {
    buildAdherencePct: round1((onBuild.length / resolved.length) * 100),
    winrateOnBuild: onBuild.length > 0 ? onBuild.filter((r) => r.win).length / onBuild.length : null,
    winrateOffBuild: offBuild.length > 0 ? offBuild.filter((r) => r.win).length / offBuild.length : null,
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
  kills: number;
  deaths: number;
  assists: number;
  onWpaBuild: boolean | null;
  gameCreation: string; // ISO
}

export interface RecentGame {
  championId: number;
  role: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  onWpaBuild: boolean | null;
}

/** Latest `limit` games, newest first — sorts here (rather than trusting the
 *  caller's SQL ORDER BY) so this stays independently correct/testable with
 *  out-of-order fixtures, same posture as every other function in this file. */
export function buildRecentGames(rows: RecentGameInput[], limit = 5): RecentGame[] {
  return rows
    .slice()
    .sort((a, b) => (a.gameCreation < b.gameCreation ? 1 : a.gameCreation > b.gameCreation ? -1 : 0))
    .slice(0, limit)
    .map(({ gameCreation: _gameCreation, ...rest }) => rest);
}
