/**
 * THE QUEUE INVARIANT (2026-07-30).
 *
 * Every read of coachbuild.my_matches that produces a STAT must be filtered to
 * COUNTED_QUEUE_IDS (lib/mystats/queues.ts) — ranked solo/duo only.
 *
 * WHY THIS EXISTS AT ALL. lib/mystats/ingest.ts deliberately stores every queue
 * the account played, and its header asserted for months that "filtering by
 * queue happens at READ time". Nothing filtered by queue at any read path. The
 * intent was written down and the enforcement was never built, so flex, normal
 * draft, quickplay and swiftplay games were being averaged into the season game
 * count, the win rate, the champion pool, the build-adherence figure, the CS/min
 * headline, the account-card game count and the 20-game Match Performance chart.
 * Measured on the live DB before the fix: 45 of one account's 186 stored games.
 * A wrong number that looks right is the worst failure this app can produce
 * (HARD RULE 4).
 *
 * WHY THIS FILE IS STRUCTURAL RATHER THAN EXAMPLE-BASED — the same reasoning as
 * its sibling mystats-scoping-invariant.test.ts, and deliberately the same
 * harness. A test asserting "summary returns 141 games" pins only the queries
 * that exist today; the realistic regression is a SEVENTH query added months
 * from now without the predicate, and every example-based assertion would still
 * pass. So these tests intercept every statement each route issues and assert
 * the property over ALL of them.
 *
 * The behavioural half is here too (a mixed-queue fake table, asserting flex
 * rows reach no figure), plus the consequence the fix creates: an account whose
 * stored games are ALL non-counted must render the empty state — nulls and
 * zeros — never NaN% from a zero denominator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

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
import { COUNTED_QUEUE_IDS, RANKED_SOLO_QUEUE_ID, isCountedQueue } from "@/lib/mystats/queues";

const ACTIVE_PUUID = "active-account-puuid";

const ACTIVE = {
  id: 1,
  puuid: ACTIVE_PUUID,
  riotId: "K1ayer#swift",
  gameName: "K1ayer",
  tagLine: "swift",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

/** Queues that exist in the live table and must NOT count. Real ids, measured
 *  2026-07-30: flex, normal draft, swiftplay, quickplay — plus ARAM, which the
 *  ingest also stores. */
const FLEX = 440;
const NORMAL_DRAFT = 400;
const SWIFTPLAY = 2450;
const QUICKPLAY = 480;
const ARAM = 450;

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

function recordingSql(collected: Statement[], serve?: (text: string, values: unknown[]) => unknown[] | undefined) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = sqlText(strings);
    collected.push({ text, values });
    const served = serve?.(text, values);
    return Promise.resolve(served ?? []);
  });
}

/** The invariant itself. Asserts the BOUND ARRAY, not the literal 420 — the
 *  whole point of lib/mystats/queues.ts is that no read inlines the number, so a
 *  query that hardcodes `queue_id = 420` and drifts from the constant later is a
 *  failure here, not a pass. */
function assertEveryMyMatchesReadIsQueueFiltered(collected: Statement[]) {
  const touching = collected.filter((s) => s.text.includes("coachbuild.my_matches"));
  // A route that reads nothing would satisfy the property trivially.
  expect(touching.length).toBeGreaterThan(0);
  for (const stmt of touching) {
    expect(stmt.text, `my_matches query has no queue_id predicate:\n${stmt.text}`).toContain("queue_id");
    const bound = stmt.values.find((v) => Array.isArray(v) && (v as unknown[]).includes(RANKED_SOLO_QUEUE_ID));
    expect(
      bound,
      `my_matches query does not bind COUNTED_QUEUE_IDS — it either forgot the ` +
        `filter or inlined the queue id instead of importing the constant:\n${stmt.text}`
    ).toBeDefined();
    expect(bound).toEqual(COUNTED_QUEUE_IDS);
  }
}

describe("lib/mystats/queues.ts — the constant itself", () => {
  it("counts ranked solo/duo and nothing else", () => {
    expect(COUNTED_QUEUE_IDS).toEqual([420]);
    expect(RANKED_SOLO_QUEUE_ID).toBe(420);
    expect(isCountedQueue(420)).toBe(true);
    for (const q of [FLEX, NORMAL_DRAFT, SWIFTPLAY, QUICKPLAY, ARAM, 430, 0]) {
      expect(isCountedQueue(q), `queue ${q} must not count`).toBe(false);
    }
  });

  it("an unknown queue id is NOT counted — never defaulted in", () => {
    // Defaulting an unknown queue to "counts" is precisely how an uncounted game
    // becomes a counted one when Riot adds a queue we have never seen.
    expect(isCountedQueue(null)).toBe(false);
    expect(isCountedQueue(undefined)).toBe(false);
    expect(isCountedQueue(99999)).toBe(false);
  });

  it("the manual My Stats report binds the same counted-queue set", () => {
    const source = readFileSync(new URL("../../scripts/ingest-mystats.mjs", import.meta.url), "utf8");
    expect(source).toContain("COUNTED_QUEUE_IDS");
    expect(source).toMatch(/queue_id\s*=\s*ANY/);
  });
});

describe("queue invariant: GET /api/mystats/summary", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
    mockListAccounts.mockReset();
    mockListAccounts.mockResolvedValue([]);
  });

  it("EVERY my_matches query it issues binds COUNTED_QUEUE_IDS", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(recordingSql(collected));
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    expect(res.status).toBe(200);
    assertEveryMyMatchesReadIsQueueFiltered(collected);
  });

  it("still filtered with role/championId/oppChampionId params applied", async () => {
    const collected: Statement[] = [];
    mockSql.mockImplementation(recordingSql(collected));
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    await summaryGET(req("http://localhost/api/mystats/summary?role=2&championId=3&oppChampionId=7"));
    assertEveryMyMatchesReadIsQueueFiltered(collected);
  });

  it("counts every stored counted-queue row across the season, without a split predicate", async () => {
    const collected: Statement[] = [];
    const storedRows = [
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, champion_id: 3, role: 2, opp_champion_id: 9, win: true, split: 1, game_creation: "2026-03-01T00:00:00.000Z", cs: 200, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, champion_id: 3, role: 2, opp_champion_id: 35, win: false, split: 2, game_creation: "2026-06-01T00:00:00.000Z", cs: 220, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, champion_id: 77, role: 1, opp_champion_id: 5, win: true, split: 2, game_creation: "2026-07-01T00:00:00.000Z", cs: 180, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: FLEX, champion_id: 99, role: -1, opp_champion_id: null, win: false, split: 1, game_creation: "2026-02-01T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
    ];
    mockSql.mockImplementation(
      recordingSql(collected, (text, values) => {
        if (!text.includes("coachbuild.my_matches")) return [];
        const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
        return storedRows.filter((r) => queues?.includes(r.queue_id) ?? true);
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    const games = body.records.reduce((sum: number, record: { games: number }) => sum + record.games, 0);
    expect(games).toBe(3); // split 1 and split 2 both count; flex does not
    expect(body.records.find((record: { championId: number }) => record.championId === 3)).toMatchObject({ games: 2, wins: 1 });
    expect(collected.filter((stmt) => stmt.text.includes("coachbuild.my_matches"))).not.toEqual([]);
    for (const stmt of collected.filter((statement) => statement.text.includes("coachbuild.my_matches"))) {
      expect(stmt.text).not.toMatch(/\bsplit\s*=/i);
    }
    assertEveryMyMatchesReadIsQueueFiltered(collected);
  });

  it("flex/normal/quickplay rows reach NO figure on the response", async () => {
    // One fake table, one account, mixed queues. Every query is answered by
    // applying whatever predicates the route actually bound — so a query that
    // binds no queue array gets the flex rows back, and the assertions below
    // catch the SHAPE of the mistake, not only its magnitude.
    const rows = [
      // Two solo-queue wins, on-build.
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, champion_id: 3, role: 2, opp_champion_id: 9, win: true, split: 2, kills: 5, deaths: 1, assists: 7, on_wpa_build: true, game_creation: "2026-05-01T00:00:00.000Z", cs: 200, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, champion_id: 3, role: 2, opp_champion_id: 35, win: true, split: 2, kills: 4, deaths: 2, assists: 3, on_wpa_build: true, game_creation: "2026-05-02T00:00:00.000Z", cs: 220, game_duration_sec: 1800 },
      // Non-solo games: MORE of them, all losses, all off-build, all NEWER, and
      // all with terrible CS. A leak moves every figure visibly but plausibly —
      // the win rate down, the adherence down, the CS/min down, and the recent-
      // games strip becomes mostly not-solo-queue.
      { puuid: ACTIVE_PUUID, queue_id: FLEX, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 0, deaths: 9, assists: 0, on_wpa_build: false, game_creation: "2026-06-01T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: NORMAL_DRAFT, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 0, deaths: 8, assists: 1, on_wpa_build: false, game_creation: "2026-06-02T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: QUICKPLAY, champion_id: 3, role: 2, opp_champion_id: 9, win: false, split: 2, kills: 1, deaths: 7, assists: 0, on_wpa_build: false, game_creation: "2026-06-03T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: SWIFTPLAY, champion_id: 77, role: 1, opp_champion_id: 5, win: false, split: 2, kills: 1, deaths: 7, assists: 0, on_wpa_build: false, game_creation: "2026-06-04T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
      { puuid: ACTIVE_PUUID, queue_id: ARAM, champion_id: 99, role: -1, opp_champion_id: null, win: false, split: 2, kills: 1, deaths: 7, assists: 0, on_wpa_build: false, game_creation: "2026-06-05T00:00:00.000Z", cs: 10, game_duration_sec: 1800 },
    ];
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text, values) => {
        if (!text.includes("coachbuild.my_matches")) return [];
        const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
        return rows.filter((r) => (queues ? queues.includes(r.queue_id) : true));
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();

    // records / championPool / win rate
    expect(body.records).toHaveLength(1); // champions 77 and 99 were non-solo only
    const galio = body.records.find((r: { championId: number }) => r.championId === 3);
    expect(galio.games).toBe(2); // NOT 5
    expect(galio.winrate).toBe(1); // NOT 0.4
    // build adherence
    expect(body.buildAdherencePct).toBe(100); // NOT 40
    expect(body.nOnBuild).toBe(2);
    expect(body.nOffBuild).toBeNull(); // the off-build games were all non-solo
    // CS headline — 420 CS over 60 min, not 470 over 210
    expect(body.csPerMin).toBe(7);
    expect(body.csGames).toBe(2);
    // recent games — the non-solo rows are all NEWER, so an unfiltered query
    // would put them at the TOP of the Match Performance chart.
    expect(body.recentGames).toHaveLength(2);
    for (const g of body.recentGames) expect(g.deaths).toBeLessThan(5);

    assertEveryMyMatchesReadIsQueueFiltered(collected);
  });

  it("an account whose stored games are ALL non-counted renders the EMPTY state, never NaN", async () => {
    // THE CONSEQUENCE THIS FIX CREATES. Before the filter this account had a
    // real (if meaningless) win rate; after it, every denominator is zero. Zero
    // must produce nulls and zeros — the same shape a brand-new account gets —
    // and never NaN%, "0.0%" presented as measured, or a thrown error.
    const rows = [
      { puuid: ACTIVE_PUUID, queue_id: ARAM, champion_id: 99, role: -1, opp_champion_id: null, win: true, split: 2, kills: 20, deaths: 1, assists: 30, on_wpa_build: true, game_creation: "2026-06-05T00:00:00.000Z", cs: 300, game_duration_sec: 1200 },
      { puuid: ACTIVE_PUUID, queue_id: FLEX, champion_id: 3, role: 2, opp_champion_id: 9, win: true, split: 2, kills: 9, deaths: 0, assists: 9, on_wpa_build: true, game_creation: "2026-06-06T00:00:00.000Z", cs: 300, game_duration_sec: 1200 },
    ];
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text, values) => {
        if (!text.includes("coachbuild.my_matches")) return [];
        const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
        return rows.filter((r) => (queues ? queues.includes(r.queue_id) : true));
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.accountUnresolved).toBe(false); // the ACCOUNT is fine; it just has no counted games
    expect(body.records).toEqual([]);
    expect(body.championPool).toEqual([]);
    expect(body.matchup).toBeNull();
    expect(body.buildAdherencePct).toBeNull();
    expect(body.winrateOnBuild).toBeNull();
    expect(body.winrateOffBuild).toBeNull();
    expect(body.nOnBuild).toBeNull();
    expect(body.nOffBuild).toBeNull();
    expect(body.csPerMin).toBeNull();
    expect(body.csGames).toBe(0); // a real count of zero, not a null figure
    expect(body.recentGames).toEqual([]);

    // Nothing anywhere on the response is NaN. Asserted over the whole body
    // rather than field by field, so a figure added later is covered too.
    const seen = JSON.stringify(body, (_k, v) => (typeof v === "number" && Number.isNaN(v) ? "__NaN__" : v));
    expect(seen).not.toContain("__NaN__");
  });
});

describe("queue invariant: GET /api/mystats/matchups", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
  });

  it("filtered in BOTH SQL branches (role given, and role omitted)", async () => {
    for (const url of [
      "http://localhost/api/mystats/matchups?championId=3&role=2",
      "http://localhost/api/mystats/matchups?championId=3",
    ]) {
      const collected: Statement[] = [];
      mockSql.mockImplementation(recordingSql(collected));
      mockGetActiveAccount.mockResolvedValue(ACTIVE);
      await matchupsGET(req(url));
      assertEveryMyMatchesReadIsQueueFiltered(collected);
    }
  });

  it("a flex-only lane matchup never appears in the matchup history", async () => {
    const rows = [
      { puuid: ACTIVE_PUUID, queue_id: RANKED_SOLO_QUEUE_ID, role: 2, opp_champion_id: 9, win: true, game_creation: "2026-05-01T00:00:00.000Z" },
      { puuid: ACTIVE_PUUID, queue_id: FLEX, role: 2, opp_champion_id: 555, win: false, game_creation: "2026-06-01T00:00:00.000Z" },
    ];
    const collected: Statement[] = [];
    mockSql.mockImplementation(
      recordingSql(collected, (text, values) => {
        if (!text.includes("coachbuild.my_matches")) return [];
        const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
        return rows.filter((r) => (queues ? queues.includes(r.queue_id) : true));
      })
    );
    mockGetActiveAccount.mockResolvedValue(ACTIVE);

    const body = await (await matchupsGET(req("http://localhost/api/mystats/matchups?championId=3"))).json();
    expect(body.matchups).toEqual([{ oppChampionId: 9, games: 1, wins: 1, winrate: 1 }]);
  });
});

describe("queue invariant: Draft personal-record badges", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
  });

  it("the Draft page's my_matches read is queue-filtered too", async () => {
    // A different page reading the same table. "You: 7-3 on this champion" is
    // read while drafting a RANKED SOLO game; padding it with flex and normal
    // games makes it a claim about something else.
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
    assertEveryMyMatchesReadIsQueueFiltered(collected);
  });
});
