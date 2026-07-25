// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/ingest.ts — per-tournament pro-stage backfill/incremental
// ingest. Chunked by design: process ONE tournament (one ScoreboardPlayers
// Cargo call) per invocation, return the next cursor — mirrors
// lib/pro/ingestMatches.ts's shape so app/api/ingest/prostage/route.ts and
// scripts/ingest-prostage.mjs both drive it the same way.
//
// Serverless timing note: 7 tournaments x 30s Cargo pacing floor is ~3.5min,
// which exceeds a route's 60s maxDuration — hence one-tournament-per-call.
// The full-drain LOOP (all cursors back to back) only happens in the local
// script; the route is meant to be walked by an external pinger using the
// returned nextCursor, same pattern as /api/ingest/matches.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { cargoExportQuery, cargoQueryWithRetry } from "./cargo";
import type { CargoQueryOptions } from "./cargo";
import { cleanLeaguepediaName } from "./displayName";
import { getDdragonMaps } from "./ddragon";
import { extractProstageRow } from "./extract";
import { orderByStaleness, resolveActiveTournaments } from "./tournaments";
import type { CargoScoreboardPlayerRow } from "./types";

// ROOT CAUSE (2026-07-09, post-ship): every ScoreboardPlayers call that got
// PAST the rate limiter (3/3 in the real ingest run) failed with a
// MediaWiki-level `MWException`, not a clean "unknown field" JSON error —
// meaning the query itself was malformed, not just rate-limited. Confirmed
// via the LIVE schema (fetched as a normal wiki page, not the Cargo API, so
// it costs zero rate-limit budget):
//   https://lol.fandom.com/wiki/Module:CargoDeclare/ScoreboardPlayers?action=raw
// Cross-checked every requested field against that declaration — ALL of them
// are real EXCEPT "Patch", which was never confirmed and is genuinely absent
// from this table's schema (I'd flagged this exact risk in my own original
// comment). Removed. Every other field (Trinket/PlayerWin/GameId/
// KeystoneRune/PrimaryTree/SecondaryTree included — all were "prime
// suspects" in the fix brief) is confirmed present and correctly named.
const SCOREBOARD_PLAYERS_FIELDS =
  "Link, Champion, Items, Trinket, Runes, KeystoneRune, PrimaryTree, SecondaryTree, " +
  "SummonerSpells, Kills, Deaths, Assists, Team, Role, GameId, DateTime_UTC, OverviewPage, PlayerWin";

export interface ProstageIngestOptions {
  cursor?: number;
  tournaments?: string[]; // override — skips resolveActiveTournaments AND staleness reordering (used by tests; the script resolves once itself, see scripts/ingest-prostage.mjs)
  onProgress?: (msg: string) => void;
  /** See CargoRetryOptions.fastFail in lib/prostage/cargo.ts. Pass true from
   *  the route (60s maxDuration can't afford the ~4.5min cooldown); leave
   *  false (default) for the script (long-running, no timeout). */
  fastFailOnRatelimit?: boolean;
  /** Overrides how the ScoreboardPlayers rows are fetched — defaults to
   *  cargoQueryWithRetry (api.php) paced/retried per fastFailOnRatelimit
   *  above. Pass cargoExportQuery (see lib/prostage/cargo.ts) to route the
   *  ScoreboardPlayers fetch through Special:CargoExport instead, which is
   *  NOT subject to api.php's punishing rate limit (live-verified
   *  2026-07-10) — used by scripts/ingest-prostage.mjs's --via-export flag.
   *  The route (app/api/ingest/prostage/route.ts) is intentionally left on
   *  the default api.php path; only the script opts in. */
  queryFn?: (opts: CargoQueryOptions) => Promise<CargoScoreboardPlayerRow[]>;
  /** Routes BOTH the Tournaments lookup and the ScoreboardPlayers fetch through
   *  Special:CargoExport rather than api.php. Now the ROUTE default (2026-07-25)
   *  — api.php answered "You've exceeded your rate limit" on the first call of a
   *  live probe from Vercel, which is precisely why the cron ingested nothing
   *  for weeks. Ignored when an explicit queryFn is supplied. */
  useExport?: boolean;
  /** When true, walks queryFn with increasing `offset` (PAGE_SIZE=500 per
   *  call) until a page returns fewer than PAGE_SIZE rows, instead of the
   *  single unpaginated 500-row call. Closes a real truncation bug
   *  (live-verified 2026-07-13): a full-season/playoff bracket can exceed
   *  Cargo's 500-row-per-call cap, and a plain limit=500 call silently
   *  drops the remainder with no error — e.g. LPL/2026 Season/Split 2
   *  Playoffs has 680 real ScoreboardPlayers rows, only 500 of which a
   *  single call ever returned. Capped at MAX_PAGES (10 = 5000 rows) as a
   *  safety backstop against a pathological/looping response, not because
   *  any real tournament is expected to approach it.
   *
   *  DEFAULTS TO TRUE as of 2026-07-25 (P1-1 audit fix). It used to default
   *  to false with the reasoning "only the script opts in, the route can't
   *  afford extra pages" — but the ONLY caller that ever actually passed
   *  `paginate: true` was scripts/ingest-prostage-seed.mjs, a deletable
   *  one-off. The RECURRING production path — the 3-hourly scheduled task
   *  (scripts/ingest-prostage-scheduled.ps1 -> scripts/ingest-prostage.mjs
   *  --via-export) — never passed it, so every real run silently truncated
   *  any tournament over 500 rows to its 500 newest, and because Leaguepedia
   *  backfills OUT OF ORDER (the entire premise of live ingest), an
   *  older-but-late-arriving row would sit below that cutoff forever, not
   *  just until the next run. LPL/2026 Season/Split 3 hits 500 rows at only
   *  ~50 games. Flipping the default (rather than fixing call sites one by
   *  one) means every current AND future caller is safe by construction;
   *  pass `paginate: false` explicitly if a future caller genuinely can't
   *  afford extra pages (e.g. a tight-maxDuration route). */
  paginate?: boolean;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 10; // safety backstop (5000 rows) — see `paginate` doc comment above

/** One tournament's ScoreboardPlayers rows plus whether the fetch may have
 *  been cut off before confirming it saw everything — see
 *  `possiblyTruncated`'s doc comment. */
interface ScoreboardFetchResult {
  rows: CargoScoreboardPlayerRow[];
  /** True when we can't PROVE this is the full row set — either a single
   *  unpaginated call landed exactly on PAGE_SIZE (paginate=false, an
   *  explicit opt-out — see the `paginate` doc comment), or the paginated
   *  walk exhausted MAX_PAGES without ever seeing a short page (the
   *  safety backstop capped us, not the data). Both are the same shape:
   *  `rowsSeen` looks identical to "nothing more to fetch," which is
   *  exactly the ambiguity the maxGames cap fix (v0.55.0,
   *  lib/prostage/liveIngest.ts) closed for live ingest — the caller turns
   *  this into a loud `result.errors` entry instead of a silent undercount. */
  possiblyTruncated: boolean;
}

/** Fetches ScoreboardPlayers rows for one tournament. When `paginate` is
 *  true (the default — see that option's doc comment), walks `offset` in
 *  PAGE_SIZE steps until a short page signals the end; when false (an
 *  explicit caller opt-out), issues the single legacy unpaginated call. */
async function fetchScoreboardRows(
  queryFn: (opts: CargoQueryOptions) => Promise<CargoScoreboardPlayerRow[]>,
  baseOpts: Omit<CargoQueryOptions, "offset">,
  paginate: boolean
): Promise<ScoreboardFetchResult> {
  if (!paginate) {
    const rows = await queryFn(baseOpts);
    return { rows, possiblyTruncated: rows.length === PAGE_SIZE };
  }

  const all: CargoScoreboardPlayerRow[] = [];
  let possiblyTruncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const rows = await queryFn(offset > 0 ? { ...baseOpts, offset } : baseOpts);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) {
      possiblyTruncated = false;
      break; // short page = last page — proven complete
    }
    if (page === MAX_PAGES - 1) possiblyTruncated = true; // ran out of pages, never saw a short one
  }
  return { rows: all, possiblyTruncated };
}

export interface ProstageIngestResult {
  tournament: string | null;
  rowsSeen: number;
  rowsUpserted: number;
  nextCursor: number | null;
  errors: string[];
}

interface ProNameRow {
  id: string;
  name: string;
}

async function loadProNameIndex(sql: NonNullable<ReturnType<typeof getSql>>): Promise<Map<string, string>> {
  const rows = (await sql`SELECT id, name FROM coachbuild.pros`) as unknown as ProNameRow[];
  const index = new Map<string, string>();
  for (const row of rows) index.set(row.name.trim().toLowerCase(), row.id);
  return index;
}

export async function runProstageIngest(opts: ProstageIngestOptions = {}): Promise<ProstageIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const log = opts.onProgress ?? (() => {});
  const cursor = opts.cursor ?? 0;
  const fastFailOnRatelimit = opts.fastFailOnRatelimit ?? false;
  const queryFn: (qopts: CargoQueryOptions) => Promise<CargoScoreboardPlayerRow[]> =
    opts.queryFn ??
    (opts.useExport
      ? (qopts) => cargoExportQuery<CargoScoreboardPlayerRow>(qopts)
      : (qopts) =>
          cargoQueryWithRetry<CargoScoreboardPlayerRow>(qopts, { fastFail: fastFailOnRatelimit }));

  // Staleness reordering ONLY applies to a fresh resolution — an explicit
  // `opts.tournaments` override (tests, and the script's own once-per-run
  // resolve+loop-every-cursor) is respected verbatim. This is what makes a
  // cursorless cron hit a DIFFERENT (the least-recently-ingested) tournament
  // on each invocation instead of the same DateStart-DESC head forever — see
  // orderByStaleness's doc comment in lib/prostage/tournaments.ts.
  const tournaments = opts.tournaments
    ? opts.tournaments
    : await orderByStaleness(
        sql,
        await resolveActiveTournaments({ log, fastFailOnRatelimit, useExport: opts.useExport }),
      );

  const result: ProstageIngestResult = {
    tournament: null,
    rowsSeen: 0,
    rowsUpserted: 0,
    nextCursor: null,
    errors: [],
  };

  // An EMPTY tournament list is a failure, not a completed drain. This is the
  // exact shape gotcha (o) took in production for weeks: resolveActiveTournaments
  // swallows a Cargo failure (and a legitimate zero-row result) by returning [],
  // the cursor is then out of range, and the route answered
  // {tournament:null, rowsSeen:0, errors:[], errorCount:0} — a clean HTTP 200
  // that looked like a successful no-op run. Nothing in prod ever reported a
  // problem while pro-play data silently went stale. Surface it loudly instead;
  // an empty list at cursor 0 can only mean resolution failed or matched nothing.
  if (tournaments.length === 0) {
    result.errors.push(
      "resolveActiveTournaments returned 0 tournaments — Cargo lookup failed or matched nothing. " +
        "Pro-play ingest did NOTHING this run. Set PROSTAGE_TOURNAMENT_SEED as a fallback list.",
    );
    return result;
  }

  if (cursor < 0 || cursor >= tournaments.length) {
    return result; // nextCursor stays null -> caller knows the drain is done
  }

  const overviewPage = tournaments[cursor];
  result.tournament = overviewPage;
  result.nextCursor = cursor + 1 < tournaments.length ? cursor + 1 : null;

  // Stamp the ATTEMPT before the Cargo call, unconditionally — this is what
  // makes orderByStaleness's rotation self-heal even on a zero-new-rows pass
  // (finished tournament, ratelimited/errored call). See migration 0008 +
  // orderByStaleness's doc comment (lib/prostage/tournaments.ts) for the bug
  // this closes. A stamp failure is logged but never blocks the actual
  // ingest attempt below.
  try {
    await sql`
      INSERT INTO coachbuild.prostage_ingest_attempts (overview_page, attempted_at)
      VALUES (${overviewPage}, now())
      ON CONFLICT (overview_page) DO UPDATE SET attempted_at = now()
    `;
  } catch (err) {
    result.errors.push(`tournament ${overviewPage}: failed to stamp ingest attempt: ${(err as Error).message}`);
  }

  try {
    const paginate = opts.paginate ?? true;
    const [maps, proByName, scoreboard] = await Promise.all([
      getDdragonMaps(),
      loadProNameIndex(sql),
      fetchScoreboardRows(
        queryFn,
        {
          tables: "ScoreboardPlayers",
          fields: SCOREBOARD_PLAYERS_FIELDS,
          where: `OverviewPage="${overviewPage.replace(/"/g, '\\"')}"`,
          orderBy: "DateTime_UTC DESC",
          limit: PAGE_SIZE,
        },
        paginate
      ),
    ]);

    const rows = scoreboard.rows;
    result.rowsSeen = rows.length;

    // Never let a cap hit look identical to "nothing new" — the same
    // ambiguity the maxGames cap fix (v0.55.0, lib/prostage/liveIngest.ts)
    // closed for live ingest. See ScoreboardFetchResult.possiblyTruncated's
    // doc comment for exactly which two shapes this covers (an explicit
    // paginate:false landing on PAGE_SIZE, or the paginate:true walk
    // exhausting MAX_PAGES without a confirmed short final page).
    if (scoreboard.possiblyTruncated) {
      const msg = paginate
        ? `tournament ${overviewPage}: rowsSeen (${rows.length}) hit the MAX_PAGES safety backstop ` +
          `(${MAX_PAGES} pages) without ever seeing a short final page — more rows may remain ` +
          `un-ingested; raise MAX_PAGES or re-run`
        : `tournament ${overviewPage}: rowsSeen (${rows.length}) hit the exact ${PAGE_SIZE}-row ` +
          `single-call cap with pagination disabled — more rows may remain un-ingested; pass ` +
          `paginate:true (now the default) instead of an explicit paginate:false`;
      result.errors.push(msg);
      log(msg);
    }

    let extractedCount = 0;
    let nullRoleCount = 0;

    for (const raw of rows) {
      const extracted = extractProstageRow(raw, maps, log);
      if (!extracted) continue;
      extractedCount += 1;
      if (extracted.role === null) nullRoleCount += 1;
      // Exact match on the RAW player_link first (covers the common case, and
      // the rare tracked pro whose pros.name itself legitimately ends in a
      // parenthetical), then on the CLEANED form — Leaguepedia's player_link
      // often carries a real-name disambiguator ("Zeka (Kim Geon-woo)") that
      // pros.name never does ("Zeka"), which silently left every such row's
      // pro_id null pre-fix (found 2026-07-11: ~400 existing rows across the
      // table, incl. tracked pros like Zeka — see
      // scripts/backfill-prostage-proid.mjs for the one-time repair of rows
      // ingested before this fix).
      const proId =
        proByName.get(extracted.playerLink.trim().toLowerCase()) ??
        proByName.get(cleanLeaguepediaName(extracted.playerLink).toLowerCase()) ??
        null;
      try {
        const inserted = (await sql`
          INSERT INTO coachbuild.prostage_matches (
            game_id, player_link, overview_page, tournament_display, team,
            champion_id, champion_name, role, win, kills, deaths, assists,
            game_datetime, patch, spells, final_items, trinket, runes, pro_id
          ) VALUES (
            ${extracted.gameId}, ${extracted.playerLink}, ${extracted.overviewPage}, ${extracted.tournamentDisplay}, ${extracted.team},
            ${extracted.championId}, ${extracted.championName}, ${extracted.role}, ${extracted.win}, ${extracted.kills}, ${extracted.deaths}, ${extracted.assists},
            ${extracted.gameDatetime}, ${extracted.patch},
            ${JSON.stringify(extracted.spells)}::jsonb, ${JSON.stringify(extracted.finalItems)}::jsonb, ${extracted.trinket},
            ${JSON.stringify(extracted.runes)}::jsonb, ${proId}
          )
          ON CONFLICT (game_id, player_link) DO NOTHING
          RETURNING game_id
        `) as unknown as { game_id: string }[];
        if (inserted.length > 0) result.rowsUpserted += 1;
      } catch (err) {
        result.errors.push(`game ${extracted.gameId} player ${extracted.playerLink}: ${(err as Error).message}`);
      }
    }

    // >50% unresolved role is a vocab-mismatch SIGNAL, not a per-row problem
    // (a handful of coach/analyst rows with no lane is normal and expected).
    // If Leaguepedia's real Role text differs from lib/prostage/roleMap.ts's
    // assumed vocabulary (e.g. "AD Carry" instead of "ADC"), ingest still
    // succeeds and stores every row (role nullable, never a skip reason) —
    // this warning is the only signal an operator gets that the map itself
    // needs a new alias, since a green ingest run alone won't reveal it.
    if (extractedCount > 0 && nullRoleCount / extractedCount > 0.5) {
      log(
        `tournament ${overviewPage}: ${nullRoleCount}/${extractedCount} rows have unresolved role — ` +
          `possible Role vocabulary mismatch, check lib/prostage/roleMap.ts`
      );
    }
  } catch (err) {
    result.errors.push(`tournament ${overviewPage}: ${(err as Error).message}`);
  }

  return result;
}
