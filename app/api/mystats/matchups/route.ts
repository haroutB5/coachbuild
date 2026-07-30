import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getActiveAccount } from "@/lib/mystats/account";
import { summarizeMatchupsByOpponent, type MyMatchRecord } from "@/lib/mystats/aggregate";
import { SEASON_LABEL } from "@/lib/mystats/season";
import { COUNTED_QUEUE_IDS } from "@/lib/mystats/queues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  role: number;
  opp_champion_id: number | null;
  win: boolean;
  game_creation: string;
}

/** Same convention as app/api/mystats/summary/route.ts's parseIntParam:
 *  absent -> undefined (no filter), present-but-invalid -> null (caller
 *  400s), present-and-valid -> the parsed integer. Signed, because role -1
 *  (unresolved lane, e.g. ARAM) is a real, filterable value — "no role
 *  param" (undefined) and "role=-1" (the number -1) are deliberately
 *  different requests; see this route's doc comment. */
function parseIntParam(raw: string | null): number | null | undefined {
  if (raw === null) return undefined; // absent
  if (!/^-?\d+$/.test(raw)) return null; // present but invalid
  return parseInt(raw, 10);
}

/**
 * GET /api/mystats/matchups?championId=<n> (required)&role=<n> (optional)
 * All of my recorded matchups on one champion, grouped by lane opponent.
 * `role` scopes the result to one (championId, role) pair — the same
 * grouping the /mystats "Matchup History" row headers use (see
 * lib/mystats/aggregate.ts's summarizeByChampion). Without it, matchups are
 * champion-wide across every role ever played — a legitimate, different
 * question, kept as the default for backward compatibility. `role=-1`
 * (unresolved lane) is filterable like any other role; omitting the param
 * entirely is NOT the same request as `role=-1`.
 * Per-user private data -> always `no-store` (see summary route's doc
 * comment — same posture). DISPLAY DATA ONLY, same no-blending posture as
 * /api/mystats/summary — see lib/draft/recommend.ts's PersonalPlayResult.
 *
 * MULTI-ACCOUNT (v0.83, migration 0020): scoped to the ACTIVE linked account.
 * `riotId`/`accountId` are echoed (additive) so a consumer can tell WHOSE
 * matchup history it is holding — the same reason /api/mystats/summary echoes
 * them.
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

  const role = parseIntParam(searchParams.get("role"));
  if (role === null) {
    return NextResponse.json({ error: "Invalid role param" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const account = await getActiveAccount(sql);
    if (!account) {
      return NextResponse.json(
        {
          accountUnresolved: true,
          season: SEASON_LABEL,
          riotId: null,
          accountId: null,
          championId,
          role: role ?? null,
          matchups: [],
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ACCOUNT-SCOPED (migration 0020) and SOLO-QUEUE-SCOPED (2026-07-30) — both
    // branches, both filters. An unscoped matchup history is two players' lane
    // records added together, which reads as a confident number and is nobody's
    // record; a queue-unscoped one folds flex and normal-draft lanes into a
    // "your record vs Darius" that the user never played in solo queue. Same
    // failure class, same answer (lib/mystats/queues.ts).
    const rows = (
      role !== undefined
        ? await sql`
            SELECT role, opp_champion_id, win, game_creation
            FROM coachbuild.my_matches
            WHERE puuid = ${account.puuid}
              AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
              AND champion_id = ${championId} AND role = ${role}
          `
        : await sql`
            SELECT role, opp_champion_id, win, game_creation
            FROM coachbuild.my_matches
            WHERE puuid = ${account.puuid}
              AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
              AND champion_id = ${championId}
          `
    ) as unknown as Row[];

    const records: MyMatchRecord[] = rows.map((r) => ({
      championId,
      role: r.role,
      oppChampionId: r.opp_champion_id,
      win: r.win,
      gameCreation: r.game_creation,
    }));

    return NextResponse.json(
      {
        accountUnresolved: false,
        season: SEASON_LABEL,
        riotId: account.riotId,
        accountId: account.id,
        championId,
        role: role ?? null,
        matchups: summarizeMatchupsByOpponent(records),
      },
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
