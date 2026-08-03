// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/rank.ts — ranked tier / division / LP for a linked account.
//
// THREE RULES THIS MODULE ENFORCES, in order of how badly getting them wrong
// would show:
//
//  1. UNRANKED AND UNKNOWN ARE DIFFERENT STATES. "This account has no ranked
//     standing" and "we could not find out" both produce a null tier, and a UI
//     that cannot tell them apart renders a blank badge in both cases — the
//     confidently-wrong-blank the whole feature brief singles out. The
//     distinction is carried by `rankUnknown`, and it is derived from ONE fact:
//     whether a successful read has ever happened (my_account.rank_checked_at).
//     It is never inferred from the tier being null.
//
//  2. SOLO QUEUE ONLY. league-v4 returns an ARRAY spanning every ranked queue.
//     K1ayer#swift — one of the two accounts already in this database — really
//     does return two entries, solo AND flex, so "take the first one" would put
//     a GOLD III flex rank on a badge the design labels solo queue for that
//     account and a correct one for the other. Selection is by queueType,
//     always.
//
//  3. THE RIOT KEY IS SHARED AND GOING OVER THE CAP SUSPENDS THE WHOLE APP
//     (CLAUDE.md gotcha (d)). So: the rank is PERSISTED (migration 0022) and
//     refreshed on a TTL, the TTL is checked against a DATABASE timestamp
//     rather than an in-process cache (a per-lambda-instance cache means N
//     cold instances make N calls for the same fact), and a single request
//     refreshes AT MOST RANK_REFRESH_MAX_PER_REQUEST accounts. There is no code
//     path here that fans out across every linked account.
//
// A FAILED REFRESH KEEPS THE LAST GOOD READING. The two timestamps are split
// (rank_checked_at = last success, rank_attempted_at = last attempt) precisely
// so a transient Riot failure backs off the call WITHOUT blanking a badge that
// was correct five minutes ago. The staleness is disclosed rather than hidden:
// `rankCheckedAt` travels with the values.
// ─────────────────────────────────────────────────────────────────────────────

import { getLeagueEntriesByPuuid, RiotRequestError } from "@/lib/pro/riot";
import { RiotUnavailableError } from "@/lib/pro/errors";
import type { getSql } from "@/lib/pro/db";
import type { RiotLeagueEntryDto } from "@/lib/pro/types";

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** The queueType this feature means by "rank". Flex is deliberately not
 *  surfaced anywhere; if it ever is, it gets its own fields and its own label,
 *  never these. */
export const SOLO_QUEUE_TYPE = "RANKED_SOLO_5x5";

/** How long a stored rank is served before a refresh is attempted.
 *
 *  30 minutes, NOT the 6h that lib/coachless.ts uses for its build data. Those
 *  two facts age at completely different rates: a champion's aggregate WPA
 *  barely moves within a patch, whereas LP changes every single ranked game, so
 *  a 6-hour-old LP is routinely a wrong number displayed as a current one.
 *
 *  The cost of the shorter window is negligible and bounded, which is what makes
 *  the trade one-sided: because the TTL is enforced against a DB column rather
 *  than per-process memory, the ceiling is one Riot call per account per 30
 *  minutes for the entire deployment — ~48/day for two accounts against a key
 *  budget of 100 requests per 2 MINUTES. It is emphatically not a call per page
 *  view, which is the constraint that actually mattered.
 *
 *  Exported so it is one line to change and so a test can pin the arithmetic. */
export const RANK_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on Riot calls one request may spend refreshing ranks.
 *
 *  The ACTIVE account is always first in line (it is the one the hero renders).
 *  The one remaining slot goes to the stalest OTHER account, which is what lets
 *  a second linked account's card fill in at all without ever fanning out: with
 *  N accounts, at most N page views warm them all, and steady state is ZERO
 *  calls because every account is then inside its own TTL.
 *
 *  Do not raise this to "just refresh them all". That is the fan-out the brief
 *  forbids, and with a handful of accounts it turns a page view into a burst
 *  against a key that suspends app-wide when it trips. */
export const RANK_REFRESH_MAX_PER_REQUEST = 2;

/** The public, browser-facing rank shape. Mirrored verbatim onto every entry of
 *  the summary response's `accounts[]` and onto the response top level for the
 *  active account — see HANDOFF-engy.md §1a for the contract text fronty
 *  builds against. */
export interface AccountRank {
  /** "IRON".."CHALLENGER". null = unranked (when rankUnknown is false) or
   *  meaningless (when rankUnknown is true). */
  tier: string | null;
  /** "I".."IV". Riot sends "I" for the three apex tiers, where it means
   *  nothing — forwarded verbatim; the UI declines to render it there. */
  division: string | null;
  lp: number | null;
  rankWins: number | null;
  rankLosses: number | null;
  /** THE unranked-vs-unknown discriminator. true = we have never successfully
   *  read this account's rank, so every field above is null and means NOTHING.
   *  false = the fields above are the truth, INCLUDING a null tier, which then
   *  means genuinely unranked. */
  rankUnknown: boolean;
  /** ISO of the last SUCCESSFUL read, null when there has never been one.
   *  Non-null with an old timestamp is the honest signal that a refresh is
   *  failing while the last good reading is still being served. */
  rankCheckedAt: string | null;
}

/** The state of an account that has never been read. Every field null, and
 *  rankUnknown true — never a fabricated "UNRANKED". */
export const UNKNOWN_RANK: AccountRank = {
  tier: null,
  division: null,
  lp: null,
  rankWins: null,
  rankLosses: null,
  rankUnknown: true,
  rankCheckedAt: null,
};

/** The six stored columns, as read from my_account. */
export interface RankRow {
  rank_tier: string | null;
  rank_division: string | null;
  rank_lp: number | null;
  rank_wins: number | null;
  rank_losses: number | null;
  rank_checked_at: string | Date | null;
  rank_attempted_at?: string | Date | null;
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** Stored columns -> the public shape. THE ONLY place rankUnknown is decided,
 *  and it is decided on rank_checked_at alone. Note what this deliberately does
 *  NOT do: it does not treat a null tier as unknown (that is unranked), and it
 *  does not treat a present tier as known-good without a checked_at (a row in
 *  that state would be corrupt, and reporting it as authoritative would hide
 *  the corruption). */
export function rankFromRow(row: RankRow | null | undefined): AccountRank {
  const checkedAt = toIso(row?.rank_checked_at ?? null);
  if (!row || checkedAt === null) return UNKNOWN_RANK;
  return {
    tier: row.rank_tier ?? null,
    division: row.rank_division ?? null,
    lp: row.rank_lp ?? null,
    rankWins: row.rank_wins ?? null,
    rankLosses: row.rank_losses ?? null,
    rankUnknown: false,
    rankCheckedAt: checkedAt,
  };
}

/** Picks the solo-queue entry out of league-v4's multi-queue array.
 *
 *  undefined (not null, not a throw) when there is none — which is the NORMAL
 *  answer for an unranked account and for an account that only plays flex. The
 *  caller turns that into a successful read of "no solo rank", never into an
 *  error. */
export function soloQueueEntry(
  entries: RiotLeagueEntryDto[] | null | undefined
): RiotLeagueEntryDto | undefined {
  if (!Array.isArray(entries)) return undefined;
  return entries.find((e) => e?.queueType === SOLO_QUEUE_TYPE);
}

/** TTL gate. Refresh when we have never attempted, or when the last ATTEMPT
 *  (not the last success) is older than the TTL — gating on success would
 *  retry a persistently failing account on every single request. */
export function rankIsStale(
  attemptedAt: string | Date | null | undefined,
  now: number,
  ttlMs: number = RANK_TTL_MS
): boolean {
  if (attemptedAt === null || attemptedAt === undefined) return true;
  const t = attemptedAt instanceof Date ? attemptedAt.getTime() : Date.parse(attemptedAt);
  if (Number.isNaN(t)) return true; // unparseable timestamp -> treat as never attempted rather than never refresh again
  return now - t >= ttlMs;
}

/** One account's identity as this module needs it. */
export interface RankTarget {
  id: number;
  puuid: string;
  /** Riot PLATFORM host ("euw1"). league-v4 is platform-routed — passing a
   *  regional cluster here 404s. */
  platform: string;
}

export type RankFetchOutcome =
  | { ok: true; entry: RiotLeagueEntryDto | undefined }
  | { ok: false; reason: string };

/** Injectable for tests, following the deps-param convention every external-feed
 *  module in this repo uses (see CLAUDE.md's test conventions). */
export interface RankDeps {
  fetchEntries: (platform: string, puuid: string) => Promise<RiotLeagueEntryDto[]>;
  now: () => number;
}

const DEFAULT_DEPS: RankDeps = {
  fetchEntries: getLeagueEntriesByPuuid,
  now: () => Date.now(),
};

/** Fetches one account's solo-queue standing. Never throws for a Riot-side
 *  problem — a rank we could not read is a display state, not a reason to fail
 *  the whole My Stats response. */
export async function fetchSoloRank(
  target: RankTarget,
  deps: Partial<RankDeps> = {}
): Promise<RankFetchOutcome> {
  const { fetchEntries } = { ...DEFAULT_DEPS, ...deps };
  try {
    const entries = await fetchEntries(target.platform, target.puuid);
    // An EMPTY array is a successful read meaning "unranked", not a failure.
    // Collapsing the two here is what would make a brand-new account's badge
    // indistinguishable from a rate-limited one.
    return { ok: true, entry: soloQueueEntry(entries) };
  } catch (err) {
    if (err instanceof RiotUnavailableError) return { ok: false, reason: "no-riot-key" };
    if (err instanceof RiotRequestError) return { ok: false, reason: `riot-${err.status}` };
    return { ok: false, reason: "riot-unavailable" };
  }
}

/** Persists one fetch outcome.
 *
 *  SUCCESS writes all six value columns TOGETHER (all null for an unranked
 *  account) and stamps both timestamps — a partial write is what would leave a
 *  tier from one read beside an LP from another.
 *
 *  FAILURE writes ONLY rank_attempted_at. The previous reading is left exactly
 *  as it was, so a transient failure costs freshness (visible via
 *  rankCheckedAt) rather than the whole badge. */
export async function persistRank(
  sql: Sql,
  accountId: number,
  outcome: RankFetchOutcome
): Promise<void> {
  if (!outcome.ok) {
    await sql`
      UPDATE coachbuild.my_account SET rank_attempted_at = now() WHERE id = ${accountId}
    `;
    return;
  }
  const e = outcome.entry;
  await sql`
    UPDATE coachbuild.my_account
    SET rank_tier = ${e?.tier ?? null},
        rank_division = ${e?.rank ?? null},
        rank_lp = ${e?.leaguePoints ?? null},
        rank_wins = ${e?.wins ?? null},
        rank_losses = ${e?.losses ?? null},
        rank_checked_at = now(),
        rank_attempted_at = now()
    WHERE id = ${accountId}
  `;
}

/** Refreshes whatever is stale, spending AT MOST RANK_REFRESH_MAX_PER_REQUEST
 *  Riot calls, and returns how many it spent.
 *
 *  BEST-EFFORT BY CONSTRUCTION. Every failure mode — no key, a 429, an
 *  unmapped region, a dead connection — resolves to "we did not refresh that
 *  one", never to a thrown error, because a rank we could not read must not be
 *  able to fail the entire My Stats response. The caller reads the stored
 *  values afterwards either way.
 *
 *  Calls are SEQUENTIAL, never Promise.all: lib/pro/pacer.ts serialises Riot
 *  calls within a process anyway (CLAUDE.md gotcha (d)), and firing them in
 *  parallel would only queue them behind each other while making the failure
 *  handling harder to follow.
 *
 *  `platformFor` is supplied by the caller because this module has no opinion
 *  on how a stored region string becomes a Riot host — that mapping lives in
 *  lib/pro/regionMap.ts, and an account whose region does not map is SKIPPED
 *  rather than guessed at (guessing would point the call at the wrong shard
 *  and store another player's rank). */
export async function refreshStaleRanks(
  sql: Sql,
  accounts: { id: number; puuid: string; region: string; active: boolean; rank_attempted_at?: string | Date | null }[],
  platformFor: (region: string) => string | null,
  deps: Partial<RankDeps> = {}
): Promise<number> {
  const now = (deps.now ?? DEFAULT_DEPS.now)();
  const targets = selectRankRefreshTargets(accounts, now);
  let spent = 0;
  for (const a of targets) {
    const platform = platformFor(a.region);
    if (!platform) continue; // unmapped region -> skip, never guess a shard
    try {
      const outcome = await fetchSoloRank({ id: a.id, puuid: a.puuid, platform }, deps);
      await persistRank(sql, a.id, outcome);
      spent += 1;
    } catch {
      // A DB write failure here must not take the response down either. The
      // stored rank simply stays as it was and the TTL retries next request.
    }
  }
  return spent;
}

/** Chooses which accounts a single request may refresh, and in what order.
 *
 *  PURE — the whole point, so the "never fans out" and "spends nothing when
 *  everything is warm" promises are unit-testable without a database or a
 *  network. The route does the I/O around it.
 *
 *  Ordering: the ACTIVE account first (it backs the hero), then the stalest
 *  other account. Capped at RANK_REFRESH_MAX_PER_REQUEST regardless of how many
 *  accounts are linked. */
export function selectRankRefreshTargets<
  T extends { id: number; active: boolean; rank_attempted_at?: string | Date | null }
>(accounts: T[], now: number, ttlMs: number = RANK_TTL_MS, max: number = RANK_REFRESH_MAX_PER_REQUEST): T[] {
  const stale = accounts.filter((a) => rankIsStale(a.rank_attempted_at, now, ttlMs));
  const attemptAge = (a: T): number => {
    const raw = a.rank_attempted_at;
    if (raw === null || raw === undefined) return Number.POSITIVE_INFINITY; // never attempted -> stalest
    const t = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now - t;
  };
  return stale
    .slice()
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return attemptAge(b) - attemptAge(a) || a.id - b.id;
    })
    .slice(0, Math.max(0, max));
}
