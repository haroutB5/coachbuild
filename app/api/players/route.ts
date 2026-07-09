import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import type { Player, PlayersResponse, ProRoleId } from "@/lib/pro/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlayerRow {
  id: string;
  name: string;
  slug: string;
  team: string | null;
  role: number | null;
  country: string | null;
  game_count: number;
}

function rowToPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    team: row.team,
    role: (row.role ?? null) as ProRoleId | null,
    country: row.country,
    gameCount: row.game_count,
  };
}

/** Escapes ILIKE metacharacters (`%`, `_`) — and the escape char itself —
 *  so user input matches literally rather than as a wildcard pattern.
 *  Postgres's default LIKE/ILIKE escape character is backslash, so no
 *  explicit ESCAPE clause is needed once this is applied. */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const qParam = searchParams.get("q");

  if (qParam === null) {
    return NextResponse.json({ error: "Missing required query param: q" }, { status: 400 });
  }
  const q = qParam.trim();
  if (q.length < 1 || q.length > 40) {
    return NextResponse.json({ error: "q must be 1-40 characters" }, { status: 400 });
  }

  const sql = getSql();
  if (!sql) {
    const body: PlayersResponse = { players: [] };
    return NextResponse.json(body);
  }

  try {
    const pattern = `%${escapeLikePattern(q)}%`;
    const rows = (await sql`
      SELECT
        p.id, p.name, p.slug, p.team, p.role, p.country,
        COUNT(pm.match_id)::int AS game_count
      FROM coachbuild.pros p
      LEFT JOIN coachbuild.pro_matches pm ON pm.pro_id = p.id
      WHERE p.name ILIKE ${pattern}
      GROUP BY p.id, p.name, p.slug, p.team, p.role, p.country
      ORDER BY game_count DESC, p.name ASC
      LIMIT 10
    `) as unknown as PlayerRow[];

    const body: PlayersResponse = { players: rows.map(rowToPlayer) };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (err) {
    console.error("[/api/players] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
