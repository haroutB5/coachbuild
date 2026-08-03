import { describe, it, expect } from "vitest";
import {
  RANK_TTL_MS,
  RANK_REFRESH_MAX_PER_REQUEST,
  SOLO_QUEUE_TYPE,
  UNKNOWN_RANK,
  fetchSoloRank,
  rankFromRow,
  rankIsStale,
  selectRankRefreshTargets,
  soloQueueEntry,
} from "@/lib/mystats/rank";
import { RiotRequestError } from "@/lib/pro/riot";
import { RiotUnavailableError } from "@/lib/pro/errors";
import type { RiotLeagueEntryDto } from "@/lib/pro/types";

const SOLO: RiotLeagueEntryDto = {
  queueType: "RANKED_SOLO_5x5",
  tier: "PLATINUM",
  rank: "IV",
  leaguePoints: 89,
  wins: 65,
  losses: 66,
};
const FLEX: RiotLeagueEntryDto = {
  queueType: "RANKED_FLEX_SR",
  tier: "GOLD",
  rank: "III",
  leaguePoints: 18,
  wins: 8,
  losses: 18,
};

// ─────────────────────────────────────────────────────────────────────────────
// UNRANKED vs COULD-NOT-FETCH. Both produce a null tier; only one of them may
// render an "Unranked" badge. Getting this wrong is the confidently-wrong-blank
// the feature brief calls out by name.
// ─────────────────────────────────────────────────────────────────────────────
describe("unranked is distinguishable from fetch-failed", () => {
  it("a row that has never been successfully read is UNKNOWN", () => {
    const rank = rankFromRow({
      rank_tier: null,
      rank_division: null,
      rank_lp: null,
      rank_wins: null,
      rank_losses: null,
      rank_checked_at: null,
    });
    expect(rank.rankUnknown).toBe(true);
    expect(rank.tier).toBeNull();
    expect(rank.rankCheckedAt).toBeNull();
    expect(rank).toEqual(UNKNOWN_RANK);
  });

  it("a row read successfully with no ranked standing is UNRANKED, not unknown", () => {
    const rank = rankFromRow({
      rank_tier: null,
      rank_division: null,
      rank_lp: null,
      rank_wins: null,
      rank_losses: null,
      rank_checked_at: "2026-07-30T12:00:00.000Z",
    });
    expect(rank.rankUnknown).toBe(false); // <- the whole distinction
    expect(rank.tier).toBeNull();
    expect(rank.rankCheckedAt).toBe("2026-07-30T12:00:00.000Z");
  });

  it("the two states are not equal despite both having a null tier", () => {
    const unknown = rankFromRow(null);
    const unranked = rankFromRow({
      rank_tier: null,
      rank_division: null,
      rank_lp: null,
      rank_wins: null,
      rank_losses: null,
      rank_checked_at: "2026-07-30T12:00:00.000Z",
    });
    expect(unknown.tier).toBe(unranked.tier);
    expect(unknown.rankUnknown).not.toBe(unranked.rankUnknown);
  });

  it("a ranked row carries every value through", () => {
    const rank = rankFromRow({
      rank_tier: "PLATINUM",
      rank_division: "IV",
      rank_lp: 89,
      rank_wins: 65,
      rank_losses: 66,
      rank_checked_at: "2026-07-30T12:00:00.000Z",
    });
    expect(rank).toEqual({
      tier: "PLATINUM",
      division: "IV",
      lp: 89,
      rankWins: 65,
      rankLosses: 66,
      rankUnknown: false,
      rankCheckedAt: "2026-07-30T12:00:00.000Z",
    });
  });

  it("a missing row is UNKNOWN, never a fabricated unranked", () => {
    expect(rankFromRow(undefined).rankUnknown).toBe(true);
    expect(rankFromRow(null).rankUnknown).toBe(true);
  });

  it("accepts a Date from the driver as well as an ISO string", () => {
    const rank = rankFromRow({
      rank_tier: "IRON",
      rank_division: "IV",
      rank_lp: 0,
      rank_wins: 0,
      rank_losses: 1,
      rank_checked_at: new Date("2026-07-30T12:00:00.000Z"),
    });
    expect(rank.rankUnknown).toBe(false);
    expect(rank.rankCheckedAt).toBe("2026-07-30T12:00:00.000Z");
  });

  it("a Riot failure is reported as a failure, never as unranked", async () => {
    const out = await fetchSoloRank(
      { id: 1, puuid: "p", platform: "euw1" },
      {
        fetchEntries: async () => {
          throw new RiotRequestError("u", 429, "Too Many Requests");
        },
      }
    );
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("riot-429");
  });

  it("a missing key is reported as a failure too", async () => {
    const out = await fetchSoloRank(
      { id: 1, puuid: "p", platform: "euw1" },
      {
        fetchEntries: async () => {
          throw new RiotUnavailableError();
        },
      }
    );
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("no-riot-key");
  });

  it("an EMPTY array is a SUCCESSFUL read meaning unranked", async () => {
    const out = await fetchSoloRank(
      { id: 1, puuid: "p", platform: "euw1" },
      { fetchEntries: async () => [] }
    );
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.entry).toBeUndefined();
  });
});

describe("solo queue only", () => {
  it("picks solo out of a multi-queue response", () => {
    // K1ayer#swift's REAL live response shape (probed 2026-07-30): solo AND
    // flex. Index-based selection would put a GOLD III flex rank on a badge
    // labelled solo queue for this account.
    expect(soloQueueEntry([SOLO, FLEX])).toBe(SOLO);
    expect(soloQueueEntry([FLEX, SOLO])).toBe(SOLO);
  });

  it("returns undefined for a flex-only account rather than falling back to flex", () => {
    expect(soloQueueEntry([FLEX])).toBeUndefined();
  });

  it("handles an empty or malformed payload without throwing", () => {
    expect(soloQueueEntry([])).toBeUndefined();
    expect(soloQueueEntry(null)).toBeUndefined();
    expect(soloQueueEntry(undefined)).toBeUndefined();
  });

  it("pins the queueType constant", () => {
    expect(SOLO_QUEUE_TYPE).toBe("RANKED_SOLO_5x5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CACHE DOES NOT RE-CALL. The Riot key is shared and going over the cap
// suspends the whole app, so "must not add a call per page view" is the hard
// constraint here.
// ─────────────────────────────────────────────────────────────────────────────
describe("TTL gating: a warm rank costs zero Riot calls", () => {
  const NOW = Date.parse("2026-07-30T12:00:00.000Z");

  it("a rank read one minute ago is not stale", () => {
    expect(rankIsStale(new Date(NOW - 60_000).toISOString(), NOW)).toBe(false);
  });

  it("a rank read longer ago than the TTL is stale", () => {
    expect(rankIsStale(new Date(NOW - RANK_TTL_MS - 1).toISOString(), NOW)).toBe(true);
  });

  it("exactly at the TTL boundary it refreshes", () => {
    expect(rankIsStale(new Date(NOW - RANK_TTL_MS).toISOString(), NOW)).toBe(true);
    expect(rankIsStale(new Date(NOW - RANK_TTL_MS + 1).toISOString(), NOW)).toBe(false);
  });

  it("never attempted is always stale", () => {
    expect(rankIsStale(null, NOW)).toBe(true);
    expect(rankIsStale(undefined, NOW)).toBe(true);
  });

  it("an unparseable timestamp refreshes rather than never refreshing again", () => {
    expect(rankIsStale("not-a-date", NOW)).toBe(true);
  });

  it("selects NOTHING when every account is warm — the steady state", () => {
    const warm = new Date(NOW - 60_000).toISOString();
    const accounts = [
      { id: 1, active: true, rank_attempted_at: warm },
      { id: 6, active: false, rank_attempted_at: warm },
    ];
    expect(selectRankRefreshTargets(accounts, NOW)).toEqual([]);
  });

  it("gates on the ATTEMPT, so a persistently failing account is not retried every request", () => {
    // rank_attempted_at is bumped on failure while rank_checked_at is not, so
    // a failing account backs off exactly like a succeeding one.
    const justFailed = new Date(NOW - 60_000).toISOString();
    expect(rankIsStale(justFailed, NOW)).toBe(false);
  });

  it("puts the ACTIVE account first", () => {
    const accounts = [
      { id: 6, active: false, rank_attempted_at: null },
      { id: 1, active: true, rank_attempted_at: null },
    ];
    expect(selectRankRefreshTargets(accounts, NOW).map((a) => a.id)).toEqual([1, 6]);
  });

  it("NEVER fans out across every linked account", () => {
    const accounts = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      active: i === 0,
      rank_attempted_at: null,
    }));
    const targets = selectRankRefreshTargets(accounts, NOW);
    expect(targets.length).toBe(RANK_REFRESH_MAX_PER_REQUEST);
    expect(RANK_REFRESH_MAX_PER_REQUEST).toBeLessThanOrEqual(2);
    expect(targets[0].active).toBe(true);
  });

  it("gives the one spare slot to the STALEST other account", () => {
    const accounts = [
      { id: 1, active: true, rank_attempted_at: null },
      { id: 2, active: false, rank_attempted_at: new Date(NOW - RANK_TTL_MS * 2).toISOString() },
      { id: 3, active: false, rank_attempted_at: new Date(NOW - RANK_TTL_MS * 9).toISOString() },
    ];
    expect(selectRankRefreshTargets(accounts, NOW).map((a) => a.id)).toEqual([1, 3]);
  });

  it("breaks equally stale refresh-target ties by account id", () => {
    const accounts = [
      { id: 9, active: false, rank_attempted_at: null },
      { id: 3, active: false, rank_attempted_at: null },
    ];
    expect(selectRankRefreshTargets(accounts, NOW, undefined, 1).map((a) => a.id)).toEqual([3]);
  });

  it("skips a warm active account but still refreshes a stale inactive one", () => {
    const accounts = [
      { id: 1, active: true, rank_attempted_at: new Date(NOW - 60_000).toISOString() },
      { id: 6, active: false, rank_attempted_at: null },
    ];
    expect(selectRankRefreshTargets(accounts, NOW).map((a) => a.id)).toEqual([6]);
  });

  it("the TTL is short enough to be honest about LP and long enough to be cheap", () => {
    // 30 min => at most 48 calls/day/account against a 100-per-2-MINUTES budget.
    expect(RANK_TTL_MS).toBe(30 * 60 * 1000);
    const callsPerDayPerAccount = (24 * 60 * 60 * 1000) / RANK_TTL_MS;
    expect(callsPerDayPerAccount).toBeLessThanOrEqual(48);
  });
});
