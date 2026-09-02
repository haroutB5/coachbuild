import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId } from "@/lib/types";
import { buildRecommendations } from "@/lib/recommend";
import { resolveRankBracket } from "@/lib/rankBrackets";
import { MAX_REAL_CHAMPION_ID } from "@/lib/staticData";
import { buildLastGoodKey, resolveBuildWithFallback } from "@/lib/buildFallback";
import { runtimeLastGoodStore } from "@/lib/lastGood";

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

  // Alternate-art / skin entries live in the 60000+ id range (real champions
  // top out in the 900s; MAX_REAL_CHAMPION_ID = 10000). Coachless's own roster
  // KNOWS these ids, so the downstream existence check passes and then the
  // stats POST throws on a champion that has no gameplay rows — surfacing as a
  // 500 (e.g. GET /api/build?champ=60001&role=2). The draft ingest path already
  // filters this range before any upstream request (lib/draft/ingest.ts); do
  // the same here so an alt-art id gets the clean "not played" 404, not a 500.
  // Filtered BEFORE the upstream call, and reusing the shared constant rather
  // than a fresh magic number.
  if (champId >= MAX_REAL_CHAMPION_ID) {
    const body: ApiError = { error: "Champion not played in this role" };
    return NextResponse.json(body, { status: 404 });
  }

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

  // Optional rank bracket. Absent/'' → the single Diamond+ bracket. An
  // unknown id — which since 2026-08-11 includes every RETIRED id (all,
  // emerald, platinum, ...) — is a client error (400) rather than a silent
  // fallback, so a stale client can never be served a tier set it asked for
  // by a name that no longer means what it did.
  const bracket = resolveRankBracket(rankParam);
  if (bracket === null) {
    const body: ApiError = { error: "Invalid rank bracket" };
    return NextResponse.json(body, { status: 400 });
  }

  // 0.122.0 (backlog 9): degrade instead of empty. A coachless 403/5xx/timeout
  // used to be a 500 here and an empty Builds page; now it is the last
  // known-good copy for this exact key, labelled `stale: true` + `asOf`, when
  // the runtime cache holds one. A 404 stays a 404: "not played in this role"
  // is a fact about the data, never papered over. See lib/buildFallback.ts.
  const resolution = await resolveBuildWithFallback({
    key: buildLastGoodKey(champId, roleId, bracket.id, enemyChampionId),
    compute: () => buildRecommendations(champId, roleId, { enemyChampionId, rankBracket: bracket }),
    store: runtimeLastGoodStore(),
  });

  switch (resolution.kind) {
    case "fresh":
      // Returns the top-3 recommended setups (BuildResponse[]). The CDN caches
      // per full query string, so enemyChampionId + rank each key their own
      // entry. `stale-if-error` is the CDN's own second layer under the runtime
      // cache: an edge that still holds an expired copy may serve it while the
      // origin is erroring, for up to a week.
      return NextResponse.json(resolution.builds, {
        headers: {
          "Cache-Control": "s-maxage=21600, stale-while-revalidate=86400, stale-if-error=604800",
        },
      });
    case "stale":
      // Short at the edge on purpose: the copy is already old, and the point
      // is to keep asking the origin so recovery is minutes, not hours, while
      // still bounding how many failing coachless calls one outage can cost.
      console.warn(
        `[/api/build] upstream failed, served last known-good copy for champ=${champId} role=${roleId} asOf=${resolution.asOf}`
      );
      return NextResponse.json(resolution.builds, {
        headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=300" },
      });
    case "not-played": {
      const body: ApiError = {
        error: "Champion not played in this role",
        detail: resolution.detail,
      };
      return NextResponse.json(body, { status: 404 });
    }
    case "error": {
      // Log full error server-side; do not leak internals to the client.
      console.error("[/api/build] Unexpected error:", resolution.error);
      const body: ApiError = { error: "Internal server error" };
      return NextResponse.json(body, { status: 500 });
    }
  }
}
