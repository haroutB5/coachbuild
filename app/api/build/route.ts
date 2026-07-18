import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId } from "@/lib/types";
import { buildRecommendations, NotPlayedInRoleError } from "@/lib/recommend";
import { resolveRankBracket } from "@/lib/rankBrackets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const champParam = searchParams.get("champ");
  const roleParam = searchParams.get("role");
  // Optional additive params (Feature 1 matchup, Feature 3 rank brackets).
  const enemyParam = searchParams.get("enemyChampionId");
  const rankParam = searchParams.get("rank");

  if (!champParam || !roleParam) {
    const body: ApiError = { error: "Missing required query params: champ, role" };
    return NextResponse.json(body, { status: 400 });
  }

  // Strict integer params (reject "2x", "86.5", etc.).
  if (!/^\d+$/.test(champParam) || !/^\d+$/.test(roleParam)) {
    const body: ApiError = { error: "Invalid champ or role param" };
    return NextResponse.json(body, { status: 400 });
  }
  const champId = parseInt(champParam, 10);
  const roleId = parseInt(roleParam, 10) as RoleId;

  if (roleId < 0 || roleId > 5) {
    const body: ApiError = { error: "Invalid role (must be 0-5)" };
    return NextResponse.json(body, { status: 400 });
  }

  // Feature 1: optional enemy champion id (matchup). Strict integer if present.
  let enemyChampionId: number | null = null;
  if (enemyParam != null && enemyParam !== "") {
    if (!/^\d+$/.test(enemyParam)) {
      const body: ApiError = { error: "Invalid enemyChampionId param" };
      return NextResponse.json(body, { status: 400 });
    }
    enemyChampionId = parseInt(enemyParam, 10);
  }

  // Feature 3: optional rank bracket. Absent/'' → default (High Elo). An
  // unknown id is a client error (400) rather than a silent fallback.
  const bracket = resolveRankBracket(rankParam);
  if (bracket === null) {
    const body: ApiError = { error: "Invalid rank bracket" };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const builds = await buildRecommendations(champId, roleId, {
      enemyChampionId,
      rankBracket: bracket,
    });
    if (!builds || builds.length === 0) {
      const body: ApiError = { error: "Champion not played in this role" };
      return NextResponse.json(body, { status: 404 });
    }
    // Returns the top-3 recommended setups (BuildResponse[]). The CDN caches per
    // full query string, so enemyChampionId + rank each key their own entry.
    return NextResponse.json(builds, {
      headers: {
        "Cache-Control": "s-maxage=21600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    if (err instanceof NotPlayedInRoleError) {
      const body: ApiError = {
        error: "Champion not played in this role",
        detail: err.message,
      };
      return NextResponse.json(body, { status: 404 });
    }
    // Log full error server-side; do not leak internals to the client.
    console.error("[/api/build] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500 });
  }
}
