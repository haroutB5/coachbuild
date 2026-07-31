/**
 * THE SCOPING INVARIANT (migration 0020, v0.83).
 *
 * Every read of coachbuild.my_matches must be filtered by the ACTIVE account's
 * puuid. Before migration 0020 the table had no account column at all, so every
 * such query returned the whole table -- which meant linking a second account
 * would have merged two players into one win rate, one champion pool, one
 * adherence figure and one recent-games strip, with no visible symptom. A wrong
 * number that looks right is the worst failure this app can produce (HARD RULE 4).
 *
 * WHY THIS FILE IS STRUCTURAL RATHER THAN EXAMPLE-BASED. A test that checks
 * "summary returns 2 games for account A" only pins the queries that exist
 * today. The realistic regression is someone adding a FIFTH query to the summary
 * route six months from now and forgetting the filter -- and every existing
 * assertion would still pass. So these tests intercept every statement the route
 * issues and assert the property over ALL of them: if it touches my_matches, the
 * active puuid is among its bound values. Adding an unscoped query makes this
 * fail without anyone having to think to write a new test for it.
 *
 * The same invariant is asserted for the Draft recommender's personal-record
 * decoration, which is a real read of this table on a completely different page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetActiveAccount = vi.fn();
const mockListAccounts = vi.fn(async () => []);
vi.mock("@/lib/mystats/account", () => ({
  getActiveAccount: (...a: unknown[]) => mockGetActiveAccount(...a),
  getMyAccount: (...a: unknown[]) => mockGetActiveAccount(...a),
  listAccounts: (...a: unknown[]) => mockListAccounts(...(a as [])),
}));

vi.mock("@/lib/draft/patch", () => ({ resolveDraftPatchLabel: vi.fn(async () => "16.14") }));
// getLatestPatch (2026-07-31 audit P2, #4 — summary route's "waiting for
// patch data" classification) joins getChampionMeta here since this file's
// mock is a full module replacement, not a partial one.
vi.mock("@/lib/staticData", () => ({
  getChampionMeta: vi.fn(async () => null),
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 14, patchAdditions: 0, label: "16.14" })),
}));

import { GET as summaryGET } from "@/app/api/mystats/summary/route";
import { GET as matchupsGET } from "@/app/api/mystats/matchups/route";
import { computeDraftRecommend } from "@/lib/draft/recommend";

const ACTIVE_PUUID = "active-account-puuid";
const OTHER_PUUID = "other-account-puuid";

const ACTIVE = {
  id: 1,
  puuid: ACTIVE_PUUID,
  riotId: "MunsterHunter#EUW",
  gameName: "MunsterHunter",
  tagLine: "EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function req(url: string) {
  return { url, headers: { get: () => null } } as unknown as Parameters<typeof summaryGET>[0];
}

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

interface Statement {
  text: string;
  values: unknown[];
}

/** Records every statement, and serves plausible empty results so the route
 *  runs to completion. */
function recordingSql(collected: Statement[], serve?: (text: string, values: unknown[]) => unknown[] | undefined) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = sqlText(strings);
    collected.push({ text, values });
    const served = serve?.(text, values);
    return Promise.resolve(served ?? []);
  });
}

/** The invariant itself, applied to a recorded statement list. */
function assertEveryMyMatchesReadIsScoped(collected: Statement[], puuid: string) {
  const touching = collected.filter((s) => s.text.includes("coachbuild.my_matches"));
  // A route that reads nothing would trivially satisfy the property -- make sure
  // the test is actually exercising something.
  expect(touching.length).toBeGreaterThan(0);
  for (const stmt of touching) {
    expect(
      stmt.values.includes(puuid),
      `UNSCOPED my_matches query -- the active puuid is not among its bound values. ` +
        `This query returns EVERY linked account's rows:\n${stmt.text}`
    ).toBe(true);
    expect(stmt.text, `my_matches query is missing a puuid predicate:\n${stmt.text}`).toContain("puuid");
  }
}

describe("scoping invariant: GET /api/mystats/summary", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
    mockListAccounts.mockReset();
    mockListAccounts.mockResolvedValue([]);
  });

  it("EVERY my_matches query it issues is filtered by the active account's puuid", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(recordingSql(collected));
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    expect(res.status).toBe(200);
    assertEveryMyMatchesReadIsScoped(collected, ACTIVE_PUUID);
  });

  it("still scoped when role/championId/oppChampionId filters are also applied", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(recordingSql(collected));
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    await summaryGET(req("http://localhost/api/mystats/summary?role=2&championId=3&oppChampionId=7"));
    assertEveryMyMatchesReadIsScoped(collected, ACTIVE_PUUID);
  });

  it("reads my_matches ZERO times when no account is active -- the empty state, never an unscoped fallback", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(recordingSql(collected));
    mockGetActiveAccount.mockResolvedValue(null);

    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    const body = await res.json();
    expect(body.accountUnresolved).toBe(true);
    expect(collected.filter((s) => s.text.includes("coachbuild.my_matches"))).toHaveLength(0);
  });

  it("a second account's rows never reach the response, on ANY of the four figures", async () => {
    // One fake table, two accounts, same champion and split. Every query is
    // answered by filtering on whichever puuid the route actually bound -- so if
    // a query binds nothing, it gets nothing, and the assertions below catch the
    // shape of the mistake rather than only its magnitude.
    const rows = [
      { puuid: ACTIVE_PUUID, champion_id: 3, role: 2, opp_champion_id: 9, win: true, split: 2, kills: 5, deaths: 1, assists: 7, on_wpa_build: true, game_creation: "2026-05-01T00:00:00.000Z" },
      { puuid: ACTIVE_PUUID, champion_id: 3, role: 2, opp_champion_id: 35, win: true, split: 2, kills: 4, deaths: 2, assists: 3, on_wpa_build: true, game_creation: "2026-05-02T00:00:00.000Z" },
      // The other account: MORE games, ALL losses, ALL off-build. A leak would
      // move the win rate down and the adherence percentage down -- both
      // visibly, but plausibly.
      { puuid: OTHER_PUUID, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 0, deaths: 9, assists: 0, on_wpa_build: false, game_creation: "2026-06-01T00:00:00.000Z" },
      { puuid: OTHER_PUUID, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 0, deaths: 8, assists: 1, on_wpa_build: false, game_creation: "2026-06-02T00:00:00.000Z" },
      { puuid: OTHER_PUUID, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 1, deaths: 7, assists: 0, on_wpa_build: false, game_creation: "2026-06-03T00:00:00.000Z" },
    ];
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text, values) => {
        if (!text.includes("coachbuild.my_matches")) return [];
        const puuid = values.find((v) => typeof v === "string" && v.includes("account-puuid"));
        return rows.filter((r) => r.puuid === puuid);
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();

    // records / win rate
    const galio = body.records.find((r: { championId: number }) => r.championId === 3);
    expect(galio.games).toBe(2); // NOT 5
    expect(galio.winrate).toBe(1); // NOT 0.4
    // build adherence
    expect(body.buildAdherencePct).toBe(100); // NOT 40
    expect(body.nOnBuild).toBe(2);
    expect(body.nOffBuild).toBeNull(); // the other account's off-build games are not ours
    // recent games -- the other account's are NEWER, so an unscoped query would
    // put them at the top of the strip.
    expect(body.recentGames).toHaveLength(2);
    for (const g of body.recentGames) expect(g.deaths).toBeLessThan(5);
    expect(body.riotId).toBe("MunsterHunter#EUW");
    expect(body.accountId).toBe(1);
    assertEveryMyMatchesReadIsScoped(collected, ACTIVE_PUUID);
  });
});

describe("scoping invariant: GET /api/mystats/matchups", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
  });

  it("scoped in BOTH SQL branches (role given, and role omitted)", async () => {
    for (const url of [
      "http://localhost/api/mystats/matchups?championId=3&role=2",
      "http://localhost/api/mystats/matchups?championId=3",
    ]) {
      const collected: Statement[] = [];
      mockSql.mockImplementation(recordingSql(collected));
      mockGetActiveAccount.mockResolvedValue(ACTIVE);
      await matchupsGET(req(url));
      assertEveryMyMatchesReadIsScoped(collected, ACTIVE_PUUID);
    }
  });
});

describe("scoping invariant: Draft personal-record decoration", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
  });

  it("the Draft page's my_matches read is scoped too -- a real bleed site on a different page", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text) => {
        if (text.includes("GROUP BY patch")) return [{ patch: "16.14", champs: 150 }];
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return [{ champ_id: 1, winrate: 0.5, pickrate: null, banrate: null, total_games: 999999 }];
        }
        return undefined;
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    assertEveryMyMatchesReadIsScoped(collected, ACTIVE_PUUID);
  });

  it("with NO active account it reads my_matches zero times and still returns zeroed personal records", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text) => {
        if (text.includes("GROUP BY patch")) return [{ patch: "16.14", champs: 150 }];
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return [{ champ_id: 1, winrate: 0.5, pickrate: null, banrate: null, total_games: 999999 }];
        }
        return undefined;
      })
    );
    mockGetActiveAccount.mockResolvedValue(null);

    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(collected.filter((s) => s.text.includes("coachbuild.my_matches"))).toHaveLength(0);
    // The field is still present and still the "no games" shape -- the Draft page
    // must not crash or omit it just because no account is linked.
    expect(result.plays[0].personalOverall).toEqual({ games: 0, wins: 0 });
    expect(result.plays[0].personal).toBeNull();
  });
});
