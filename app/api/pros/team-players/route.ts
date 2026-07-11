// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pros/team-players — on-demand allyPlayers/enemyPlayers for ONE
// game, fetched when the game-detail sheet opens.
//
// P1 perf fix (2026-07-11): these fields used to ride on every GET /api/pros
// list-response row and accounted for 23.5kB of a 44.7kB payload — dead
// weight on every list render since the sheet only reads them on open. Moved
// here; GET /api/pros keeps allyChampionIds/enemyChampionIds (card strips)
// and allyTeamName/enemyTeamName (header matchup line — tiny) inline.
//
// Contract (fronty builds the sheet against this EXACTLY):
//   soloq:    ?source=soloq&gameId=<matchId>&championId=<n>
//             championId identifies the tracked player's row perspective —
//             a match_id can (rarely) hold more than one tracked pro's row,
//             but never two rows with the same champion_id (League has no
//             mirror picks in queue 420).
//   prostage: ?source=prostage&gameId=<game_id>&player=<player_link>
//             player is the RAW Leaguepedia player_link (same param style as
//             GET /api/prostage/timeline), not the cleaned display name.
//
//   200 {allyPlayers:[...5], enemyPlayers:[...5]}  TeamCompPlayer[] exactly
//        as the old inline shape (role-ordered, cleaned names, proId).
//   200 {allyPlayers:null, enemyPlayers:null}  no such row, or no clean 5v5
//        split — never a partial side.
//   400  bad/missing params.
//   500  unexpected error (no detail leak).
//
// Cache-Control: non-empty result -> s-maxage=86400 (the underlying match/
// game data is immutable once backfilled, long cache is safe — same
// reasoning as GET /api/prostage/timeline's "ok" branch). null/degraded ->
// no-store (never CDN-cache empty/failed data, see lib/pro/db.ts's Gotcha).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { buildProstageCompsMap, orderedSidesForGame, type ProstageCompRow } from "@/lib/prostage/teamComps";
import type { TeamCompPlayer, TeamPlayersResponse } from "@/lib/pro/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SOURCES = new Set(["soloq", "prostage"]);
const MAX_PARAM_LEN = 300;

const EMPTY_RESULT: TeamPlayersResponse = { allyPlayers: null, enemyPlayers: null };
const NO_STORE = { "Cache-Control": "no-store" } as const;
// Same long cache used by GET /api/prostage/timeline's "ok" branch — this
// data is immutable once backfilled (a resolved match/game never changes).
const LONG_CACHE = { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } as const;

/** jsonb columns generally come back pre-parsed from the neon driver, but
 *  accept a JSON string too — defensive against driver-version drift, same
 *  posture as app/api/pros/route.ts's asJson. */
function asJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

/** Defensive against a mock/driver returning a non-array (same posture as
 *  app/api/pros/route.ts's asRows). */
function asRows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

interface SoloqTeamPlayersRow {
  ally_players: unknown;
  enemy_players: unknown;
}

async function handleSoloq(
  sql: NonNullable<ReturnType<typeof getSql>>,
  gameId: string,
  championIdParam: string | null
): Promise<NextResponse> {
  if (!championIdParam || !/^\d+$/.test(championIdParam)) {
    return NextResponse.json({ error: "Missing or invalid championId param" }, { status: 400 });
  }
  const championId = parseInt(championIdParam, 10);

  const rows = await sql`
    SELECT ally_players, enemy_players
    FROM coachbuild.pro_matches
    WHERE match_id = ${gameId} AND champion_id = ${championId}
  `;
  const row = asRows<SoloqTeamPlayersRow>(rows)[0];
  if (!row) {
    return NextResponse.json(EMPTY_RESULT, { headers: NO_STORE });
  }

  const ally = asJson<TeamCompPlayer[] | null>(row.ally_players, null);
  const enemy = asJson<TeamCompPlayer[] | null>(row.enemy_players, null);
  if (ally && enemy && ally.length === 5 && enemy.length === 5) {
    return NextResponse.json({ allyPlayers: ally, enemyPlayers: enemy }, { headers: LONG_CACHE });
  }
  return NextResponse.json(EMPTY_RESULT, { headers: NO_STORE });
}

async function handleProstage(
  sql: NonNullable<ReturnType<typeof getSql>>,
  gameId: string,
  player: string | null
): Promise<NextResponse> {
  if (!player || player.length === 0 || player.length > MAX_PARAM_LEN) {
    return NextResponse.json({ error: "Missing or invalid player param" }, { status: 400 });
  }

  // 1. Find the requested row's own team — the ally/enemy split pivots on
  // this exact game_id + player_link identity (migration 0002's PK).
  const ownRows = await sql`
    SELECT team
    FROM coachbuild.prostage_matches
    WHERE game_id = ${gameId} AND player_link = ${player}
  `;
  const ownRow = asRows<{ team: string | null }>(ownRows)[0];
  if (!ownRow) {
    return NextResponse.json(EMPTY_RESULT, { headers: NO_STORE });
  }

  // 2. Grouped comps query for this ONE game (not batched over many game_ids
  // like app/api/pros/route.ts's list-response version — this endpoint only
  // ever serves one game at a time) + the pros name-index for the proId
  // fallback match — same shared helpers as the list route, so the two can
  // never disagree on grouping/ordering/cleaning logic.
  const [compsRawRows, prosNameRows] = await Promise.all([
    sql`
      SELECT pm.game_id, pm.team, pm.champion_id, pm.role, p.role AS pro_role,
             pm.player_link, pm.final_items, pm.trinket, p.name AS pro_name, pm.pro_id
      FROM coachbuild.prostage_matches pm
      LEFT JOIN coachbuild.pros p ON p.id = pm.pro_id
      WHERE pm.game_id = ${gameId}
        AND pm.team IS NOT NULL AND pm.champion_id IS NOT NULL
    `,
    sql`SELECT id, name FROM coachbuild.pros`,
  ]);

  const proByName = new Map(
    asRows<{ id: string; name: string }>(prosNameRows)
      .filter((p): p is { id: string; name: string } => typeof p?.name === "string" && typeof p?.id === "string")
      .map((p) => [p.name.trim().toLowerCase(), p.id])
  );
  const compsByGame = buildProstageCompsMap(asRows<ProstageCompRow>(compsRawRows), proByName);
  const sides = orderedSidesForGame(compsByGame, gameId, ownRow.team);

  if (!sides) {
    return NextResponse.json(EMPTY_RESULT, { headers: NO_STORE });
  }
  return NextResponse.json({ allyPlayers: sides.ally, enemyPlayers: sides.enemy }, { headers: LONG_CACHE });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get("source");
  const gameId = searchParams.get("gameId");

  if (!source || !VALID_SOURCES.has(source)) {
    return NextResponse.json({ error: "Invalid or missing source param (must be soloq or prostage)" }, { status: 400 });
  }
  if (!gameId || gameId.length === 0 || gameId.length > MAX_PARAM_LEN) {
    return NextResponse.json({ error: "Missing or invalid gameId param" }, { status: 400 });
  }

  const sql = getSql();
  if (!sql) {
    // No DB configured — degrade like the rest of the Pro's page rather than
    // 500ing the sheet open.
    return NextResponse.json(EMPTY_RESULT, { headers: NO_STORE });
  }

  try {
    if (source === "soloq") {
      return await handleSoloq(sql, gameId, searchParams.get("championId"));
    }
    return await handleProstage(sql, gameId, searchParams.get("player"));
  } catch (err) {
    console.error("[/api/pros/team-players] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
