import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import type { ProGame, ProGamePurchase, ProGameRunes, ProRoleId, ProsResponse } from "@/lib/pro/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProGameRow {
  match_id: string;
  champion_id: number;
  champion_name: string;
  role: number;
  patch: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  game_creation: string | Date;
  game_duration_sec: number;
  spells: unknown;
  final_items: unknown;
  trinket: number | null;
  purchase_order: unknown;
  skill_order: unknown;
  runes: unknown;
  pro_name: string;
  pro_team: string | null;
  pro_role: number | null;
  pro_country: string | null;
  riot_id: string;
  region: string;
}

/** jsonb columns generally come back pre-parsed from the neon driver, but
 *  accept a JSON string too — defensive against driver-version drift. */
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

function rowToProGame(row: ProGameRow): ProGame {
  return {
    id: row.match_id,
    source: "soloq",
    player: {
      name: row.pro_name,
      team: row.pro_team,
      role: (row.pro_role ?? row.role) as ProRoleId,
      country: row.pro_country,
    },
    account: { riotId: row.riot_id, region: row.region },
    championId: row.champion_id,
    championName: row.champion_name,
    role: row.role as ProRoleId,
    patch: row.patch,
    win: row.win,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    gameCreation: new Date(row.game_creation).toISOString(),
    gameDurationSec: row.game_duration_sec,
    spells: asJson<[number, number]>(row.spells, [0, 0]),
    finalItems: asJson<number[]>(row.final_items, []),
    trinket: row.trinket ?? null,
    purchaseOrder: asJson<ProGamePurchase[]>(row.purchase_order, []),
    skillOrder: asJson<string[]>(row.skill_order, []),
    runes: asJson<ProGameRunes>(row.runes, {
      primaryTree: 0,
      keystone: 0,
      primary: [],
      secondaryTree: 0,
      secondary: [],
      shards: [],
    }),
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const champParam = searchParams.get("championId");
  const roleParam = searchParams.get("role");
  const limitParam = searchParams.get("limit");

  if (!champParam || !roleParam) {
    return NextResponse.json({ error: "Missing required query params: championId, role" }, { status: 400 });
  }
  if (!/^\d+$/.test(champParam) || !/^\d+$/.test(roleParam)) {
    return NextResponse.json({ error: "Invalid championId or role param" }, { status: 400 });
  }
  const championId = parseInt(champParam, 10);
  // 0-4 = concrete lane filter; 5 = "auto" (the app's default role state after
  // every champion pick) = no lane filter. The page passes its role state
  // through verbatim, so rejecting 5 here would error the section on the most
  // common interaction path.
  const role = parseInt(roleParam, 10);
  if (role < 0 || role > 5) {
    return NextResponse.json({ error: "Invalid role (must be 0-5)" }, { status: 400 });
  }

  let limit = 20;
  if (limitParam) {
    if (!/^\d+$/.test(limitParam) || parseInt(limitParam, 10) <= 0) {
      return NextResponse.json({ error: "Invalid limit param" }, { status: 400 });
    }
    limit = Math.min(parseInt(limitParam, 10), 100);
  }

  const sql = getSql();
  if (!sql) {
    // No DB configured — the app must still build and run locally.
    const body: ProsResponse = { games: [] };
    return NextResponse.json(body);
  }

  try {
    const rows = (await sql`
      SELECT
        pm.match_id, pm.champion_id, pm.champion_name, pm.role, pm.patch, pm.win,
        pm.kills, pm.deaths, pm.assists, pm.game_creation, pm.game_duration_sec,
        pm.spells, pm.final_items, pm.trinket, pm.purchase_order, pm.skill_order, pm.runes,
        p.name AS pro_name, p.team AS pro_team, p.role AS pro_role, p.country AS pro_country,
        pa.riot_id, pa.region
      FROM coachbuild.pro_matches pm
      JOIN coachbuild.pros p ON p.id = pm.pro_id
      JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
      WHERE pm.champion_id = ${championId} AND (${role} = 5 OR pm.role = ${role})
      ORDER BY pm.game_creation DESC
      LIMIT ${limit}
    `) as unknown as ProGameRow[];

    const body: ProsResponse = { games: rows.map(rowToProGame) };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" },
    });
  } catch (err) {
    console.error("[/api/pros] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
