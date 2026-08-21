/**
 * The `sessions` array on GET /api/mystats/summary (spec §7).
 *
 * lib/__tests__/mystats-sessions.test.ts owns the ARITHMETIC — the 8h boundary,
 * the midnight case, the three confidence states — over the pure functions. This
 * file owns what the ROUTE does with them, which is a different set of ways to
 * be wrong:
 *
 *  1. THE PAYLOAD SHAPE. `PlaySession` carries four internal fields the panel
 *     must never see, one of which (`gameEndsMs`) is an array with one entry per
 *     game in the season. Emitting the session objects directly would work,
 *     render correctly, and quietly ship a few hundred timestamps per response.
 *     Asserted as an EXACT key set, not a subset.
 *
 *  2. THE SLICE. "Last 10" has to come off the NEWEST end of an oldest-first
 *     list, and the confidence rule needs the WHOLE list to see contamination
 *     (see sessionLpDelta's `allSessions` parameter). Slicing before computing
 *     the delta would silently upgrade a contaminated bracket to `exact`.
 *
 *  3. MIGRATION 0027 IS NOT APPLIED YET. It lands at cutover, after this code
 *     ships. Until then `coachbuild.my_rank_samples` DOES NOT EXIST, and a
 *     summary route that lets that query throw takes the ENTIRE My Stats page
 *     down — every panel, not just the new one. The samples read therefore
 *     degrades to "no samples" (a dash) rather than propagating. This is the
 *     single most likely way this change breaks production, so it is tested
 *     first-class rather than as an edge case.
 *
 *  4. `unavailable` MUST NOT BECOME A NUMBER. Re-asserted end to end, through
 *     the route, on a session the user actually won every game of — the exact
 *     shape a "helpful" estimate would take.
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

const mockRefreshStaleRanks = vi.fn(async () => 0);
vi.mock("@/lib/mystats/rank", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, refreshStaleRanks: (...a: unknown[]) => mockRefreshStaleRanks(...(a as [])) };
});

vi.mock("@/lib/staticData", () => ({
  getChampionMeta: vi.fn(async () => null),
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 14, patchAdditions: 0, label: "16.14" })),
}));

import { GET as summaryGET } from "@/app/api/mystats/summary/route";
// The cap lives beside the grouping rather than in the route: a Next.js route
// file may only export its handlers and its segment config, and the panel's
// heading will need this number too.
import { SESSIONS_LIMIT } from "@/lib/mystats/sessions";
import { COUNTED_QUEUE_IDS } from "@/lib/mystats/queues";
import { FRESH_WINDOW_DAYS } from "@/lib/pro/fresh";

const PUUID = "active-account-puuid";
const ACTIVE = {
  id: 1,
  puuid: PUUID,
  riotId: "K1ayer#swift",
  gameName: "K1ayer",
  tagLine: "swift",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function req(url = "http://localhost/api/mystats/summary") {
  return { url, headers: { get: () => null } } as unknown as Parameters<typeof summaryGET>[0];
}

interface Statement {
  text: string;
  values: unknown[];
}

/** The session-grouping read is the ONLY my_matches query selecting exactly
 *  these three columns — see the route. Keyed on that rather than on a comment
 *  so a reworded comment does not silently disarm this file. */
const SESSION_SELECT = "SELECT game_creation, win, game_duration_sec";

type MatchRow = { game_creation: string; win: boolean; game_duration_sec: number | null };
type SampleRow = { observed_at: string; tier: string | null; division: string | null; lp: number | null };

interface Fixture {
  matches?: MatchRow[];
  samples?: SampleRow[];
  /** Simulates migration 0027 not being applied yet. */
  samplesThrow?: boolean;
  collected?: Statement[];
}

function serveSql({ matches = [], samples = [], samplesThrow = false, collected = [] }: Fixture) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("|");
    collected.push({ text, values });
    if (text.includes("coachbuild.my_rank_samples")) {
      return samplesThrow
        ? Promise.reject(new Error('relation "coachbuild.my_rank_samples" does not exist'))
        : Promise.resolve(samples);
    }
    if (text.includes(SESSION_SELECT)) return Promise.resolve(matches);
    return Promise.resolve([]);
  });
}

const game = (iso: string, win = true, durMin = 30): MatchRow => ({
  game_creation: iso,
  win,
  game_duration_sec: durMin * 60,
});
const sample = (iso: string, tier: string | null, division: string | null, lp: number | null): SampleRow => ({
  observed_at: iso,
  tier,
  division,
  lp,
});

/** Two sittings. The second runs 20:00 -> past midnight, which is the headline
 *  requirement, and the first is >8h before it. */
const TWO_SITTINGS: MatchRow[] = [
  // Sitting A — 2026-08-18 evening, 2 games, last one ends 19:30.
  game("2026-08-18T18:00:00.000Z"),
  game("2026-08-18T19:00:00.000Z", false),
  // Sitting B — 2026-08-19 evening into 2026-08-20, 5 games, last ends 01:10.
  game("2026-08-19T20:00:00.000Z"),
  game("2026-08-19T21:00:00.000Z"),
  game("2026-08-19T22:40:00.000Z", false),
  game("2026-08-19T23:20:00.000Z"),
  game("2026-08-20T00:40:00.000Z"),
];

async function summaryBody(fixture: Fixture) {
  mockGetActiveAccount.mockResolvedValue(ACTIVE);
  mockSql.mockImplementation(serveSql(fixture));
  const res = await summaryGET(req());
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  mockSql.mockReset();
  mockGetActiveAccount.mockReset();
  mockListAccounts.mockReset();
  mockListAccounts.mockResolvedValue([]);
});

describe("summary.sessions — the payload shape", () => {
  it("emits EXACTLY the five spec fields per session, and no internals", async () => {
    const body = await summaryBody({ matches: TWO_SITTINGS });
    expect(Array.isArray(body.sessions)).toBe(true);
    for (const s of body.sessions) {
      expect(Object.keys(s).sort()).toEqual(["endedAt", "losses", "lpDelta", "startedAt", "wins"]);
      // The internals PlaySession carries for the arithmetic. gameEndsMs in
      // particular is one timestamp per game in the whole season.
      for (const leaked of ["startedAtMs", "endedAtMs", "games", "gameEndsMs"]) {
        expect(s, "internal field leaked into the payload: " + leaked).not.toHaveProperty(leaked);
      }
      expect(typeof s.startedAt).toBe("string");
      expect(typeof s.endedAt).toBe("string");
      expect(typeof s.wins).toBe("number");
      expect(typeof s.losses).toBe("number");
      expect(["exact", "approximate", "unavailable"]).toContain(s.lpDelta.confidence);
    }
  });

  it("HEADLINE: the sitting that runs past midnight is ONE row, dated the earlier day", async () => {
    const body = await summaryBody({ matches: TWO_SITTINGS });
    expect(body.sessions).toHaveLength(2);
    const [newest] = body.sessions; // newest first
    expect(newest.startedAt).toBe("2026-08-19T20:00:00.000Z");
    expect(newest.endedAt).toBe("2026-08-20T01:10:00.000Z");
    expect(newest.wins).toBe(4);
    expect(newest.losses).toBe(1);
    // A calendar-day grouping would have produced a 4-game row on the 19th and
    // a 1-game row on the 20th.
    expect(body.sessions.map((s: { startedAt: string }) => s.startedAt.slice(0, 10))).not.toContain("2026-08-20");
  });

  it("returns the sessions NEWEST FIRST and no more than the last ten", async () => {
    // Twelve sittings, one game each, a day apart.
    const matches = Array.from({ length: 12 }, (_, i) =>
      game("2026-08-" + String(i + 1).padStart(2, "0") + "T18:00:00.000Z")
    );
    const body = await summaryBody({ matches });
    expect(SESSIONS_LIMIT).toBe(10);
    expect(body.sessions).toHaveLength(10);
    // The NEWEST ten — a `.slice(0, 10)` off an oldest-first list would have
    // returned the 1st through the 10th and lost the two most recent sittings.
    expect(body.sessions[0].startedAt).toBe("2026-08-12T18:00:00.000Z");
    expect(body.sessions[9].startedAt).toBe("2026-08-03T18:00:00.000Z");
    const starts = body.sessions.map((s: { startedAt: string }) => s.startedAt);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it("is an empty array — never absent — for an account with no counted games", async () => {
    const body = await summaryBody({ matches: [] });
    expect(body.sessions).toEqual([]);
  });

  it("is present on the accountUnresolved response too, so no consumer branches on shape", async () => {
    mockGetActiveAccount.mockResolvedValue(null);
    mockSql.mockImplementation(() => Promise.resolve([]));
    const body = await (await summaryGET(req())).json();
    expect(body.accountUnresolved).toBe(true);
    expect(body).toHaveProperty("sessions");
    expect(body.sessions).toEqual([]);
  });
});

describe("summary.sessions — the three confidence states, end to end", () => {
  it("EXACT: a reading each side of the sitting, and nothing else inside", async () => {
    const body = await summaryBody({
      matches: TWO_SITTINGS,
      samples: [
        sample("2026-08-18T17:50:00.000Z", "GOLD", "III", 90),
        sample("2026-08-18T19:40:00.000Z", "GOLD", "II", 40),
        sample("2026-08-19T19:50:00.000Z", "GOLD", "II", 40),
        sample("2026-08-20T01:20:00.000Z", "GOLD", "I", 15),
      ],
    });
    const [newest, older] = body.sessions;
    // Gold II 40 -> Gold I 15 crosses a DIVISION boundary: +75, not -25.
    expect(newest.lpDelta).toEqual({ value: 75, confidence: "exact" });
    // Gold III 90 -> Gold II 40 is +50, not -50.
    expect(older.lpDelta).toEqual({ value: 50, confidence: "exact" });
  });

  it("APPROXIMATE: a bracket that swallows the OTHER sitting's games is marked and counted", async () => {
    // Only two readings exist, days apart, so each sitting's bracket contains
    // the other's games. The number is real; the attribution is not.
    const body = await summaryBody({
      matches: TWO_SITTINGS,
      samples: [
        sample("2026-08-18T17:50:00.000Z", "GOLD", "III", 90),
        sample("2026-08-20T01:20:00.000Z", "GOLD", "I", 15),
      ],
    });
    const [newest, older] = body.sessions;
    expect(newest.lpDelta).toMatchObject({ value: 125, confidence: "approximate", reason: "extra-games", extraGames: 2 });
    expect(older.lpDelta).toMatchObject({ value: 125, confidence: "approximate", reason: "extra-games", extraGames: 5 });
  });

  it("UNAVAILABLE: no readings renders a DASH — never a number built from the win count", async () => {
    // Five games, four of them wins, zero readings. The tempting output is
    // "+60ish". The required output is nothing. This is the state EVERY session
    // predating capture is in, so it is the common case for months.
    const body = await summaryBody({ matches: TWO_SITTINGS, samples: [] });
    for (const s of body.sessions) {
      expect(s.lpDelta.value).toBeNull();
      expect(s.lpDelta.confidence).toBe("unavailable");
    }
    // Belt and braces: no LP-looking number anywhere in the sessions payload.
    expect(JSON.stringify(body.sessions)).not.toMatch(/"value":\s*-?\d/);
  });

  it("a reading the ladder cannot place is skipped, not scored as zero LP", async () => {
    // An UNRANKED reading stored as a real observation. Scored at Iron IV 0 it
    // would produce a delta of a couple of thousand LP that looks like data.
    const body = await summaryBody({
      matches: TWO_SITTINGS,
      samples: [sample("2026-08-19T19:50:00.000Z", null, null, null), sample("2026-08-20T01:20:00.000Z", "GOLD", "I", 15)],
    });
    expect(body.sessions[0].lpDelta.confidence).toBe("unavailable");
    expect(body.sessions[0].lpDelta.value).toBeNull();
  });
});

describe("summary.sessions — degrading when migration 0027 is not applied", () => {
  it("keeps the WHOLE page alive when my_rank_samples does not exist", async () => {
    // 0027 lands at cutover, after this ships. Between now and then the table
    // is absent on every environment. A propagating error here would 500 the
    // summary route — championPool, adherence, CS headline, Match Performance,
    // the account picker, all of it — for a panel that has nothing to show yet.
    const body = await summaryBody({ matches: TWO_SITTINGS, samplesThrow: true });
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].wins).toBe(4); // the W/L half needs no new table at all
    expect(body.sessions[0].lpDelta).toMatchObject({ value: null, confidence: "unavailable" });
    // And the rest of the response is untouched.
    expect(body.accountUnresolved).toBe(false);
    expect(body).toHaveProperty("csGames");
    expect(body).toHaveProperty("recentGames");
  });
});

describe("summary.sessions — the two new reads", () => {
  it("the session grouping read is scoped to the account AND to ranked solo only", async () => {
    // Structurally re-asserted here because the queue/scoping invariant files
    // only prove the property over the queries the route issues TODAY; this one
    // names the specific statement so its own regression is legible.
    const collected: Statement[] = [];
    await summaryBody({ matches: TWO_SITTINGS, collected });
    const stmt = collected.find((s) => s.text.includes(SESSION_SELECT));
    expect(stmt, "no session-grouping query was issued").toBeDefined();
    expect(stmt!.text).toContain("coachbuild.my_matches");
    expect(stmt!.text).toContain("queue_id");
    expect(stmt!.values).toContain(PUUID);
    expect(stmt!.values.find((v) => Array.isArray(v))).toEqual(COUNTED_QUEUE_IDS);
  });

  it("the samples read is scoped to the account and bounded to the same window retention keeps", async () => {
    // The prune predicate in lib/mystats/rankSample.ts is the COMPLEMENT of this
    // bound plus grace. If this query ever reaches further back than
    // FRESH_WINDOW_DAYS it starts asking for rows retention has already deleted.
    const collected: Statement[] = [];
    await summaryBody({ matches: TWO_SITTINGS, collected });
    const stmt = collected.find((s) => s.text.includes("coachbuild.my_rank_samples"));
    expect(stmt, "no rank-sample query was issued").toBeDefined();
    expect(stmt!.values).toContain(PUUID);
    expect(stmt!.values).toContain(FRESH_WINDOW_DAYS);
  });

  it("does not read the samples table at all when the account has no counted games", async () => {
    // Nothing to bracket. Skipping the round trip is free, and Neon compute is
    // the scarce resource this app ran out of on 2026-08-20.
    const collected: Statement[] = [];
    await summaryBody({ matches: [], collected });
    expect(collected.filter((s) => s.text.includes("coachbuild.my_rank_samples"))).toEqual([]);
  });
});
