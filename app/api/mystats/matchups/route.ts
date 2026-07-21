import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getMyAccount } from "@/lib/mystats/account";
import { summarizeMatchupsByOpponent, type MyMatchRecord } from "@/lib/mystats/aggregate";
import { SEASON_LABEL } from "@/lib/mystats/season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  role: number;
  opp_champion_id: number | null;
  win: boolean;
  game_creation: string;
}

/**
 * GET /api/mystats/matchups?championId=<n> (required)
 * All of my recorded matchups on one champion, grouped by lane opponent.
 * Per-user private data -> always `no-store` (see summary route's doc
 * comment — same posture). DISPLAY DATA ONLY, same no-blending posture as
 * /api/mystats/summary — see lib/draft/recommend.ts's PersonalPlayResult.
 */
export async function GET(req: NextRequest) {
  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const { searchParams } = new URL(req.url);
  const championIdParam = searchParams.get("championId");
  if (!championIdParam || !/^\d+$/.test(championIdParam)) {
    return NextResponse.json({ error: "Missing or invalid championId param" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const championId = parseInt(championIdParam, 10);

  try {
    const account = await getMyAccount(sql);
    if (!account) {
      return NextResponse.json(
        { accountUnresolved: true, season: SEASON_LABEL, championId, matchups: [] },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    const rows = (await sql`
      SELECT role, opp_champion_id, win, game_creation
      FROM coachbuild.my_matches
      WHERE champion_id = ${championId}
    `) as unknown as Row[];

    const records: MyMatchRecord[] = rows.map((r) => ({
      championId,
      role: r.role,
      oppChampionId: r.opp_champion_id,
      win: r.win,
      gameCreation: r.game_creation,
    }));

    return NextResponse.json(
      { accountUnresolved: false, season: SEASON_LABEL, championId, matchups: summarizeMatchupsByOpponent(records) },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/mystats/matchups] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
