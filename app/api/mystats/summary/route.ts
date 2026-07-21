import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getMyAccount } from "@/lib/mystats/account";
import { summarizeByChampion, summarizeMatchup, type MyMatchRecord } from "@/lib/mystats/aggregate";
import { SEASON_LABEL } from "@/lib/mystats/season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  champion_id: number;
  role: number;
  opp_champion_id: number | null;
  win: boolean;
  game_creation: string;
}

function parseIntParam(raw: string | null): number | null | undefined {
  if (raw === null) return undefined; // absent
  if (!/^-?\d+$/.test(raw)) return null; // present but invalid
  return parseInt(raw, 10);
}

/**
 * GET /api/mystats/summary?role=<0-4>&championId=<n>&oppChampionId=<n>
 * Per-champion personal records (games/wins/winrate/lastPlayed), optionally
 * scoped by role and/or championId. `oppChampionId` additionally computes a
 * specific matchup record — ONLY when `championId` is also given (a matchup
 * is meaningful for one specific champion, not the whole filtered set); if
 * `oppChampionId` is present without `championId`, `matchup` is simply null
 * (nothing unambiguous to compute) rather than 400 — a slightly-too-broad
 * query degrades gracefully instead of failing.
 *
 * Per-user private data (own League match history) -> ALWAYS `no-store`,
 * never CDN-cached — same posture as every other route touching per-user
 * data in this app (see CLAUDE.md gotcha (b)).
 *
 * NOTE (hard user directive, ratified 2026-07-21): this data is DISPLAY
 * ONLY. Nothing here feeds any ranking/score anywhere — see
 * lib/draft/recommend.ts's PersonalPlayResult doc comment for where this
 * same data resurfaces in the Draft recommender, additively, never blended.
 *
 * `riotId` (2026-07-21, additive, fronty's UI round): the resolved account's
 * display tag ("MunsterHunter#EUW"), null when accountUnresolved -- lets the
 * My Stats page header show which account this data belongs to without a
 * second round-trip to a dedicated account endpoint.
 *
 * SEASON SCOPING (2026-07-21): coachbuild.my_matches is scoped to the
 * current season by INGEST/STORAGE (lib/mystats/season.ts,
 * lib/mystats/ingest.ts) — every row in the table is already in-season, so
 * this route applies no additional season filtering of its own. `season`
 * (SEASON_LABEL, e.g. "Season 2026") is echoed on every response purely so
 * a future UI can render the scope without re-deriving/duplicating the
 * boundary constant — NOT built here (backend-only ship; see HANDOFF).
 */
export async function GET(req: NextRequest) {
  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const { searchParams } = new URL(req.url);
  const role = parseIntParam(searchParams.get("role"));
  if (role === null) {
    return NextResponse.json({ error: "Invalid role param" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const championId = parseIntParam(searchParams.get("championId"));
  if (championId === null) {
    return NextResponse.json({ error: "Invalid championId param" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const oppChampionId = parseIntParam(searchParams.get("oppChampionId"));
  if (oppChampionId === null) {
    return NextResponse.json({ error: "Invalid oppChampionId param" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const account = await getMyAccount(sql);
    if (!account) {
      return NextResponse.json(
        { accountUnresolved: true, season: SEASON_LABEL, riotId: null, records: [], matchup: null },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    const rows = (await sql`
      SELECT champion_id, role, opp_champion_id, win, game_creation
      FROM coachbuild.my_matches
      WHERE (${role ?? null}::smallint IS NULL OR role = ${role ?? null})
        AND (${championId ?? null}::integer IS NULL OR champion_id = ${championId ?? null})
    `) as unknown as Row[];

    const records: MyMatchRecord[] = rows.map((r) => ({
      championId: r.champion_id,
      role: r.role,
      oppChampionId: r.opp_champion_id,
      win: r.win,
      gameCreation: r.game_creation,
    }));

    const matchup =
      championId != null && oppChampionId != null ? summarizeMatchup(records, oppChampionId) : null;

    return NextResponse.json(
      { accountUnresolved: false, season: SEASON_LABEL, riotId: account.riotId, records: summarizeByChampion(records), matchup },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/mystats/summary] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
