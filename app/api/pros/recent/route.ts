import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { mapProRecentRow, type ProRecentRow } from "@/lib/pros/recentModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Defensive against a mock/driver returning something unexpected for a call
 *  it wasn't explicitly configured for, matching app/api/pros/route.ts's
 *  own asRows() posture. */
function asRows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * GET /api/pros/recent?limit=<n> (default 20, cap 50)
 * Most recent pro-play (prostage) games across every tracked player and
 * tournament, newest first -- a flat activity feed, distinct from /api/pros'
 * per-champion/per-player lookup (which requires exactly one of
 * championId/proId/player).
 *
 * Public esports data (not per-user), but an EMPTY result still gets
 * `no-store` -- same posture as /api/pros (see lib/pro/db.ts's header for the
 * exact 2026-07-11 prod incident this guards against: an empty response
 * cached at the edge while a table was still populating pins "no games" for
 * everyone until the next deploy).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    if (!/^\d+$/.test(limitParam) || parseInt(limitParam, 10) <= 0) {
      return NextResponse.json({ error: "Invalid limit param" }, { status: 400 });
    }
    limit = Math.min(parseInt(limitParam, 10), MAX_LIMIT);
  }

  const sql = getSql();
  if (!sql) {
    // No DB configured -- the app must still build and run locally.
    return NextResponse.json({ games: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const rows = await sql`
      SELECT
        pm.game_id, pm.player_link, pm.team, pm.champion_id, pm.champion_name, pm.role,
        pm.win, pm.kills, pm.deaths, pm.assists, pm.tournament_display,
        p.name AS pro_name, p.team AS pro_team
      FROM coachbuild.prostage_matches pm
      LEFT JOIN coachbuild.pros p ON p.id = pm.pro_id
      ORDER BY pm.game_datetime DESC
      LIMIT ${limit}
    `;
    const games = asRows<ProRecentRow>(rows).map(mapProRecentRow);

    return NextResponse.json(
      { games },
      { headers: { "Cache-Control": games.length > 0 ? "s-maxage=1800, stale-while-revalidate=3600" : "no-store" } }
    );
  } catch (err) {
    console.error("[/api/pros/recent] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
