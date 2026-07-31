import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getActiveAccount, listAccounts } from "@/lib/mystats/account";
import {
  summarizeByChampion,
  summarizeMatchup,
  computeBuildAdherence,
  computePriorSplitWinrate,
  computeCsSummary,
  buildRecentGames,
  type MyMatchRecord,
} from "@/lib/mystats/aggregate";
import { SEASON_LABEL, currentSplitNumber } from "@/lib/mystats/season";
import { COUNTED_QUEUE_IDS } from "@/lib/mystats/queues";
import { readHistoryComplete } from "@/lib/mystats/ingest";
import { refreshStaleRanks, UNKNOWN_RANK } from "@/lib/mystats/rank";
import { routingForServer } from "@/lib/pro/regionMap";
import { isWaitingForPatchData } from "@/lib/mystats/adherence";
import { getLatestPatch } from "@/lib/staticData";

/** How many games the Match Performance panel shows, and the ONE number that
 *  decides it. Both the SQL below and buildRecentGames' own limit read from
 *  this — they used to disagree, and the panel quietly served 5 rows under a
 *  heading that said 20. Its name is on screen, so changing it changes the
 *  heading too. */
const RECENT_GAMES_LIMIT = 20;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  champion_id: number;
  role: number;
  opp_champion_id: number | null;
  win: boolean;
  game_creation: string;
  cs: number | null;
  game_duration_sec: number | null;
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
  cs: number | null;
  game_duration_sec: number | null;
  /** This game's own patch label (e.g. "16.15") -- see isWaitingForPatchData's
   *  doc comment for why this is read alongside on_wpa_build rather than
   *  trusted to explain a null on its own. */
  patch: string | null;
}

const EMPTY_STATS = {
  historyComplete: false,
  buildAdherencePct: null as number | null,
  winrateOnBuild: null as number | null,
  winrateOffBuild: null as number | null,
  nOnBuild: null as number | null,
  nOffBuild: null as number | null,
  priorSplitWinrate: null as number | null,
  // CS headline. csGames 0 is a REAL count (zero games backed it), which is
  // why it is 0 and not null, while csPerMin is null because there is no rate
  // to state -- the same "count vs figure" split nOnBuild/nOffBuild use.
  csPerMin: null as number | null,
  csGames: 0,
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
 *  - `recentGames`: latest RECENT_GAMES_LIMIT games account-wide (any split, any role/champ),
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
          championPool: [],
          matchup: null,
          // No account resolved => nothing was looked up => UNKNOWN, never a
          // fabricated "unranked". Spread so this response carries the exact
          // same seven rank keys as the resolved one -- a consumer must not
          // have to branch on which response shape it got.
          ...UNKNOWN_RANK,
          ...EMPTY_STATS,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    const split = currentSplitNumber();
    const priorSplit = split - 1;

    // EVERY query below is scoped to `account.puuid` (migration 0020) AND to
    // COUNTED_QUEUE_IDS (2026-07-30). Two invariants, same reason.
    //
    // The puuid one: before migration 0020, my_matches had no account column and
    // each of these SELECTs read the entire table, so linking a second account
    // would have merged two players into one win rate, one champion pool, one
    // adherence figure and one recent-games strip — with no visible symptom.
    //
    // The queue one: the table holds EVERY queue the account played (flex,
    // normal draft, quickplay, swiftplay, ARAM — see lib/mystats/ingest.ts's
    // header), and until this filter existed every figure on this response was a
    // blend of solo queue and everything else. Measured on the live DB
    // 2026-07-30: 45 of K1ayer#swift's 186 stored games were not solo queue.
    // Same failure class as the account bleed — a confident number describing
    // nobody's actual solo-queue record. HARD RULE 4.
    //
    // If you add another query here it takes BOTH filters. Both are pinned
    // structurally by lib/__tests__/mystats-scoping-invariant.test.ts and
    // lib/__tests__/mystats-queue-invariant.test.ts respectively, so a query
    // that forgets one fails the suite.
    const rows = (await sql`
      SELECT champion_id, role, opp_champion_id, win, game_creation, cs, game_duration_sec
      FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
        AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
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
      cs: r.cs,
      gameDurationSec: r.game_duration_sec,
    }));

    const matchup =
      championId != null && oppChampionId != null ? summarizeMatchup(records, oppChampionId) : null;

    // Account-wide (never role/championId-scoped) current-split adherence --
    // see this route's doc comment.
    const adherenceRows = (await sql`
      SELECT on_wpa_build, win FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
        AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
        AND split = ${split}
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
              WHERE puuid = ${account.puuid}
                AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
                AND split = ${priorSplit}
            `) as unknown as PriorSplitRow[]
          )
        : null;

    const recentRows = (await sql`
      SELECT champion_id, role, win, kills, deaths, assists, on_wpa_build, game_creation,
             cs, game_duration_sec, patch
      FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
        -- SOLO QUEUE ONLY (2026-07-30). This strip IS the Match Performance
        -- chart the user complained about: measured live before the fix, 9 of
        -- the newest 20 stored rows on the active account were flex/normal/
        -- quickplay games, so nearly half the chart was not solo queue.
        AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
        -- CURRENT SPLIT ONLY (2026-07-31 audit P2). This strip used to ignore
        -- the split column entirely while every OTHER figure on this response
        -- (records, adherence, priorSplitWinrate) is split-scoped -- on an account with
        -- only 2 solo-queue games in the current split, 18 of the "last 20"
        -- bars were leftover April games from the prior split, and "WIN RATE,
        -- LAST 20: 70.0%" silently blended two splits into one number. Same
        -- denominator discipline as every other query on this route now.
        AND split = ${split}
      ORDER BY game_creation DESC
      -- 20, not 5: the Match Performance panel is headed "(Last 20 Games)" and
      -- its bar chart is sized for that. At 5 the heading was a claim the data
      -- did not back, which is the same defect class as an unlabelled partial
      -- history -- just smaller. The panel renders however many rows come back,
      -- so a newly-linked account with 3 games (now honestly reduced by the
      -- split filter above) still reads correctly -- MatchPerformanceChips.n
      -- and the panel heading both derive from the actual array length, never
      -- a hardcoded 20.
      LIMIT ${RECENT_GAMES_LIMIT}
    `) as unknown as RecentRow[];

    // RANK REFRESH, before listAccounts reads the stored values back. Bounded
    // at RANK_REFRESH_MAX_PER_REQUEST Riot calls and gated per account by a
    // DATABASE timestamp, so the steady state on a warm account is ZERO calls
    // -- this is the "must not add a call per page view" constraint, and the
    // reason the TTL lives in Postgres rather than in module state (a
    // per-lambda-instance cache would make N cold instances issue N calls for
    // the same fact). Never throws; see refreshStaleRanks.
    const rankTargets = (await sql`
      SELECT id, puuid, region, active, rank_attempted_at FROM coachbuild.my_account
    `) as unknown as {
      id: number;
      puuid: string;
      region: string;
      active: boolean;
      rank_attempted_at: string | null;
    }[];
    await refreshStaleRanks(sql, rankTargets, (region) => routingForServer(region)?.platform ?? null);
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

    // "waiting for patch data" vs "build not recorded" (2026-07-31 audit P2,
    // #4) — the same populated-patch resolution lib/mystats/ingest.ts's
    // resolveRecommendedBuild gates on, re-read here so a null on_wpa_build
    // can be classified honestly at DISPLAY time without touching how/when
    // it was resolved. Soft-fail like every other best-effort patch read in
    // this app (see lib/draft/recommend.ts's currentPatch) — a resolution
    // failure degrades every pending row to the existing "not-recorded"
    // copy, never a guess.
    const populatedPatch = (await getLatestPatch().catch(() => null))?.label ?? null;

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
        cs: r.cs,
        gameDurationSec: r.game_duration_sec,
        patchDataPending: isWaitingForPatchData({
          onWpaBuild: r.on_wpa_build ?? null,
          role: r.role,
          matchPatch: r.patch,
          populatedPatch,
        }),
      })),
      // THE CAP IS IN TWO PLACES and both have to agree. The SQL above limits
      // what is fetched; buildRecentGames defaults to 5 and would silently
      // re-truncate whatever arrives. Raising only the query left prod serving
      // 5 rows under a heading that says 20 — the second cap is invisible from
      // the route unless you pass it. Keep this argument explicit rather than
      // changing the default, so the next person reading the SQL sees that the
      // number they are looking at is not the only one.
      RECENT_GAMES_LIMIT
    );

    // ONE array, TWO names. `records` is what every already-shipped consumer
    // reads (components/hextech/myStats.ts, ChampionPickPrompt.tsx);
    // `championPool` is the name the /mystats redesign brief uses. They are the
    // SAME array by reference -- built once, emitted twice -- deliberately not
    // two calls to summarizeByChampion, because two independent computations of
    // one fact is precisely the pattern that silently misses the next fix
    // (CLAUDE.md gotcha (dd)). Pinned by a test asserting reference identity.
    const championPool = summarizeByChampion(records);
    // Account-wide CS headline, CURRENT SPLIT -- the same scope
    // buildAdherencePct uses, and re-aggregated from the raw rows rather than
    // averaged out of championPool's per-champion rates (see computeCsSummary).
    const { csPerMin, csGames } = computeCsSummary(records);
    // The ACTIVE account's rank, mirrored to the top level so the hero does not
    // have to search accounts[]. Read from the SAME listAccounts result the
    // array ships, so the two can never disagree; UNKNOWN_RANK only if the
    // active row somehow vanished between the two reads.
    const activeAccount = accounts.find((a) => a.id === account.id);
    const activeRank = activeAccount
      ? {
          tier: activeAccount.tier,
          division: activeAccount.division,
          lp: activeAccount.lp,
          rankWins: activeAccount.rankWins,
          rankLosses: activeAccount.rankLosses,
          rankUnknown: activeAccount.rankUnknown,
          rankCheckedAt: activeAccount.rankCheckedAt,
        }
      : UNKNOWN_RANK;

    return NextResponse.json(
      {
        accountUnresolved: false,
        season: SEASON_LABEL,
        riotId: account.riotId,
        accountId: account.id,
        accounts,
        historyComplete,
        records: championPool,
        championPool,
        matchup,
        buildAdherencePct,
        winrateOnBuild,
        winrateOffBuild,
        nOnBuild,
        nOffBuild,
        priorSplitWinrate,
        csPerMin,
        csGames,
        ...activeRank,
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
