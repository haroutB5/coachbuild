import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getActiveAccount, listAccounts } from "@/lib/mystats/account";
import {
  summarizeByChampion,
  summarizeMatchup,
  computeBuildAdherence,
  computePriorSplitWinrate,
  buildRecentGames,
  type MyMatchRecord,
} from "@/lib/mystats/aggregate";
import { SEASON_LABEL, currentSplitNumber } from "@/lib/mystats/season";
import { readHistoryComplete } from "@/lib/mystats/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  champion_id: number;
  role: number;
  opp_champion_id: number | null;
  win: boolean;
  game_creation: string;
}

interface AdherenceRow {
  on_wpa_build: boolean | null;
  win: boolean;
}

interface PriorSplitRow {
  win: boolean;
}

interface RecentRow {
  champion_id: number;
  role: number;
  win: boolean;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  on_wpa_build: boolean | null;
  game_creation: string;
}

const EMPTY_STATS = {
  historyComplete: false,
  buildAdherencePct: null as number | null,
  winrateOnBuild: null as number | null,
  winrateOffBuild: null as number | null,
  nOnBuild: null as number | null,
  nOffBuild: null as number | null,
  priorSplitWinrate: null as number | null,
  recentGames: [] as ReturnType<typeof buildRecentGames>,
};

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
 *
 * SPLIT SCOPING + BUILD ADHERENCE (v0.51, additive): `records`/`matchup` are
 * now filtered to the CURRENT split (lib/mystats/season.ts's
 * currentSplitNumber) on top of the existing role/championId filters — see
 * that file's header for the split-boundary source. Additional top-level,
 * ACCOUNT-WIDE (never role/championId-scoped) fields:
 *  - `buildAdherencePct`/`winrateOnBuild`/`winrateOffBuild`: current-split
 *    build-adherence stats (lib/mystats/aggregate.ts's computeBuildAdherence)
 *    — null when no row in the current split has a resolved recommendation
 *    yet (see lib/mystats/adherence.ts's null/false distinction).
 *  - `nOnBuild`/`nOffBuild` (v0.74, additive): the row counts BEHIND
 *    `winrateOnBuild`/`winrateOffBuild` respectively — same null-exactly-
 *    when-the-corresponding-winrate-is-null convention, never a fabricated
 *    0. Lets a consumer refuse to render a winrate delta computed over a
 *    handful of games as if it meant the same thing as one over hundreds —
 *    see components/hextech/myStats.ts's computeBuildWinrateDelta.
 *  - `priorSplitWinrate`: overall win rate for the PRIOR split (not
 *    role/championId-scoped — the whole-account delta comparison point), or
 *    null when there is no prior split yet (still in split 1).
 *  - `recentGames`: latest 5 games account-wide (any split, any role/champ),
 *    newest first — a dashboard strip, deliberately independent of every
 *    other filter on this route.
 * All of the above are DISPLAY ONLY — see PersonalRecord's doc comment
 * (lib/draft/recommend.ts) for the no-blending rule this inherits.
 *
 * MULTI-ACCOUNT (v0.83, migration 0020). Every figure on this response is
 * scoped to the ACTIVE linked account, and three additive fields describe that
 * scope so a UI never has to guess which account it is looking at:
 *  - `accountId`: the active account's local id, or null when unresolved. The
 *    handle the picker sends back to POST /api/mystats/accounts.
 *  - `accounts`: MyAccountSummary[] — every linked account (id, riotId,
 *    gameName, tagLine, region, active, lastSeenAt, games), active first. Never
 *    contains a puuid. Present even on the accountUnresolved response, so a
 *    picker can still offer a choice when nothing is active yet.
 *  - `riotId`: unchanged meaning — the ACTIVE account's display tag.
 * Switching accounts changes every number here and nothing else; the two
 * accounts' rows never mix, because my_matches is keyed and indexed by puuid.
 *
 * `historyComplete` (2026-07-30, additive): whether the ACTIVE account's season
 * window has been fully walked, read from the one place that owns that flag
 * (lib/mystats/ingest.ts's readHistoryComplete over
 * my_ingest_cursor.backfill_done). FALSE means every figure on this response is
 * computed over a PARTIAL history — normal and temporary for a just-linked
 * account, since the catch-up walk converges over several runs inside a 60s
 * serverless budget. It is here so a `season` label ("Season 2026") is never
 * rendered over a truncated denominator as though it were the whole season. Not
 * yet rendered by the UI as of this ship — see HANDOFF-engy.md.
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
    const account = await getActiveAccount(sql);
    if (!account) {
      return NextResponse.json(
        {
          accountUnresolved: true,
          season: SEASON_LABEL,
          riotId: null,
          accountId: null,
          accounts: await listAccounts(sql),
          records: [],
          matchup: null,
          ...EMPTY_STATS,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    const split = currentSplitNumber();
    const priorSplit = split - 1;

    // EVERY query below is scoped to `account.puuid` (migration 0020). This is
    // the whole point of that migration: before it, my_matches had no account
    // column and each of these four SELECTs read the entire table, so linking a
    // second account would have merged two players into one win rate, one
    // champion pool, one adherence figure and one recent-games strip — with no
    // visible symptom. HARD RULE 4. If you add a fifth query here, it takes the
    // puuid filter too.
    const rows = (await sql`
      SELECT champion_id, role, opp_champion_id, win, game_creation
      FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
        AND split = ${split}
        AND (${role ?? null}::smallint IS NULL OR role = ${role ?? null})
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

    // Account-wide (never role/championId-scoped) current-split adherence --
    // see this route's doc comment.
    const adherenceRows = (await sql`
      SELECT on_wpa_build, win FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid} AND split = ${split}
    `) as unknown as AdherenceRow[];
    const { buildAdherencePct, winrateOnBuild, winrateOffBuild, nOnBuild, nOffBuild } = computeBuildAdherence(
      adherenceRows.map((r) => ({ win: r.win, onWpaBuild: r.on_wpa_build ?? null }))
    );

    // No prior split yet (still in split 1) -- skip the query entirely
    // rather than asking for split=0, which would just be an empty result.
    const priorSplitWinrate =
      priorSplit >= 1
        ? computePriorSplitWinrate(
            (await sql`
              SELECT win FROM coachbuild.my_matches
              WHERE puuid = ${account.puuid} AND split = ${priorSplit}
            `) as unknown as PriorSplitRow[]
          )
        : null;

    const recentRows = (await sql`
      SELECT champion_id, role, win, kills, deaths, assists, on_wpa_build, game_creation
      FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
      ORDER BY game_creation DESC
      LIMIT 5
    `) as unknown as RecentRow[];
    // The picker's feed, shipped ON the summary response rather than behind a
    // second endpoint: the My Stats page already fetches this, so the account
    // switcher costs no extra round trip and can never render a list that
    // disagrees with the stats beside it.
    const accounts = await listAccounts(sql);
    // IS THIS ACCOUNT'S HISTORY WHOLE? (2026-07-30.) Every figure above is
    // computed over whatever rows my_matches happens to hold, and until now
    // nothing on this response said whether that was the account's full season or
    // the newest 30 games of it. A freshly linked account genuinely has a partial
    // history for a while (see lib/mystats/ingest.ts's header -- the catch-up
    // walk converges over several runs inside a 60s serverless budget), and
    // labelling a partial denominator "Season 2026" is a HARD RULE 4 problem, so
    // the fact travels with the numbers.
    const historyComplete = await readHistoryComplete(sql, account.puuid);

    const recentGames = buildRecentGames(
      recentRows.map((r) => ({
        championId: r.champion_id,
        role: r.role,
        win: r.win,
        kills: r.kills ?? 0,
        deaths: r.deaths ?? 0,
        assists: r.assists ?? 0,
        onWpaBuild: r.on_wpa_build ?? null,
        gameCreation: r.game_creation,
      }))
    );

    return NextResponse.json(
      {
        accountUnresolved: false,
        season: SEASON_LABEL,
        riotId: account.riotId,
        accountId: account.id,
        accounts,
        historyComplete,
        records: summarizeByChampion(records),
        matchup,
        buildAdherencePct,
        winrateOnBuild,
        winrateOffBuild,
        nOnBuild,
        nOffBuild,
        priorSplitWinrate,
        recentGames,
      },
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
