// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/ingest.ts — the OTP (one-trick) pipeline, in two independent halves.
//
//   DISCOVERY  op.gg champion leaderboard -> Riot account-v1 -> otp_accounts
//   MATCHES    otp_accounts -> Riot match-v5 -> otp_matches
//
// They advance separately on purpose: who the one-tricks ARE churns on a
// weekly scale, what they BUILD changes every game.
//
// ── COST, STATED UP FRONT ───────────────────────────────────────────────────
// Every Riot call in this process is serialised through lib/pro/pacer.ts's
// single 1.3s queue, SHARED with pro-account ingest, My Stats and every audit
// script (repo gotcha (d)). So this pipeline's cost is wall-clock contention,
// not just quota:
//   discovery  = 1 op.gg call + <=N account-v1 calls per champion
//   matches    = 1 ids call + <=`matchesPerAccount` match calls per account
// The regular roster pass deliberately does NOT fetch match-v5 TIMELINE. The
// on-demand featured path opts into a capped first-N timeline sample only for
// the account currently surfaced by otp_featured; the rest of the roster keeps
// the cheaper empty-timeline path.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "../pro/db";
import { DbUnavailableError, RiotUnavailableError } from "../pro/errors";
import { extractMatch } from "../pro/extract";
import { freshStartTimeEpochSec } from "../pro/fresh";
import { routingForServer } from "../pro/regionMap";
import { getAccountByRiotId, getMatch, getMatchIdsByPuuid, getMatchTimeline, RiotRequestError } from "../pro/riot";
import type { RiotTimeline } from "../pro/types";
import { opggChampionName } from "../opgg";
import { fetchOtpCandidates, type OtpCandidate } from "./leaderboard";
import { ROUTINGS, type Routing } from "./featured";

/** Regions the leaderboard is read from, best-first.
 *
 *  KR leads because it is the deepest solo-queue ladder and its one-tricks
 *  are the closest thing to a build authority; EUW is second because it is
 *  the user's own region, so its games are played against the ladder they
 *  actually queue into. Both are read for every champion and the results are
 *  pooled — a wider, less region-skewed sample for the same per-champion
 *  op.gg call count (one per region either way). */
export const OTP_REGIONS = ["KR", "EUW"] as const;

/** Per-region cap on how many leaderboard entries become tracked accounts.
 *  op.gg returns 10; taking the top 4 from each of 2 regions gives 8 accounts
 *  per champion, which at MATCHES_PER_ACCOUNT below yields a ~100-160-game
 *  sample — comfortably more than the Pro Consensus card gets — without
 *  making a single champion's pass monopolise the shared Riot pacer. */
export const CANDIDATES_PER_REGION = 4;

/** Minimum games on the champion before we call someone a one-trick.
 *
 *  This is the number the whole feature's honesty rests on, so it is a
 *  threshold, not a vibe: below it a player is "someone who plays this
 *  champion," which is not what the card claims. 100 is deliberately high —
 *  the live EUW Viktor leaderboard's 10th-placed player had 491 games on him
 *  (probed 2026-07-28), so a real leaderboard clears this by a wide margin
 *  and the floor only bites on thinly-played champions, where returning
 *  NOTHING is the correct answer. */
export const MIN_CHAMPION_PLAYS = 100;

/** Recent ranked games pulled per account per pass. */
export const MATCHES_PER_ACCOUNT = 20;

/** Timeline-backed games per surfaced featured one-trick account. Thirty
 *  timeline calls at the shared 1.3s Riot pacer are about 39 seconds per
 *  account; this is deliberately not a roster-wide backfill of every OTP
 *  match. Existing non-NULL orders are skipped, so reruns spend no timeline
 *  calls on games already measured. */
export const FEATURED_TIMELINE_GAME_LIMIT = 30;

export interface DiscoverResult {
  championId: number;
  candidatesSeen: number;
  accountsUpserted: number;
  errors: string[];
}

export interface OtpMatchIngestResult {
  accountsProcessed: number;
  matchesUpserted: number;
  errors: string[];
}

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** An empty timeline. extractMatch requires one, and both functions it feeds
 *  it to (buildPurchaseOrder/buildSkillOrder) simply iterate `info.frames` —
 *  so an empty frame list yields empty purchaseOrder/skillOrder rather than
 *  anything invented. That is the SAME structural gap prostage rows already
 *  have (repo gotcha (h)), which the UI is already built to tolerate. */
const NO_TIMELINE: RiotTimeline = { info: { frames: [] } };

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Refresh the tracked one-trick roster for ONE champion.
 *
 * `championKey` is the Riot champion key ("Viktor"), converted to op.gg's
 * UPPER_SNAKE_CASE form by lib/opgg.ts's existing transform — there is
 * deliberately no second champion-name table in this repo (repo gotcha (y) is
 * what a parallel mapping table rots into).
 *
 * Never throws on a provider failure: op.gg returning nothing is recorded as
 * "no candidates this pass," not a failed run. It DOES throw on a missing DB
 * or Riot key, which are configuration faults the caller must see.
 */
export async function discoverOtpAccounts(
  championId: number,
  championKey: string,
  opts: { regions?: readonly string[]; perRegion?: number; log?: (msg: string) => void } = {}
): Promise<DiscoverResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const regions = opts.regions ?? OTP_REGIONS;
  const perRegion = opts.perRegion ?? CANDIDATES_PER_REGION;
  const log = opts.log ?? (() => {});
  const result: DiscoverResult = { championId, candidatesSeen: 0, accountsUpserted: 0, errors: [] };

  const opggChampion = opggChampionName(championKey);

  for (const region of regions) {
    const routing = routingForServer(region);
    if (!routing) {
      result.errors.push(`region ${region}: unmapped in lib/pro/regionMap.ts`);
      continue;
    }

    const candidates = await fetchOtpCandidates(opggChampion, championId, region);
    result.candidatesSeen += candidates.length;
    if (candidates.length === 0) {
      log(`${championKey}/${region}: leaderboard returned no usable rows`);
      continue;
    }

    // Two SEPARATE reductions, logged separately on purpose: conflating them
    // would report players merely cut by the per-region cap as "below the
    // one-trick floor," which is a false statement about the data.
    const aboveFloor = candidates.filter((c) => c.championPlays >= MIN_CHAMPION_PLAYS);
    const qualified = [...aboveFloor]
      .sort((a, b) => b.championPlays - a.championPlays)
      .slice(0, perRegion);

    const belowFloor = candidates.length - aboveFloor.length;
    if (belowFloor > 0) {
      log(
        `${championKey}/${region}: ${belowFloor} candidate(s) below the ${MIN_CHAMPION_PLAYS}-game one-trick floor`
      );
    }
    if (aboveFloor.length > qualified.length) {
      log(
        `${championKey}/${region}: ${aboveFloor.length - qualified.length} qualifying candidate(s) not taken (per-region cap ${perRegion})`
      );
    }

    for (const candidate of qualified) {
      try {
        const upserted = await upsertCandidate(sql, championId, region, routing.regional, candidate);
        if (upserted) result.accountsUpserted += 1;
      } catch (err) {
        // A single unresolvable account (renamed, transferred, deleted) must
        // not sink the champion's whole pass.
        result.errors.push(
          `${candidate.gameName}#${candidate.tagLine} (${region}): ${(err as Error).message}`
        );
      }
    }
  }

  await sql`
    INSERT INTO coachbuild.otp_champion_cursor (champion_id, last_discovered_at, last_attempted_at)
    VALUES (${championId}, now(), now())
    ON CONFLICT (champion_id) DO UPDATE
      SET last_discovered_at = now(), last_attempted_at = now()
  `;

  return result;
}

/** Resolves a leaderboard entry to a REAL Riot puuid and stores it.
 *
 *  The op.gg-supplied puuid is deliberately unused — live-probed 2026-07-28,
 *  Riot answers `400 Exception decrypting` for it on both account-v1 and
 *  match-v5, so it is an op.gg-scoped id. game_name + tag_line through
 *  account-v1 is the only path that yields an id match-v5 accepts. */
async function upsertCandidate(
  sql: Sql,
  championId: number,
  region: string,
  regional: string,
  candidate: OtpCandidate
): Promise<boolean> {
  const account = await getAccountByRiotId(regional, candidate.gameName, candidate.tagLine);
  if (!account?.puuid) return false;

  await sql`
    INSERT INTO coachbuild.otp_accounts (
      champion_id, puuid, region, game_name, tag_line,
      leaderboard_rank, champ_play, champ_win, tier, active
    ) VALUES (
      ${championId}, ${account.puuid}, ${region},
      ${account.gameName ?? candidate.gameName}, ${account.tagLine ?? candidate.tagLine},
      ${candidate.rank}, ${candidate.championPlays}, ${candidate.championWins},
      ${candidate.tier}, true
    )
    ON CONFLICT (champion_id, puuid) DO UPDATE SET
      region = EXCLUDED.region,
      game_name = EXCLUDED.game_name,
      tag_line = EXCLUDED.tag_line,
      leaderboard_rank = EXCLUDED.leaderboard_rank,
      champ_play = EXCLUDED.champ_play,
      champ_win = EXCLUDED.champ_win,
      tier = EXCLUDED.tier,
      active = true
  `;
  return true;
}

// ── Match ingest ─────────────────────────────────────────────────────────────

interface OtpAccountRow {
  puuid: string;
  champion_id: number;
  region: string;
  game_name: string;
  tag_line: string;
}

interface OtpFeaturedRow {
  puuid: string;
  champion_id: number;
  game_name: string;
  tag_line: string;
  match_routing: string | null;
}

function featuredMatchRouting(value: string | null): Routing | null {
  return value && (ROUTINGS as readonly string[]).includes(value) ? (value as Routing) : null;
}

/**
 * Pull recent ranked games for the stalest tracked OTP accounts.
 *
 * `championId` scopes the pass to one champion (what the on-demand refresh
 * route wants); omit it to walk every champion's accounts stalest-first
 * (what the background job wants).
 */
export async function runOtpMatchIngest(
  opts: {
    championId?: number;
    batch?: number;
    matchesPerAccount?: number;
    /** Only timeline the account currently surfaced by otp_featured. */
    fetchFeaturedTimelines?: boolean;
    log?: (msg: string) => void;
  } = {}
): Promise<OtpMatchIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const batch = opts.batch ?? 8;
  const matchesPerAccount = opts.matchesPerAccount ?? MATCHES_PER_ACCOUNT;
  const log = opts.log ?? (() => {});
  const result: OtpMatchIngestResult = { accountsProcessed: 0, matchesUpserted: 0, errors: [] };

  // The featured account is a separate discovery product from the roster in
  // otp_accounts. It is therefore not safe to select a roster row and hope it
  // happens to have the same puuid as otp_featured: the surfaced account may
  // not be in that roster at all. The refresh route asks for timelines for the
  // one featured player, so resolve that row directly and do not walk any
  // other account for this invocation.
  if (opts.fetchFeaturedTimelines) {
    if (opts.championId == null) {
      result.errors.push("featured timeline ingest requires championId");
      return result;
    }

    const featuredRows = (await sql`
      SELECT puuid, champion_id, game_name, tag_line, match_routing
      FROM coachbuild.otp_featured
      WHERE champion_id = ${opts.championId}
      LIMIT 1
    `) as unknown as OtpFeaturedRow[];

    if (featuredRows.length === 0) {
      log(`champion ${opts.championId}: no featured account to timeline`);
      return result;
    }

    const featured = featuredRows[0];
    result.accountsProcessed = 1;
    try {
      result.matchesUpserted += await ingestFeaturedOtpAccount(
        sql,
        featured,
        matchesPerAccount,
        log
      );
    } catch (err) {
      result.errors.push(`${featured.game_name}#${featured.tag_line}: ${(err as Error).message}`);
    }
    return result;
  }

  // `discovered_at ASC` is the load-bearing tiebreaker, not decoration: a
  // bare `last_fetched_at ASC NULLS FIRST` leaves every never-fetched account
  // in an unstable relative order, and an unstably-ordered LIMIT window can
  // return an arbitrary subset forever — the exact defect that left 1,312
  // pro_accounts permanently unfetched (see lib/pro/ingestMatches.ts).
  const accounts = (await sql`
    SELECT puuid, champion_id, region, game_name, tag_line
    FROM coachbuild.otp_accounts
    WHERE active = true
      AND (${opts.championId ?? null}::int IS NULL OR champion_id = ${opts.championId ?? null}::int)
    ORDER BY last_fetched_at ASC NULLS FIRST, discovered_at ASC
    LIMIT ${batch}
  `) as unknown as OtpAccountRow[];

  for (const account of accounts) {
    result.accountsProcessed += 1;
    try {
      result.matchesUpserted += await ingestOneOtpAccount(
        sql,
        account,
        matchesPerAccount,
        log,
        0
      );
    } catch (err) {
      result.errors.push(`${account.game_name}#${account.tag_line}: ${(err as Error).message}`);
      // Termination guard, same as lib/pro/ingestMatches.ts: an account that
      // errors WITHOUT a stamp bump keeps sorting to the front, so a page of
      // all-erroring accounts (suspended key -> every call 403s) would loop
      // on the same page forever. Deferring data is safe; looping is not.
      try {
        await sql`
          UPDATE coachbuild.otp_accounts SET last_fetched_at = now()
          WHERE champion_id = ${account.champion_id} AND puuid = ${account.puuid}
        `;
      } catch (bumpErr) {
        result.errors.push(`${account.game_name}: stamp-bump failed: ${(bumpErr as Error).message}`);
      }
    }
  }

  return result;
}

async function ingestFeaturedOtpAccount(
  sql: Sql,
  featured: OtpFeaturedRow,
  matchesPerAccount: number,
  log: (msg: string) => void
): Promise<number> {
  const regional = featuredMatchRouting(featured.match_routing);
  if (!regional) {
    log(
      `${featured.game_name}#${featured.tag_line}: unsupported featured match routing ` +
        `${featured.match_routing ?? "(null)"}, skipping`
    );
    return 0;
  }

  return ingestOneOtpAccount(
    sql,
    {
      puuid: featured.puuid,
      champion_id: featured.champion_id,
      // The featured row's stored match_routing is authoritative. This field
      // is unused when regionalOverride is supplied and is only present to
      // satisfy the shared account shape.
      region: "",
      game_name: featured.game_name,
      tag_line: featured.tag_line,
    },
    matchesPerAccount,
    log,
    FEATURED_TIMELINE_GAME_LIMIT,
    regional,
    false
  );
}

export async function ingestOneOtpAccount(
  sql: Sql,
  account: OtpAccountRow,
  matchesPerAccount: number,
  log: (msg: string) => void,
  timelineLimit = 0,
  regionalOverride: string | null = null,
  updateRosterStamp = true
): Promise<number> {
  const regional = regionalOverride ?? routingForServer(account.region)?.regional ?? null;
  if (!regional) {
    log(`${account.game_name}: unmapped region ${account.region}, skipping`);
    // Permanent condition — stamp it so the walk terminates rather than
    // re-selecting this account at the front of every page forever.
    if (updateRosterStamp) {
      await sql`
        UPDATE coachbuild.otp_accounts SET last_fetched_at = now()
        WHERE champion_id = ${account.champion_id} AND puuid = ${account.puuid}
      `;
    }
    return 0;
  }

  const matchIds = await getMatchIdsByPuuid(regional, account.puuid, {
    queue: 420,
    start: 0,
    count: matchesPerAccount,
    startTime: freshStartTimeEpochSec(),
  });

  let existing = new Set<string>();
  const existingSkillOrders = new Map<string, unknown>();
  let featured = regionalOverride !== null;
  if (timelineLimit > 0) {
    if (!featured) {
      const featuredRows = await sql`
        SELECT 1 FROM coachbuild.otp_featured
        WHERE champion_id = ${account.champion_id} AND puuid = ${account.puuid}
        LIMIT 1
      `;
      featured = featuredRows.length > 0;
    }
  }
  if (matchIds.length > 0) {
    const rows = (await sql`
      SELECT match_id, skill_order FROM coachbuild.otp_matches
      WHERE puuid = ${account.puuid} AND match_id = ANY(${matchIds}::text[])
    `) as unknown as { match_id: string; skill_order: unknown }[];
    existing = new Set(rows.map((r) => r.match_id));
    rows.forEach((r) => existingSkillOrders.set(r.match_id, r.skill_order));
  }
  const timelineIds = new Set(
    featured
      ? matchIds
          .slice(0, timelineLimit)
          .filter((id) => existingSkillOrders.get(id) == null)
      : []
  );
  const workIds = matchIds.filter((id) => !existing.has(id) || timelineIds.has(id));

  let upserted = 0;
  for (const matchId of workIds) {
    try {
      const match = await getMatch(regional, matchId);
      let timeline = NO_TIMELINE;
      let timelineFetched = false;
      if (timelineIds.has(matchId)) {
        try {
          timeline = await getMatchTimeline(regional, matchId);
          timelineFetched = true;
        } catch (err) {
          log(`match ${matchId}: timeline unavailable — ${(err as Error).message}`);
        }
      }
      const row = extractMatch(match, timeline, account.puuid);
      if (!row) {
        log(`match ${matchId}: unresolvable role/participant, skipping`);
        continue;
      }
      // A one-trick still plays other champions. Only the tracked champion's
      // games are evidence for THIS champion's card — storing the rest would
      // silently widen the sample into "games by people who main something
      // else," which is not what the card says it shows.
      if (row.championId !== account.champion_id) continue;

      if (existing.has(matchId) && timelineFetched) {
        await sql`
          UPDATE coachbuild.otp_matches
          SET skill_order = ${JSON.stringify(row.skillOrder)}::jsonb
          WHERE puuid = ${account.puuid} AND match_id = ${matchId}
            AND skill_order IS NULL
        `;
      } else {
        await sql`
          INSERT INTO coachbuild.otp_matches (
          match_id, puuid, champion_id, champion_name, role, patch, win,
          kills, deaths, assists, game_creation, game_duration_sec,
          spells, final_items, trinket, runes, skill_order
          ) VALUES (
          ${row.matchId}, ${row.puuid}, ${row.championId}, ${row.championName},
          ${row.role}, ${row.patch}, ${row.win}, ${row.kills}, ${row.deaths}, ${row.assists},
          ${row.gameCreation}, ${row.gameDurationSec},
          ${JSON.stringify(row.spells)}::jsonb, ${JSON.stringify(row.finalItems)}::jsonb,
          ${row.trinket}, ${JSON.stringify(row.runes)}::jsonb,
          ${timelineFetched ? JSON.stringify(row.skillOrder) : null}::jsonb
          )
          ON CONFLICT (match_id, puuid) DO NOTHING
        `;
        upserted += 1;
      }
    } catch (err) {
      if (err instanceof RiotRequestError) {
        log(`match ${matchId}: riot ${err.status}, skipping`);
        continue;
      }
      throw err;
    }
  }

  if (updateRosterStamp) {
    await sql`
      UPDATE coachbuild.otp_accounts SET last_fetched_at = now()
      WHERE champion_id = ${account.champion_id} AND puuid = ${account.puuid}
    `;
  }

  return upserted;
}
