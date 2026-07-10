// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prostage/timeline?gameId=<prostage game_id>&player=<player_link>
//
// Lazy, compute-once, serve-forever item build order for an on-stage (prostage)
// game — the piece missing from the pro-play card ("Purchase and skill order
// detail isn't available for on-stage games"). First request for a game resolves
// it to a lolesports esports id, walks the free livestats feed, and persists all
// 10 players' purchase_order to coachbuild.prostage_matches; every later request
// (any player of that game) serves straight from the DB.
//
// Contract (fronty builds the sheet against this EXACTLY):
//   200 {status:"ok", purchaseOrder:[{itemId, ts}, ...]}
//        purchaseOrder elements are the SAME shape as soloq ProGamePurchase
//        (ts = SECONDS into the game).
//   200 {status:"unavailable", reason:"..."}
//        terminal: game maps to no lolesports id / feed genuinely has no data.
//   500 {error:"..."}  a TRANSIENT feed/API failure — retry later; never
//        persisted as unavailable.
//   400 {error:"..."}  bad/missing params, or player not in this game.
//
// The compute runs synchronously within the request (maxDuration raised, like
// matchday's route) — no async "pending" state machine.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { computeGameTimelines, type TimelineDbRow } from "@/lib/prostage/resolveGame";
import type { ProGamePurchase } from "@/lib/pro/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cold walk (resolve + up to ~250 details pages / 12 concurrency + ddragon) is
// comfortably under 30s; a warm (already-computed) game returns in one SELECT.
export const maxDuration = 30;

const MAX_PARAM_LEN = 300;

/** jsonb comes back pre-parsed from the neon driver, but tolerate a JSON string
 *  too (driver-version drift) — matches app/api/pros/route.ts's asJson posture. */
function asPurchaseOrder(v: unknown): ProGamePurchase[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as ProGamePurchase[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as ProGamePurchase[]) : [];
}

interface RequestedRow {
  purchase_order: unknown;
  timeline_status: string | null;
}

interface GameRow {
  player_link: string;
  team: string | null;
  champion_id: number;
  game_datetime: string | Date;
  overview_page: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const gameId = searchParams.get("gameId");
  const player = searchParams.get("player");

  if (!gameId || !player) {
    return NextResponse.json({ error: "Missing required query params: gameId, player" }, { status: 400 });
  }
  if (gameId.length > MAX_PARAM_LEN || player.length > MAX_PARAM_LEN) {
    return NextResponse.json({ error: "Param too long" }, { status: 400 });
  }

  const sql = getSql();
  if (!sql) {
    // DB genuinely required here — a transient infra condition, not a terminal
    // "unavailable". 503 so the client retries rather than caching no-data.
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    // 1. Fast path: the requested player's row already resolved.
    const requested = (await sql`
      SELECT purchase_order, timeline_status
      FROM coachbuild.prostage_matches
      WHERE game_id = ${gameId} AND player_link = ${player}
    `) as unknown as RequestedRow[];

    if (requested.length === 0) {
      return NextResponse.json({ error: "player not in this game" }, { status: 400 });
    }
    const status = requested[0].timeline_status;
    if (status === "ok") {
      return NextResponse.json(
        { status: "ok", purchaseOrder: asPurchaseOrder(requested[0].purchase_order) },
        { headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } }
      );
    }
    if (status === "unavailable") {
      return NextResponse.json(
        { status: "unavailable", reason: "no in-game timeline available for this game" },
        { headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } }
      );
    }

    // 2. Compute path (timeline_status IS NULL): resolve + walk + persist all 10.
    const gameRows = (await sql`
      SELECT player_link, team, champion_id, game_datetime, overview_page
      FROM coachbuild.prostage_matches
      WHERE game_id = ${gameId}
    `) as unknown as GameRow[];

    if (gameRows.length === 0) {
      // Race: row vanished between the two selects — treat as bad request.
      return NextResponse.json({ error: "player not in this game" }, { status: 400 });
    }

    const gameDatetime = new Date(gameRows[0].game_datetime).toISOString();
    const overviewPage = gameRows[0].overview_page;
    const dbRows: TimelineDbRow[] = gameRows.map((r) => ({
      player_link: r.player_link,
      team: r.team,
      champion_id: r.champion_id,
    }));

    const result = await computeGameTimelines(gameId, gameDatetime, overviewPage, dbRows);

    if (result.status === "transient") {
      // Persist NOTHING — a transient failure must re-attempt next request.
      return NextResponse.json({ error: "timeline temporarily unavailable, retry shortly" }, { status: 500 });
    }

    if (result.status === "unavailable") {
      await sql`
        UPDATE coachbuild.prostage_matches
        SET timeline_status = 'unavailable'
        WHERE game_id = ${gameId}
      `;
      return NextResponse.json(
        { status: "unavailable", reason: result.reason },
        { headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } }
      );
    }

    // result.status === "ok": persist every player's build order (unmatched
    // players get [] — the game still resolved for them, don't re-walk).
    for (const r of gameRows) {
      const order = result.byPlayer.get(r.player_link) ?? [];
      await sql`
        UPDATE coachbuild.prostage_matches
        SET purchase_order = ${JSON.stringify(order)}::jsonb,
            lolesports_game_id = ${result.lolesportsGameId},
            timeline_status = 'ok'
        WHERE game_id = ${gameId} AND player_link = ${r.player_link}
      `;
    }

    const requestedOrder = result.byPlayer.get(player) ?? [];
    return NextResponse.json(
      { status: "ok", purchaseOrder: requestedOrder },
      { headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } }
    );
  } catch (err) {
    console.error("[/api/prostage/timeline] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
