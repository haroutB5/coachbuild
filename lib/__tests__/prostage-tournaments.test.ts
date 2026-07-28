/**
 * Tests for lib/prostage/tournaments.ts — resolution priority (override >
 * env seed > Tournaments lookup > empty-fallback) and the in-process cache.
 * cargoQueryWithRetry is mocked — no network/pacer involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prostage/cargo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prostage/cargo")>();
  return { ...actual, cargoQueryWithRetry: vi.fn() };
});

import { cargoQueryWithRetry } from "../prostage/cargo";
import {
  MAX_TOURNAMENTS,
  orderByStaleness,
  resolveActiveTournaments,
  __resetTournamentCacheForTests,
} from "../prostage/tournaments";

describe("resolveActiveTournaments", () => {
  beforeEach(() => {
    __resetTournamentCacheForTests();
    vi.mocked(cargoQueryWithRetry).mockReset();
    delete process.env.PROSTAGE_TOURNAMENT_SEED;
  });

  it("seedOverride short-circuits — no Cargo call", async () => {
    const pages = await resolveActiveTournaments({ seedOverride: ["MSI 2026"] });
    expect(pages).toEqual(["MSI 2026"]);
    expect(cargoQueryWithRetry).not.toHaveBeenCalled();
  });

  // Contract changed 2026-07-25: the env seed is a FALLBACK, not an override.
  // As an override it would pin the tournament list forever — set once to work
  // around an outage, and the app silently stops following new splits (LEC
  // Summer starting, Summer Playoffs, next season) with no failure signal.
  it("PROSTAGE_TOURNAMENT_SEED is IGNORED while live resolution works", async () => {
    process.env.PROSTAGE_TOURNAMENT_SEED = "STALE SEED";
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "LEC/2026 Season/Summer Season" },
    ] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC/2026 Season/Summer Season"]);
    expect(cargoQueryWithRetry).toHaveBeenCalled();
  });

  it("falls back to PROSTAGE_TOURNAMENT_SEED when the lookup THROWS", async () => {
    process.env.PROSTAGE_TOURNAMENT_SEED = "LEC 2026 Summer, LCK 2026 Summer";
    vi.mocked(cargoQueryWithRetry).mockRejectedValueOnce(new Error("ratelimited"));
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC 2026 Summer", "LCK 2026 Summer"]);
  });

  it("falls back to PROSTAGE_TOURNAMENT_SEED when the lookup returns 0 rows", async () => {
    process.env.PROSTAGE_TOURNAMENT_SEED = "LEC 2026 Summer";
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC 2026 Summer"]);
  });

  it("does NOT cache a seeded fallback — the next call retries live resolution", async () => {
    process.env.PROSTAGE_TOURNAMENT_SEED = "LEC 2026 Summer";
    vi.mocked(cargoQueryWithRetry).mockRejectedValueOnce(new Error("ratelimited"));
    expect(await resolveActiveTournaments()).toEqual(["LEC 2026 Summer"]);

    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "LEC/2026 Season/Summer Season" },
    ] as never);
    expect(await resolveActiveTournaments()).toEqual(["LEC/2026 Season/Summer Season"]);
  });

  it("queries Tournaments and returns resolved OverviewPages", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "LEC 2026 Summer" },
      { OverviewPage: "LCK 2026 Summer" },
    ] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC 2026 Summer", "LCK 2026 Summer"]);
    expect(cargoQueryWithRetry).toHaveBeenCalledTimes(1);
  });

  it("caps at MAX_TOURNAMENTS", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce(
      Array.from({ length: MAX_TOURNAMENTS + 5 }, (_, i) => ({ OverviewPage: `League ${i}` })) as never
    );
    const pages = await resolveActiveTournaments();
    expect(pages).toHaveLength(MAX_TOURNAMENTS);
  });

  it("falls back to [] (not a throw) when the Tournaments lookup errors", async () => {
    vi.mocked(cargoQueryWithRetry).mockRejectedValueOnce(new Error("ratelimited"));
    const log = vi.fn();
    const pages = await resolveActiveTournaments({ log });
    expect(pages).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("falls back to [] when the lookup returns 0 usable rows", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: undefined }] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual([]);
  });

  it("caches a successful resolution — a second call within TTL makes no new Cargo call", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    const first = await resolveActiveTournaments();
    const second = await resolveActiveTournaments();
    expect(first).toEqual(second);
    expect(cargoQueryWithRetry).toHaveBeenCalledTimes(1);
  });

  it("threads fastFailOnRatelimit through to cargoQueryWithRetry's retry options", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    await resolveActiveTournaments({ fastFailOnRatelimit: true });
    const [, retryOpts] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    expect(retryOpts).toEqual({ fastFail: true });
  });

  it("bounds the Cargo query's WHERE clause to DateStart <= today, excluding future/unplayed tournaments", async () => {
    // Regression for the 2026-07-10 live-verified bug: DateStart >= cutoff
    // alone also matches future tournaments (next Worlds, unstarted
    // playoffs), which — ordered DateStart DESC — crowd out every
    // tournament that actually has ScoreboardPlayers data right now.
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    const today = new Date().toISOString().slice(0, 10);
    expect(where).toContain(`DateStart <= "${today}"`);
    expect(where).toContain("DateStart >=");
  });

  it("excludes Academy pages from the Cargo query's WHERE clause", async () => {
    // Regression: "%LCK%" LIKE-matches "LCK Academy Series/..." pages, which
    // resolve but carry no ScoreboardPlayers data (live-verified 2026-07-10).
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    expect(where).toContain('OverviewPage NOT LIKE "%Academy%"');
  });

  it("excludes Classic Showmatch pages from the Cargo query's WHERE clause", async () => {
    // Regression for the 2026-07-28 live probe: "LEC/2026 Season/Summer
    // Season/Classic Showmatch" and its LCS/MSI twins matched the real
    // league prefixes and sorted by DateStart right beside the actual splits,
    // burning MAX_TOURNAMENTS slots on exhibition games played by retired
    // players on legacy patches.
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    expect(where).toContain('OverviewPage NOT LIKE "%Showmatch%"');
  });

  it("keeps MAX_TOURNAMENTS wide enough to reach every league in the live window", async () => {
    // The cap is a hard VISIBILITY ceiling, not just a rate budget — pages
    // past it are never ingested at all (resolveActiveTournaments slices
    // before orderByStaleness reorders). At the old value of 7, the live
    // 2026-07-28 list cut off right after "Esports World Cup 2026", leaving
    // LCK's only in-window tournament permanently unreachable.
    expect(MAX_TOURNAMENTS).toBeGreaterThanOrEqual(10);
  });

  it("anchors league codes as a PREFIX match, not a bare substring (excludes false positives)", async () => {
    // Regression for a live backfill run (2026-07-10): a bare "%LPL%"/"%LEC%"
    // substring matched "LPLOL/2026 Season/..." (a Brazilian league, not
    // LPL) and "Schneider Electric PowerShield Cup 2026" (via "El*ec*tric").
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);
    await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    for (const code of ["LEC", "LCK", "LPL", "LCS"]) {
      expect(where).toContain(`OverviewPage LIKE "${code}/%"`);
      expect(where).not.toContain(`OverviewPage LIKE "%${code}%"`);
    }
  });

  it("keeps event names (MSI/Worlds) as contains-matches, including the real MSI page name", async () => {
    // Live-verified 2026-07-10: the real 2026 MSI page is literally
    // "2026 Mid-Season Invitational" (League: "Mid-Season Invitational") —
    // it does NOT contain the substring "MSI" at all, so a bare "%MSI%"
    // pattern alone would silently never match the actual event page (only
    // sub-bracket pages like "LCK/2026 Season/Road to MSI" happen to).
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "2026 Mid-Season Invitational" },
    ] as never);
    const pages = await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    expect(where).toContain('OverviewPage LIKE "%Mid-Season Invitational%"');
    expect(where).toContain('OverviewPage LIKE "%MSI%"');
    expect(where).toContain('OverviewPage LIKE "%World Championship%"');
    expect(where).toContain('OverviewPage LIKE "%Worlds%"');
    expect(pages).toEqual(["2026 Mid-Season Invitational"]);
  });

  it("resolves the real 2026 Esports World Cup page (regression for the 2026-07-19 missing-EWC bug report)", async () => {
    // Bug report: Pro Play stopped at Jul 12 (MSI), missing the ongoing
    // Esports World Cup 2026 (Jul 15-19). Root cause: none of the prior
    // patterns matched "Esports World Cup 2026" — it doesn't contain
    // "Worlds"/"World Championship" (it's a third-party event, not a
    // Riot-run international).
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "Esports World Cup 2026" },
    ] as never);
    const pages = await resolveActiveTournaments();
    const [queryArgs] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    const where = (queryArgs as { where: string }).where;
    expect(where).toContain('OverviewPage LIKE "%Esports World Cup%"');
    expect(pages).toEqual(["Esports World Cup 2026"]);
  });
});

describe("orderByStaleness", () => {
  it("returns [] immediately for an empty input, without querying", async () => {
    const sql = vi.fn();
    const result = await orderByStaleness(sql as never, []);
    expect(result).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it("orders stalest-first — never-ingested (epoch) pages float to the front", async () => {
    // Fixes P1-1: a cursorless cron always calls with cursor=0, so whichever
    // tournament sorts first here is the ONLY one that cron will ever touch
    // without this ordering (see the doc comment on orderByStaleness).
    // orderByStaleness trusts the query's own `ORDER BY last_ingested ASC`
    // and just maps rows through — so the mock returns them PRE-SORTED, the
    // same shape Postgres would (this is testing the mapping, not re-testing
    // Postgres's own ORDER BY).
    const sql = vi.fn().mockResolvedValue([
      { overview_page: "Never Ingested", last_ingested: "1970-01-01T00:00:00.000Z" },
      { overview_page: "Ingested Yesterday", last_ingested: "2026-07-08T00:00:00.000Z" },
      { overview_page: "Ingested Today", last_ingested: "2026-07-09T00:00:00.000Z" },
    ]);
    const result = await orderByStaleness(sql as never, [
      "Ingested Today",
      "Never Ingested",
      "Ingested Yesterday",
    ]);
    expect(result).toEqual(["Never Ingested", "Ingested Yesterday", "Ingested Today"]);
  });

  it("queries with the given page list (unnest-driven staleness lookup)", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    await orderByStaleness(sql as never, ["A", "B"]);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("queries coachbuild.prostage_ingest_attempts (last ATTEMPTED), not prostage_matches (last actually wrote a row)", async () => {
    // P2 fix (2026-07-17): the old ingested_at proxy never advanced on a
    // zero-new-rows pass, permanently pinning a finished tournament as
    // "stalest." The new stamp (migration 0008) advances on every attempt.
    const sql = vi.fn().mockResolvedValue([]);
    await orderByStaleness(sql as never, ["A"]);
    const strings = sql.mock.calls[0][0] as TemplateStringsArray;
    const queryText = strings.join("?");
    expect(queryText).toContain("prostage_ingest_attempts");
    expect(queryText).not.toContain("prostage_matches");
  });

  it("regression: a finished tournament that keeps getting ATTEMPTED (zero new rows every pass) no longer wins cursor=0 forever — it sorts AFTER a never-attempted page", async () => {
    // Simulates the pin bug this migration closes: "Finished Bracket" has an
    // old real ingest but a FRESH attempted_at (every cron pass upserts it,
    // even though ON CONFLICT DO NOTHING means no new prostage_matches rows
    // ever land for it) — it must lose staleness priority to a tournament
    // that has genuinely never been attempted (epoch).
    const sql = vi.fn().mockResolvedValue([
      { overview_page: "Never Attempted", last_ingested: "1970-01-01T00:00:00.000Z" },
      { overview_page: "Finished Bracket", last_ingested: "2026-07-17T07:00:00.000Z" },
    ]);
    const result = await orderByStaleness(sql as never, ["Finished Bracket", "Never Attempted"]);
    expect(result).toEqual(["Never Attempted", "Finished Bracket"]);
  });
});
