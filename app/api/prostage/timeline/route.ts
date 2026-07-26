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
//   429 {error:"..."}  the compute path is on cooldown (either genuinely
//        in-flight on another request, or backing off after a recent
//        `transient` failure) — retry after the `Retry-After` header, no
//        network call was made for this response.
//   500 {error:"..."}  a TRANSIENT feed/API failure just happened on THIS
//        request — retry later; never persisted as unavailable.
//   400 {error:"..."}  bad/missing params, or player not in this game.
//
// The compute runs synchronously within the request (maxDuration raised, like
// matchday's route) — no async "pending" state machine.
//
// ── Cost-amplification fix (2026-07-26 audit, P1-3 security) ────────────────
// Unauthenticated + previously no rate limit/cooldown: a cold resolve+walk is
// ~750 outbound requests (lolesports schedule/event calls + up to
// WALK_MAX_POINTS=500 livestats detail pages + ddragon — see
// lib/prostage/resolveGame.ts / timeline.ts), and a `transient` result used
// to persist nothing at all, so the very next identical request re-walked
// everything from scratch. `timeline_next_attempt_at` (migration 0016) closes
// both the "re-trigger a transient result immediately" hole AND a burst of
// CONCURRENT requests for the same never-resolved game:
//   - Before doing anything, a fast read-only check on the already-fetched
//     row's `timeline_next_attempt_at` bounces a request still in cooldown
//     WITHOUT any further DB write or network call.
//   - The actual "may I start walking" decision is an ATOMIC claim: an
//     UPDATE ... WHERE timeline_status IS NULL AND (next_attempt_at IS NULL
//     OR next_attempt_at <= now()) ... RETURNING that advances
//     next_attempt_at to a short lease BEFORE the walk starts. Postgres
//     row-level locking makes this race-safe: a concurrent request's UPDATE
//     blocks until the winner's commits, then re-evaluates the WHERE clause
//     against the now-advanced value and returns 0 rows — no walk, no
//     network call, just a 429.
//   - On a `transient` result the SAME column is pushed out further with
//     exponential backoff (computeBackoffSeconds) while `timeline_status`
//     stays NULL exactly as before — the transient-vs-terminal taint
//     discipline is untouched, only WHEN a retry is allowed changes.
//   - If the function dies mid-walk (crash/maxDuration kill), the lease
//     simply expires — no separate unlock/cleanup step needed.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { computeGameTimelines, type TimelineDbRow } from "@/lib/prostage/resolveGame";
import { CLAIM_LEASE_SEC, computeBackoffSeconds, retryAfterHeaders } from "@/lib/prostage/timelineBackoff";
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
  timeline_next_attempt_at: string | Date | null;
}

interface ClaimedRow {
  player_link: string;
  team: string | null;
  champion_id: number;
  game_datetime: string | Date;
  overview_page: string;
  timeline_attempt_count: number;
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
    // 1. Fast path: the requested player's row already resolved (or is on a
    //    cooldown/lease we can read without touching the network at all).
    const requested = (await sql`
      SELECT purchase_order, timeline_status, timeline_next_attempt_at
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

    // status is NULL from here — either never attempted, in flight on another
    // request, or backing off after a recent transient failure. A future
    // timeline_next_attempt_at read here is a cheap early-out; the atomic
    // claim below is what's actually race-safe (this check alone is not —
    // see the claim's own comment).
    const cooldownUntil = requested[0].timeline_next_attempt_at
      ? new Date(requested[0].timeline_next_attempt_at).getTime()
      : null;
    if (cooldownUntil !== null && cooldownUntil > Date.now()) {
      return NextResponse.json(
        { error: "timeline temporarily unavailable, retry shortly" },
        { status: 429, headers: retryAfterHeaders((cooldownUntil - Date.now()) / 1000) }
      );
    }

    // 2. Atomic claim: advance the lease BEFORE starting the walk. Scoped by
    //    game_id only (no player_link filter) so ONE claim covers every row
    //    of the game — matches the fact that one livestats walk resolves all
    //    10 players at once. 0 rows back means a concurrent request already
    //    holds the lease (or, rarely, the game resolved between step 1 and
    //    here) — either way, bounce without any outbound call.
    const claimed = (await sql`
      UPDATE coachbuild.prostage_matches
      SET timeline_next_attempt_at = now() + (${CLAIM_LEASE_SEC}::int * interval '1 second')
      WHERE game_id = ${gameId}
        AND timeline_status IS NULL
        AND (timeline_next_attempt_at IS NULL OR timeline_next_attempt_at <= now())
      RETURNING player_link, team, champion_id, game_datetime, overview_page, timeline_attempt_count
    `) as unknown as ClaimedRow[];

    if (claimed.length === 0) {
      return NextResponse.json(
        { error: "timeline already being computed, retry shortly" },
        { status: 429, headers: retryAfterHeaders(CLAIM_LEASE_SEC) }
      );
    }

    const gameDatetime = new Date(claimed[0].game_datetime).toISOString();
    const overviewPage = claimed[0].overview_page;
    const priorAttemptCount = claimed[0].timeline_attempt_count ?? 0;
    const dbRows: TimelineDbRow[] = claimed.map((r) => ({
      player_link: r.player_link,
      team: r.team,
      champion_id: r.champion_id,
    }));

    const result = await computeGameTimelines(gameId, gameDatetime, overviewPage, dbRows);

    if (result.status === "transient") {
      // Persist NOTHING as a terminal state — a transient failure must
      // re-attempt eventually. Only WHEN it may re-attempt changes: push the
      // lease out with exponential backoff instead of leaving it expired
      // (which would let the very next request re-walk everything again).
      const attemptCount = priorAttemptCount + 1;
      const backoffSec = computeBackoffSeconds(attemptCount);
      await sql`
        UPDATE coachbuild.prostage_matches
        SET timeline_next_attempt_at = now() + (${backoffSec}::int * interval '1 second'),
            timeline_attempt_count = ${attemptCount}
        WHERE game_id = ${gameId}
      `;
      return NextResponse.json(
        { error: "timeline temporarily unavailable, retry shortly" },
        { status: 500, headers: retryAfterHeaders(backoffSec) }
      );
    }

    if (result.status === "unavailable") {
      await sql`
        UPDATE coachbuild.prostage_matches
        SET timeline_status = 'unavailable',
            timeline_next_attempt_at = NULL,
            timeline_attempt_count = 0
        WHERE game_id = ${gameId}
      `;
      return NextResponse.json(
        { status: "unavailable", reason: result.reason },
        { headers: { "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" } }
      );
    }

    // result.status === "ok": persist every player's build order (unmatched
    // players get [] — the game still resolved for them, don't re-walk).
    for (const r of claimed) {
      const order = result.byPlayer.get(r.player_link) ?? [];
      await sql`
        UPDATE coachbuild.prostage_matches
        SET purchase_order = ${JSON.stringify(order)}::jsonb,
            lolesports_game_id = ${result.lolesportsGameId},
            timeline_status = 'ok',
            timeline_next_attempt_at = NULL,
            timeline_attempt_count = 0
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
