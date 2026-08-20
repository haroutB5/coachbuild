// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/ingestMatches.ts — per-account match backfill/incremental ingest.
// Chunked by design: process `batch` accounts (ordered by last_fetched_at
// ascending) per call, return the next cursor. Shared core used by both
// scripts/ingest-matches.mjs (local backfill loop) and
// app/api/ingest/matches/route.ts (guarded, serverless-timeout-safe).
//
// CURSOR CONTRACT (P2 fix, 2026-07-17 Fable review): the cursor is a WALK-
// START TIMESTAMP (ISO string), not a numeric OFFSET. The old OFFSET/LIMIT
// walk had a real bug: processing a batch bumps those accounts'
// `last_fetched_at` to `now()`, which RE-SORTS them to the back of the very
// `ORDER BY last_fetched_at ASC` the OFFSET window slides over — so the next
// OFFSET-based page silently skips ~`batch` accounts (the ones that would
// have landed in the gap the just-processed accounts vacated) and re-fetches
// some already-processed accounts' tails instead. A stable predicate closes
// this: the first call in a walk mints `walkStart = now()` and every account
// selected must satisfy `last_fetched_at IS NULL OR last_fetched_at <
// walkStart` — a FIXED point in time, immune to reordering from writes that
// happen DURING the walk. `nextCursor` echoes the SAME walkStart back
// (never a fresh one) until a short page (fewer than `batch` rows) signals
// the walk is done, at which point it's null. The cron path (no `cursor`
// query param) mints its own fresh walkStart every invocation and behaves
// identically to before for a single un-pinged call — see
// app/api/ingest/matches/route.ts's header comment.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "./db";
import { DbUnavailableError, RiotUnavailableError } from "./errors";
import { extractMatch } from "./extract";
import { freshStartTimeEpochSec } from "./fresh";
import { routingForServer } from "./regionMap";
import { getMatch, getMatchIdsByPuuid, getMatchTimeline, isRateLimited, RiotRequestError } from "./riot";
import { runRetentionPruneSafely } from "@/lib/retention/prune";

export interface MatchIngestOptions {
  batch?: number;
  /** Walk-start timestamp (ISO string), from a PRIOR call's `nextCursor` —
   *  see this file's header CURSOR CONTRACT. Omit on the first call of a
   *  walk; one is minted from `now()` internally. */
  cursor?: string;
  matchesPerAccount?: number;
  onProgress?: (msg: string) => void;
  /** Set false to skip the end-of-sweep retention prune. Exists for tests and
   *  for a deliberate "ingest only" run; the prune is on by default because a
   *  retention policy nobody remembers to enable is not a retention policy. */
  prune?: boolean;
}

export interface MatchIngestResult {
  accountsProcessed: number;
  matchesUpserted: number;
  /** Echoes the walk's stable start timestamp (ISO string) back for the
   *  caller's next call, or null once the walk has drained every account
   *  that qualified under it — see this file's header CURSOR CONTRACT. */
  nextCursor: string | null;
  errors: string[];
  /** The walk STOPPED because Riot rate-limited us even after lib/pro/riot.ts
   *  honoured the server's own Retry-After and retried. Distinct from an entry
   *  in `errors`: this is systemic (something else is spending the key), it is
   *  never a property of one account, and continuing to walk would spend the
   *  rest of the budget discovering the same thing 1,400 more times. */
  rateLimited: boolean;
}

interface AccountRow {
  puuid: string;
  pro_id: string;
  region: string;
  riot_id: string;
}

export async function runMatchIngest(opts: MatchIngestOptions = {}): Promise<MatchIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const batch = opts.batch ?? 5;
  // A fresh walk mints its own start point; a resumed walk (pinger passing
  // back a prior nextCursor) reuses the SAME one for every call — see the
  // CURSOR CONTRACT in this file's header comment for why that stability
  // matters (an OFFSET-based walk didn't have it). A cursor in the future
  // would make every account perpetually qualify (endless rolling walk), so
  // clamp to now — ISO-8601 strings at fixed precision compare lexically.
  const nowIso = new Date().toISOString();
  const walkStart = opts.cursor && opts.cursor < nowIso ? opts.cursor : nowIso;
  const matchesPerAccount = opts.matchesPerAccount ?? 20;
  const log = opts.onProgress ?? (() => {});

  const result: MatchIngestResult = {
    accountsProcessed: 0,
    matchesUpserted: 0,
    nextCursor: null,
    errors: [],
    rateLimited: false,
  };

  // Tiebreaker is load-bearing: `last_fetched_at ASC NULLS FIRST` alone leaves
  // every never-fetched account (NULL) in an UNSTABLE relative order — Postgres
  // makes no ordering guarantee among equal (here: all-NULL) sort keys, so an
  // unstably-ordered window can return an arbitrary subset per call, with no
  // guarantee every account is ever eventually reached. Audit 2026-07-13 found
  // 1,312/1,445 active accounts permanently stuck at NULL for exactly this
  // reason. `created_at ASC` breaks the tie deterministically — oldest-
  // registered NULL account goes first — so every account is reached in
  // bounded time (a strict FIFO once last_fetched_at is set, since a fresh
  // fetch pushes an account to "now()", far behind the remaining NULLs).
  //
  // `last_fetched_at < walkStart` (instead of OFFSET/LIMIT) is what makes
  // this walk immune to the accounts THIS VERY CALL just bumped to now() —
  // those fail the predicate on the NEXT call regardless of where they'd
  // sort, so nothing is ever skipped or double-counted mid-walk.
  const accounts = (await sql`
    SELECT puuid, pro_id, region, riot_id
    FROM coachbuild.pro_accounts
    WHERE active = true
      AND (last_fetched_at IS NULL OR last_fetched_at < ${walkStart}::timestamptz)
    ORDER BY last_fetched_at ASC NULLS FIRST, created_at ASC
    LIMIT ${batch}
  `) as unknown as AccountRow[];

  for (const account of accounts) {
    result.accountsProcessed += 1;
    try {
      const upserted = await ingestOneAccount(sql, account, matchesPerAccount, log);
      result.matchesUpserted += upserted;
    } catch (err) {
      result.errors.push(`account ${account.riot_id}: ${(err as Error).message}`);

      // RATE LIMIT: stop the walk, and deliberately do NOT bump the stamp.
      //
      // The bump below is a termination guard, and it is the right answer for
      // an account-specific error — but a 429 says nothing about this account.
      // Stamping it would mark an account we never examined as freshly fetched
      // and hide it from the walk for a whole cycle, which on a 1,445-account
      // sweep is hours of staleness bought to paper over a transient. Skipping
      // the bump is only safe BECAUSE we abort right here: an un-bumped account
      // still satisfies the walk predicate and still sorts to the front, so
      // continuing would re-select it forever (the exact loop the guard exists
      // to prevent). The two decisions are one decision — do not separate them.
      //
      // Aborting is also the safety behaviour that matters most. lib/pro/riot.ts
      // has already honoured Riot's Retry-After and retried; still being limited
      // means a second process is spending this key right now, and grinding
      // through the remaining accounts is how a transient 429 becomes a
      // suspended key that blanks every surface in the app (gotcha (d)).
      if (isRateLimited(err)) {
        result.rateLimited = true;
        result.nextCursor = null;
        return result;
      }

      // Termination guard: an account that errors without a last_fetched_at
      // bump still satisfies the walk predicate and still sorts at the front,
      // so a page of all-erroring accounts (suspended key -> every call 403s)
      // would make the walk loop forever re-fetching the same page. Data is
      // safe to defer — bump the stamp so the walk moves past it and the next
      // daily cycle retries (same argument the route makes for mid-batch
      // timeouts).
      try {
        await sql`
          UPDATE coachbuild.pro_accounts
          SET last_fetched_at = now()
          WHERE puuid = ${account.puuid}
        `;
      } catch (bumpErr) {
        result.errors.push(
          `account ${account.riot_id}: stamp-bump failed: ${(bumpErr as Error).message}`
        );
      }
    }
  }

  result.nextCursor = accounts.length < batch ? null : walkStart;

  // RETENTION, at the end of a COMPLETED sweep — not on every page.
  //
  // `nextCursor === null` is this walk's own "the queue drained" signal (see
  // the CURSOR CONTRACT above), and scripts/ingest-matches.mjs loops until it
  // sees exactly that, so this fires once per sweep rather than ~289 times.
  // A rate-limited abort also nulls the cursor but accomplished nothing, so it
  // is excluded — spending database time to tidy up after a walk that could
  // not run is the wrong instinct on a metered compute. That path already
  // RETURNS EARLY from inside the loop, so `!result.rateLimited` here is a
  // second line of defence rather than the live mechanism; it is kept
  // deliberately so that turning the early return into a `break` later cannot
  // silently start pruning after a 429. (Mutation-checked: removing this
  // clause alone does not change behaviour today, precisely because the early
  // return is doing the work.)
  //
  // Deliberately NOT a new scheduled task. The incident this cleans up after
  // was caused by an unattended scheduled task with a bad cadence; folding the
  // prune into work that is already happening adds no new duty cycle, no new
  // registration to hand-edit, and no new thing to forget. lib/retention/prune
  // .ts additionally throttles itself to one run per table per 20h, so this
  // stays correct no matter how often the sweep completes.
  //
  // `runRetentionPruneSafely` never throws: a walk that fetched real matches
  // must never be failed by housekeeping, and the database being unreachable
  // must degrade to "did not prune", never to a failed ingest.
  if (!result.rateLimited && result.nextCursor === null && opts.prune !== false) {
    await runRetentionPruneSafely(sql, ["pro_matches"], { log });
  }

  return result;
}

export async function ingestOneAccount(
  sql: NonNullable<ReturnType<typeof getSql>>,
  account: AccountRow,
  matchesPerAccount: number,
  log: (msg: string) => void
): Promise<number> {
  const routing = routingForServer(account.region);
  if (!routing) {
    log(`account ${account.riot_id}: unmapped region ${account.region}, skipping`);
    // Permanent condition (the region map is static) — stamp it so the walk
    // terminates instead of re-selecting the account at the front of every
    // page forever. See the termination guard in runMatchIngest's catch.
    await sql`
      UPDATE coachbuild.pro_accounts
      SET last_fetched_at = now()
      WHERE puuid = ${account.puuid}
    `;
    return 0;
  }

  const matchIds = await getMatchIdsByPuuid(routing.regional, account.puuid, {
    queue: 420,
    start: 0,
    count: matchesPerAccount,
    startTime: freshStartTimeEpochSec(),
  });

  let existing = new Set<string>();
  if (matchIds.length > 0) {
    const rows = (await sql`
      SELECT match_id FROM coachbuild.pro_matches
      WHERE puuid = ${account.puuid} AND match_id = ANY(${matchIds}::text[])
    `) as unknown as { match_id: string }[];
    existing = new Set(rows.map((r) => r.match_id));
  }
  const newIds = matchIds.filter((id) => !existing.has(id));

  let upserted = 0;
  let maxGameCreation: number | null = null;

  for (const matchId of newIds) {
    try {
      const match = await getMatch(routing.regional, matchId);
      const timeline = await getMatchTimeline(routing.regional, matchId);
      const row = extractMatch(match, timeline, account.puuid, account.pro_id);
      if (!row) {
        log(`match ${matchId}: unresolvable role/participant, skipping`);
        continue;
      }
      await sql`
        INSERT INTO coachbuild.pro_matches (
          match_id, puuid, pro_id, champion_id, champion_name, role, patch, win,
          kills, deaths, assists, game_creation, game_duration_sec,
          spells, final_items, trinket, purchase_order, skill_order, runes,
          cs, damage_champions, team_kills, gold, ally_champion_ids, enemy_champion_ids,
          ally_players, enemy_players
        ) VALUES (
          ${row.matchId}, ${row.puuid}, ${account.pro_id}, ${row.championId}, ${row.championName},
          ${row.role}, ${row.patch}, ${row.win}, ${row.kills}, ${row.deaths}, ${row.assists},
          ${row.gameCreation}, ${row.gameDurationSec},
          ${JSON.stringify(row.spells)}::jsonb, ${JSON.stringify(row.finalItems)}::jsonb, ${row.trinket},
          ${JSON.stringify(row.purchaseOrder)}::jsonb, ${JSON.stringify(row.skillOrder)}::jsonb, ${JSON.stringify(row.runes)}::jsonb,
          ${row.cs}, ${row.damageChampions}, ${row.teamKills}, ${row.gold},
          ${row.allyChampionIds ? JSON.stringify(row.allyChampionIds) : null}::jsonb,
          ${row.enemyChampionIds ? JSON.stringify(row.enemyChampionIds) : null}::jsonb,
          ${row.allyPlayers ? JSON.stringify(row.allyPlayers) : null}::jsonb,
          ${row.enemyPlayers ? JSON.stringify(row.enemyPlayers) : null}::jsonb
        )
        ON CONFLICT (match_id, puuid) DO NOTHING
      `;
      upserted += 1;
      const ts = new Date(row.gameCreation).getTime();
      if (maxGameCreation === null || ts > maxGameCreation) maxGameCreation = ts;
    } catch (err) {
      // A 429 is NOT a property of this match — the match is fine, the key is
      // saturated — so skipping it silently drops a real game and, worse, moves
      // straight on to the next Riot call. lib/pro/riot.ts has already waited
      // out the server's Retry-After and retried by the time we see one here,
      // so let it propagate: runMatchIngest's catch turns it into a walk abort.
      // Every OTHER Riot status (404 on a match Riot has purged, a 5xx blip)
      // genuinely is per-match and keeps the original skip-and-continue.
      if (err instanceof RiotRequestError && err.status !== 429) {
        log(`match ${matchId}: riot ${err.status}, skipping`);
        continue;
      }
      throw err;
    }
  }

  await sql`
    UPDATE coachbuild.pro_accounts
    SET last_fetched_at = now(),
        last_match_ts = GREATEST(COALESCE(last_match_ts, 0), ${maxGameCreation ?? 0})
    WHERE puuid = ${account.puuid}
  `;

  return upserted;
}
