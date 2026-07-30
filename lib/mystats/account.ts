// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/account.ts — the linked-account registry behind My Stats.
//
// WAS single-account (migration 0012's `CHECK (id = 1)`); is now MULTI-account
// with exactly one ACTIVE row (migration 0020). The user asked for this
// directly on 2026-07-29 — "get the account based on what I'm logged in with,
// then save it so it can be fetched from a list when needed. Currently I'm in
// game with K1ayer #swift but in myStats its still MunsterHunter".
//
// THREE WAYS AN ACCOUNT GETS HERE, in descending order of trustworthiness:
//
//  1. DETECTED from the League client (the point of the feature). The
//     companion's GET /me (1.10.0+) reads /lol-summoner/v1/current-summoner and
//     reports gameName/tagLine/puuid; the browser POSTs that to
//     /api/mystats/accounts, which calls linkAccount below. This is the only
//     path that needs no guessing at all — the puuid comes from the client the
//     user is actually logged into.
//  2. SELECTED from the list (setActiveAccount) — already-linked, nothing to
//     resolve.
//  3. SEEDED FROM ENV (seedAccountFromEnv) — MY_RIOT_ID/MY_RIOT_REGION, kept
//     ONLY as the cold-start path for a database with no accounts at all
//     (a fresh deploy, or after a purge). See its own doc comment for the
//     behaviour change: it used to be reachable via a helper that claimed to
//     let env "correct" a wrong account and in practice never could.
//
// REGION IS RESOLVED, NEVER DERIVED. match-v5 is routed by regional cluster, so
// an account is useless for ingest until its region is known, and NOTHING in
// the detected identity carries one: a tagLine is not a region (the user's own
// "K1ayer#swift" proves it — routingForServer("swift") is null) and the real
// captured current-summoner payload has no region/platformId field at all. The
// answer comes from Riot's own account-v1 region-by-puuid endpoint via
// lib/pro/riot.ts's getRegionByPuuid — one call, authoritative, and only ever
// made for a puuid this table has never seen before (an already-linked account
// reuses its stored region, so switching back and forth is free).
// ─────────────────────────────────────────────────────────────────────────────

import {
  getAccountByRiotId,
  getRegionByPuuid,
  DEFAULT_ACCOUNT_ROUTING,
  RiotRequestError,
} from "@/lib/pro/riot";
import { RiotUnavailableError } from "@/lib/pro/errors";
import { routingForServer, routingForPlatform, type RiotRouting } from "@/lib/pro/regionMap";
import { rankFromRow, type RankRow } from "./rank";
import { COUNTED_QUEUE_IDS } from "./queues";
import type { getSql } from "@/lib/pro/db";
import type { MyAccountRow } from "./types";

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** Cold-start seed only — see seedAccountFromEnv. NOT an override: once any
 *  account row exists, these are never read again. */
export const MY_RIOT_ID = process.env.MY_RIOT_ID ?? "MunsterHunter#EUW";
export const MY_RIOT_REGION = process.env.MY_RIOT_REGION ?? "EUW";

/** The account every My Stats read is scoped to. `puuid` is the scoping key
 *  (see migration 0020's header for why puuid and not riot_id) and `routing`
 *  is what the Riot ingest calls need. */
export interface ResolvedMyAccount {
  id: number;
  puuid: string;
  riotId: string;
  gameName: string;
  tagLine: string;
  region: string;
  routing: RiotRouting;
}

/** ONE ENTRY IN THE PICKER LIST — the public, browser-facing shape.
 *
 *  Deliberately carries NO puuid. The picker switches by `id`, an opaque local
 *  smallint, so the account's Riot-side identifier never has to be shipped to
 *  the client or accepted back from it. That also means a client cannot ask to
 *  activate an arbitrary puuid it made up — only an id this table already
 *  holds. */
export interface MyAccountSummary {
  id: number;
  /** "gameName#tagLine", the display tag. */
  riotId: string;
  gameName: string;
  tagLine: string;
  /** This app's server key, e.g. "EUW" (lib/pro/regionMap.ts). */
  region: string;
  active: boolean;
  /** ISO, or null if the companion has never reported this account. Display
   *  ordering hint only — never a filter, never auto-switches anything. */
  lastSeenAt: string | null;
  /** How many COUNTED matches this account has — solo/duo only, the same scope
   *  every figure on /api/mystats/summary is computed over
   *  (lib/mystats/queues.ts). Lets the picker show "138 games" beside a name
   *  instead of an unlabelled tag.
   *
   *  DELIBERATELY NOT "stored matches", which is what it used to be and what
   *  the SQL below still could report trivially. The card sits directly beside
   *  the stats it describes, so a card reading "186g" next to a win rate
   *  computed over 141 games is two numbers on one screen disagreeing about
   *  what a game is. The card must count what the stats count. */
  games: number;
  /** Wins among those same `games` (2026-07-30, user directive: "just add the
   *  percentage WR into the account section above").
   *
   *  A COUNT, not a rate, and counted in the same SQL pass over the same
   *  predicate as `games`. The card divides. Shipping a pre-divided percentage
   *  would hide its denominator from the one surface that also displays it, and
   *  a numerator and denominator sourced from two queries are two denominators
   *  waiting to drift — which this app has already shipped once (v0.73.1).
   *  `games === 0` means there is no rate to state; render a dash, never 0%. */
  wins: number;
  /** Migration 0022 — ranked solo/duo standing, spread onto this shape rather
   *  than nested, so a card can read `account.tier` directly.
   *
   *  READ `rankUnknown` BEFORE `tier`. A null tier means genuinely UNRANKED
   *  only when rankUnknown is false; when rankUnknown is true every one of
   *  these fields is null and means nothing at all. lib/mystats/rank.ts's
   *  rankFromRow is the ONE place that decides which of the two it is — never
   *  re-derive it from the tier being null. */
  tier: string | null;
  division: string | null;
  lp: number | null;
  rankWins: number | null;
  rankLosses: number | null;
  rankUnknown: boolean;
  rankCheckedAt: string | null;
}

export function splitRiotId(riotId: string): { gameName: string; tagLine: string } | null {
  const idx = riotId.indexOf("#");
  if (idx < 0) return null;
  const gameName = riotId.slice(0, idx);
  const tagLine = riotId.slice(idx + 1);
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

export function formatRiotId(gameName: string, tagLine: string): string {
  return `${gameName}#${tagLine}`;
}

interface AccountDbRow extends Pick<MyAccountRow, "riot_id" | "puuid" | "region"> {
  id: number;
}

function toResolved(row: AccountDbRow): ResolvedMyAccount | null {
  const routing = routingForServer(row.region);
  if (!routing) return null; // region was validated at link time -- stay defensive rather than route a Riot call at a guess
  const parts = splitRiotId(row.riot_id);
  return {
    id: row.id,
    puuid: row.puuid,
    riotId: row.riot_id,
    gameName: parts?.gameName ?? row.riot_id,
    tagLine: parts?.tagLine ?? "",
    region: row.region,
    routing,
  };
}

/** THE account read. Every My Stats surface scopes to whatever this returns,
 *  and null means "show the accountUnresolved empty state" — never "show
 *  everything", which is what an unscoped query would have done. */
export async function getActiveAccount(sql: Sql): Promise<ResolvedMyAccount | null> {
  const rows = (await sql`
    SELECT id, riot_id, puuid, region FROM coachbuild.my_account WHERE active ORDER BY id LIMIT 1
  `) as unknown as AccountDbRow[];
  const row = rows[0];
  if (!row) return null;
  return toResolved(row);
}

/** Backwards-compatible alias. The old name read "the one account"; it now
 *  reads "the ACTIVE account", which is a different question with the same
 *  answer only while a single account is linked. Kept so nothing outside this
 *  module has to care, but new code should say what it means. */
export const getMyAccount = getActiveAccount;

/** The picker's feed. One query, LEFT JOINed against a per-puuid match count
 *  — grouped in SQL rather than in JS because unlike lib/mystats/aggregate.ts
 *  (which deliberately aggregates a few hundred rows in JS) this is a count
 *  over the WHOLE table for every account, and there is nothing to unit-test
 *  about it.
 *
 *  Ordered active-first, then most-recently-seen, then id — so the list reads
 *  in the order a user would expect to find things in it, deterministically. */
export async function listAccounts(sql: Sql): Promise<MyAccountSummary[]> {
  const rows = (await sql`
    SELECT a.id, a.riot_id, a.region, a.active, a.last_seen_at,
           a.rank_tier, a.rank_division, a.rank_lp, a.rank_wins, a.rank_losses,
           a.rank_checked_at, a.rank_attempted_at,
           COALESCE(m.games, 0)::int AS games,
           COALESCE(m.wins, 0)::int AS wins
    FROM coachbuild.my_account a
    LEFT JOIN (
      -- SOLO QUEUE ONLY (2026-07-30) — see MyAccountSummary.games. A LEFT JOIN,
      -- so an account whose stored games are ALL non-counted still yields a row
      -- with COALESCE(...,0) games rather than vanishing from the picker.
      -- wins is counted in the SAME pass and over the SAME predicate as games,
      -- deliberately. A win rate whose numerator and denominator come from two
      -- queries is two denominators waiting to drift, which this repo has
      -- shipped before (v0.73.1). One row, one filter, one truth.
      -- (No backticks in this comment on purpose: it lives inside a JS template
      -- literal, and a backtick here terminates the query mid-string.)
      SELECT puuid,
             count(*)::int AS games,
             count(*) FILTER (WHERE win)::int AS wins
      FROM coachbuild.my_matches
      WHERE queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
      GROUP BY puuid
    ) m ON m.puuid = a.puuid
    ORDER BY a.active DESC, a.last_seen_at DESC NULLS LAST, a.id
  `) as unknown as ({
    id: number;
    riot_id: string;
    region: string;
    active: boolean;
    last_seen_at: string | null;
    games: number;
    wins: number;
  } & RankRow)[];
  return rows.map((r) => {
    const parts = splitRiotId(r.riot_id);
    // rankFromRow, not an inline spread of the six columns: the unranked-vs-
    // unknown decision has exactly one implementation, and a second copy here
    // is what would silently miss the next fix to it (CLAUDE.md gotcha (dd)).
    const rank = rankFromRow(r);
    return {
      id: r.id,
      riotId: r.riot_id,
      gameName: parts?.gameName ?? r.riot_id,
      tagLine: parts?.tagLine ?? "",
      region: r.region,
      active: r.active,
      lastSeenAt: r.last_seen_at,
      games: r.games,
      wins: r.wins,
      ...rank,
    };
  });
}

/** Makes exactly one account active. ATOMICALLY — the two UPDATEs run in one
 *  Postgres transaction (2026-07-30), not as two independent round trips.
 *
 *  WHY THE TRANSACTION IS NOT BELT-AND-BRACES. Migration 0020's partial unique
 *  index `my_account_one_active_idx` already makes the bad direction
 *  (TWO active rows, which would make getActiveAccount's `LIMIT 1` pick a row
 *  arbitrarily) unrepresentable. What it cannot prevent is the other direction:
 *  a crash, a serverless timeout or a dropped connection landing BETWEEN the
 *  deactivate and the activate leaves ZERO active rows, and My Stats then renders
 *  its accountUnresolved empty state for an account the user has definitely
 *  linked — recoverable only by switching again. That fails in the safe
 *  direction, which is why it was never a P0, but two statements that must both
 *  land are a transaction, so they are one now.
 *
 *  ORDER STILL MATTERS INSIDE THE TRANSACTION: deactivate first. Statements in a
 *  Neon HTTP transaction execute sequentially, and the partial unique index is
 *  checked per statement, so activating before deactivating would violate it
 *  even though the transaction as a whole is fine.
 *
 *  NOT collapsed into a single `SET active = (id = $1)` UPDATE, which looks
 *  simpler and is a trap: one UPDATE touching both rows can be executed in
 *  either row order, and the partial unique index rejects the ordering that sets
 *  the new row active while the old one still is — a duplicate-key error that
 *  depends on the plan rather than on the data.
 *
 *  Returns null when `id` matches no row (a client asking for an account that
 *  isn't there gets a clean 404, never a silent no-op that looks like success). */
export async function setActiveAccount(sql: Sql, id: number): Promise<ResolvedMyAccount | null> {
  const exists = (await sql`
    SELECT id FROM coachbuild.my_account WHERE id = ${id}
  `) as unknown as { id: number }[];
  if (exists.length === 0) return null;

  await sql.transaction([
    sql`UPDATE coachbuild.my_account SET active = false WHERE active AND id <> ${id}`,
    sql`UPDATE coachbuild.my_account SET active = true WHERE id = ${id}`,
  ]);
  return getActiveAccount(sql);
}

/** Identity as reported by the League client (companion GET /me).
 *
 *  NOTE THE ABSENT FIELD. `GET /me` also returns a `puuid`, and v0.83.0 trusted
 *  it. It must not be trusted and is deliberately not carried here: the LCU's
 *  `/lol-summoner/v1/current-summoner` returns a **36-character local UUID**,
 *  while every Riot public endpoint requires the **78-character encrypted
 *  PUUID** and rejects the short form outright:
 *
 *    LCU        -> "45f94caa-fbf1-59df-8d21-60efd5516ae6"            (36)
 *    account-v1 -> 400 "Bad Request - Exception decrypting 45f94caa-..."
 *
 *  Measured 2026-07-30 against a real client (K1ayer#swift). This is the same
 *  failure class this repo already banked for op.gg's site-scoped player ids —
 *  identical "Exception decrypting" error — whose standing rule is: never trust
 *  an id from an external source, re-resolve from game_name + tag_line through
 *  account-v1. linkAccount does exactly that now. A field NAMED `puuid` is not
 *  evidence it is *the* puuid. */
export interface DetectedIdentity {
  gameName: string;
  tagLine: string;
}

/** NOTE what is deliberately ABSENT: a `switched` flag. Whether the active
 *  account actually CHANGED is computed in exactly one place — the route, which
 *  reads the active account before the mutation and compares ids, and which
 *  needs the same answer for `select` mode anyway. Computing it here as well
 *  would be a second copy of one fact, and a second copy is what silently misses
 *  the next fix (CLAUDE.md gotcha (dd)). */
export type LinkAccountResult =
  | { ok: true; account: ResolvedMyAccount; created: boolean }
  /** The puuid is new AND Riot would not tell us where it plays. Nothing is
   *  written — an account with an unknown region cannot be ingested for, so
   *  storing it would create a row that silently never gets any games. */
  | { ok: false; reason: "region-unresolved" }
  /** account-v1 by-riot-id returned 404 — this Riot ID genuinely does not
   *  exist. Distinct from `riot-unavailable` on purpose: "no such player" is
   *  final and the user should correct the name, while a transient failure is
   *  worth retrying. Collapsing the two would tell someone their real account
   *  does not exist because our key was rate-limited. */
  | { ok: false; reason: "account-not-found" }
  | { ok: false; reason: "riot-unavailable" };

/** Links (or re-links) a detected account and makes it active.
 *
 *  RIOT-CALL BUDGET, deliberately: an already-linked puuid costs ZERO Riot
 *  calls — its region is already stored, so re-detecting the same account on
 *  every page view (which is exactly what the client does) is free, and
 *  switching between two known accounts is free. Only a genuinely NEW puuid
 *  spends one paced account-v1 call. That matters because this key is shared
 *  with every other pipeline in the app (CLAUDE.md gotcha (d)).
 *
 *  `riot_id` is REFRESHED on every link, so a Riot name change follows the
 *  account instead of leaving a stale display tag — the puuid is what the
 *  match rows are keyed on (migration 0020), so a rename moves the label and
 *  touches no history. */
export async function linkAccount(sql: Sql, identity: DetectedIdentity): Promise<LinkAccountResult> {
  const riotId = formatRiotId(identity.gameName, identity.tagLine);

  // FAST PATH, and the reason the zero-call promise above still holds. The
  // client re-detects on every page view, so the overwhelmingly common case is
  // an account we already store. We can no longer answer that from the caller's
  // puuid (it is the LCU's, see DetectedIdentity), so the shortcut keys on
  // riot_id — the one identifier the client CAN supply that we also store.
  //
  // A renamed account misses this shortcut and falls through to the full
  // resolve, which is correct rather than merely tolerable: the resolve returns
  // the same puuid, and the INSERT's ON CONFLICT (puuid) then updates the
  // existing row's riot_id in place. A rename costs one call, once, and moves
  // the label without touching a single match row.
  const known = (await sql`
    SELECT puuid, region FROM coachbuild.my_account WHERE riot_id = ${riotId}
  `) as unknown as { puuid: string; region: string }[];

  let puuid: string;
  let region: string;
  let created: boolean;

  if (known.length > 0) {
    puuid = known[0].puuid;
    region = known[0].region;
    created = false;
  } else {
    try {
      // Step 1 — the REAL puuid. Never the caller's: theirs is a 36-char local
      // UUID that account-v1 rejects with "Exception decrypting".
      const account = await getAccountByRiotId(DEFAULT_ACCOUNT_ROUTING, identity.gameName, identity.tagLine);
      if (!account.puuid) return { ok: false, reason: "account-not-found" };
      puuid = account.puuid;
    } catch (err) {
      if (err instanceof RiotUnavailableError) return { ok: false, reason: "riot-unavailable" };
      // 404 is the only FINAL answer here — the Riot ID does not exist. 400 is a
      // malformed request, 403 a dead/suspended key, 429 our own rate limit:
      // all ours to fix and all retryable, so none of them may be reported as
      // "no such player".
      if (err instanceof RiotRequestError) {
        return { ok: false, reason: err.status === 404 ? "account-not-found" : "riot-unavailable" };
      }
      return { ok: false, reason: "riot-unavailable" };
    }

    try {
      // Step 2 — where they play. Uses the RESOLVED puuid; passing the LCU's
      // here is what shipped broken in v0.83.0.
      const dto = await getRegionByPuuid(DEFAULT_ACCOUNT_ROUTING, puuid);
      const mapped = routingForPlatform(dto.region);
      // An unmapped platform is a REFUSAL, not a fallback. Guessing "EUW"
      // here would point a Chinese/Vietnamese account's ingest at the wrong
      // cluster and report zero games as if that were the truth.
      if (!mapped) return { ok: false, reason: "region-unresolved" };
      region = mapped.server;
    } catch (err) {
      if (err instanceof RiotUnavailableError) return { ok: false, reason: "riot-unavailable" };
      if (err instanceof RiotRequestError) return { ok: false, reason: "region-unresolved" };
      return { ok: false, reason: "riot-unavailable" }; // transient transport failure -- retryable, so don't write a half-known row
    }
    created = true;
  }

  await sql`
    INSERT INTO coachbuild.my_account (riot_id, puuid, region, active, last_seen_at)
    VALUES (${riotId}, ${puuid}, ${region}, false, now())
    ON CONFLICT (puuid) DO UPDATE
      SET riot_id = EXCLUDED.riot_id, region = EXCLUDED.region, last_seen_at = now()
  `;

  const inserted = (await sql`
    SELECT id FROM coachbuild.my_account WHERE puuid = ${puuid}
  `) as unknown as { id: number }[];
  const id = inserted[0]?.id;
  if (id === undefined) return { ok: false, reason: "riot-unavailable" }; // write vanished -- treat as transient, never claim success

  const account = await setActiveAccount(sql, id);
  if (!account) return { ok: false, reason: "region-unresolved" };
  return { ok: true, account, created };
}

/** COLD START ONLY — resolves MY_RIOT_ID against account-v1 and links it.
 *
 *  BEHAVIOUR CHANGE WORTH KNOWING ABOUT (2026-07-29). The predecessor of this
 *  function was reachable through a helper named `ensureMyAccount`, whose doc
 *  comment claimed MY_RIOT_ID let a "wrong initial guess be corrected without
 *  a code change". It never could: the helper returned the existing row
 *  whenever there was one and only resolved when there was none, and the
 *  aggregation routes never called it at all. So once the id=1 row existed,
 *  changing MY_RIOT_ID changed nothing anywhere — the comment described an
 *  override that did not exist. The honest correction path is now the DETECTED
 *  one (linkAccount) plus the picker, and this function is only what bootstraps
 *  an empty table. The misleading claim is removed rather than reworded.
 *
 *  Unlike linkAccount this DOES trust MY_RIOT_REGION, because an env-configured
 *  Riot ID has an env-configured region beside it and there is no client to ask. */
export async function seedAccountFromEnv(sql: Sql): Promise<ResolvedMyAccount | null> {
  const routing = routingForServer(MY_RIOT_REGION);
  if (!routing) return null; // MY_RIOT_REGION misconfigured -- not a Riot-side failure, nothing to retry differently
  const parts = splitRiotId(MY_RIOT_ID);
  if (!parts) return null; // MY_RIOT_ID misconfigured (no '#')

  let dto;
  try {
    dto = await getAccountByRiotId(routing.regional, parts.gameName, parts.tagLine);
  } catch (err) {
    if (err instanceof RiotUnavailableError) throw err; // no key -- caller must distinguish this from "unresolved"
    return null; // definitive 404/400, or transient -- either way not resolved right now
  }

  const riotId = formatRiotId(dto.gameName, dto.tagLine);
  await sql`
    INSERT INTO coachbuild.my_account (riot_id, puuid, region, active)
    VALUES (${riotId}, ${dto.puuid}, ${MY_RIOT_REGION}, false)
    ON CONFLICT (puuid) DO UPDATE SET riot_id = EXCLUDED.riot_id
  `;
  const rows = (await sql`
    SELECT id FROM coachbuild.my_account WHERE puuid = ${dto.puuid}
  `) as unknown as { id: number }[];
  const id = rows[0]?.id;
  if (id === undefined) return null;
  return setActiveAccount(sql, id);
}

/** Active account if there is one, else a cold-start seed from env. Used by the
 *  ingest paths, which need SOMETHING to walk; read-only surfaces call
 *  getActiveAccount directly and show the empty state instead of resolving. */
export async function ensureActiveAccount(sql: Sql): Promise<ResolvedMyAccount | null> {
  const existing = await getActiveAccount(sql);
  if (existing) return existing;
  return seedAccountFromEnv(sql);
}

/** Deprecated alias for ensureActiveAccount — see seedAccountFromEnv's header
 *  for what this name used to imply and why that was wrong. */
export const ensureMyAccount = ensureActiveAccount;
