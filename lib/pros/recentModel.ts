// ─────────────────────────────────────────────────────────────────────────────
// lib/pros/recentModel.ts — pure row-shaping for GET /api/pros/recent (v0.51
// Wave B: Pro Players recent feed). Split out from the route per this repo's
// "queries in the route, shaping in a pure module" convention (lib/mystats/
// aggregate.ts, lib/patchMovers.ts's pure section) — name/team cleanup +
// role-sentinel handling is directly unit-testable without a DB.
// ─────────────────────────────────────────────────────────────────────────────

import { cleanLeaguepediaName } from "@/lib/prostage/displayName";
import type { DisplayRoleId } from "@/lib/pro/types";

export interface ProRecentRow {
  game_id: string;
  player_link: string;
  team: string | null;
  champion_id: number;
  champion_name: string;
  role: number | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  tournament_display: string;
  /** LEFT JOINed from coachbuild.pros — null for an untracked player. */
  pro_name: string | null;
  pro_team: string | null;
}

export interface ProRecentGame {
  gameId: string;
  playerLink: string;
  playerName: string;
  team: string | null;
  championId: number;
  championName: string;
  role: DisplayRoleId;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  event: string;
}

/** Mirrors app/api/pros/route.ts's prostageRowToProGame naming conventions:
 *  pro_name/pro_team (from a tracked coachbuild.pros row, already clean) win
 *  over the raw Leaguepedia player_link/team strings, which need cleaning
 *  (cleanLeaguepediaName strips the "(Real Name)" disambiguator suffix an
 *  untracked player's raw link/team can carry).
 *
 *  `event` is exactly `tournament_display`, nothing appended -- migrations/
 *  0002_prostage.sql has no round/stage column at all (verified by reading
 *  the schema, not guessed) and `patch` on this table is confirmed always
 *  NULL, so neither can contribute a suffix. */
export function mapProRecentRow(row: ProRecentRow): ProRecentGame {
  return {
    gameId: row.game_id,
    playerLink: row.player_link,
    playerName: row.pro_name ?? cleanLeaguepediaName(row.player_link),
    team: row.pro_team ?? (row.team ? cleanLeaguepediaName(row.team) : row.team),
    championId: row.champion_id,
    championName: row.champion_name,
    role: (row.role ?? -1) as DisplayRoleId,
    win: row.win,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    event: row.tournament_display,
  };
}
