import { describe, it, expect, vi } from "vitest";
import {
  normalizeMyStatsSummary,
  normalizeMyStatsMatchups,
  fetchMyStatsSummary,
  fetchMyStatsMatchups,
  myStatsRoleLabel,
  buildMyStatsRows,
  computeMyStatsOverall,
  buildMyStatsMatchupRows,
  computeAverageKda,
  computeGameKda,
  normalizeKdaBars,
  computeBuildWinrateDelta,
  computeRecentWinLoss,
  MYSTATS_LOW_SAMPLE_THRESHOLD,
  MYSTATS_KDA_BAR_CEILING,
  type MyStatsRecord,
  type MyStatsMatchupRecord,
  type IconEntry,
} from "../hextech/myStats";

const EXTENDED_DEFAULTS = {
  buildAdherencePct: null,
  winrateOnBuild: null,
  winrateOffBuild: null,
  nOnBuild: null,
  nOffBuild: null,
  priorSplitWinrate: null,
  recentGames: [],
};

describe("normalizeMyStatsSummary", () => {
  it("returns null for a non-object payload", () => {
    expect(normalizeMyStatsSummary(null)).toBeNull();
    expect(normalizeMyStatsSummary("<html>error</html>")).toBeNull();
  });

  it("parses a full, well-formed envelope (legacy fields only -- extended fields default to null/[])", () => {
    const result = normalizeMyStatsSummary({
      accountUnresolved: false,
      season: "Season 2026",
      riotId: "MunsterHunter#EUW",
      records: [{ championId: 112, role: 2, games: 39, wins: 25, winrate: 0.641, lastPlayed: "2026-07-20T00:00:00.000Z" }],
    });
    expect(result).toEqual({
      accountUnresolved: false,
      season: "Season 2026",
      riotId: "MunsterHunter#EUW",
      records: [{ championId: 112, role: 2, games: 39, wins: 25, winrate: 0.641, lastPlayed: "2026-07-20T00:00:00.000Z" }],
      ...EXTENDED_DEFAULTS,
    });
  });

  it("accountUnresolved envelope: riotId null, records empty, never crashes", () => {
    const result = normalizeMyStatsSummary({ accountUnresolved: true, season: "Season 2026", riotId: null, records: [] });
    expect(result?.riotId).toBeNull();
    expect(result?.records).toEqual([]);
  });

  it("drops a malformed individual record without dropping the rest of the list", () => {
    const result = normalizeMyStatsSummary({
      records: [
        { championId: 112, role: 2, games: 5, wins: 3, winrate: 0.6, lastPlayed: "x" },
        { role: 2, games: 5 }, // missing championId
      ],
    });
    expect(result?.records).toHaveLength(1);
    expect(result?.records[0].championId).toBe(112);
  });

  it("missing fields degrade to safe defaults rather than rejecting the whole response", () => {
    const result = normalizeMyStatsSummary({});
    expect(result).toEqual({ accountUnresolved: false, season: "", riotId: null, records: [], ...EXTENDED_DEFAULTS });
  });

  it("a record missing `role` degrades to -1 (unresolved), not a crash or a fabricated 0", () => {
    const result = normalizeMyStatsSummary({ records: [{ championId: 1, games: 1, wins: 1, winrate: 1 }] });
    expect(result?.records[0].role).toBe(-1);
  });

  // ── v0.51 Wave B P1 bug fix (2026-07-24): buildAdherencePct/winrateOnBuild/
  // winrateOffBuild/priorSplitWinrate/recentGames were being silently
  // stripped by this normalizer even though the server had already been
  // sending them -- reproduced here with the ACTUAL prod response shape
  // (fields/values as reported live: recentGames has 5 rows,
  // priorSplitWinrate=0.5185) rather than a synthetic minimal fixture, so
  // this test would have caught the real regression. ──────────────────────
  const PROD_PAYLOAD = {
    accountUnresolved: false,
    season: "Season 2026",
    riotId: "MunsterHunter#EUW",
    records: [{ championId: 112, role: 2, games: 39, wins: 25, winrate: 0.641, lastPlayed: "2026-07-20T00:00:00.000Z" }],
    matchup: null,
    buildAdherencePct: 62.5,
    winrateOnBuild: 0.68,
    winrateOffBuild: 0.45,
    nOnBuild: 22,
    nOffBuild: 14,
    priorSplitWinrate: 0.5185,
    recentGames: [
      { championId: 112, role: 2, win: true, kills: 8, deaths: 2, assists: 11, onWpaBuild: true },
      { championId: 122, role: 0, win: false, kills: 3, deaths: 6, assists: 2, onWpaBuild: false },
      { championId: 64, role: 1, win: true, kills: 12, deaths: 4, assists: 7, onWpaBuild: null },
      { championId: 51, role: 3, win: true, kills: 6, deaths: 1, assists: 9, onWpaBuild: true },
      { championId: 412, role: 4, win: false, kills: 0, deaths: 3, assists: 14, onWpaBuild: null },
    ],
  };

  it("passes through the real prod extended payload (P1 repro): all 5 recentGames rows + every extended stat survive", () => {
    const result = normalizeMyStatsSummary(PROD_PAYLOAD);
    expect(result?.buildAdherencePct).toBe(62.5);
    expect(result?.winrateOnBuild).toBe(0.68);
    expect(result?.winrateOffBuild).toBe(0.45);
    expect(result?.nOnBuild).toBe(22);
    expect(result?.nOffBuild).toBe(14);
    expect(result?.priorSplitWinrate).toBe(0.5185);
    expect(result?.recentGames).toHaveLength(5);
    expect(result?.recentGames).toEqual([
      { championId: 112, role: 2, win: true, kills: 8, deaths: 2, assists: 11, onWpaBuild: true },
      { championId: 122, role: 0, win: false, kills: 3, deaths: 6, assists: 2, onWpaBuild: false },
      { championId: 64, role: 1, win: true, kills: 12, deaths: 4, assists: 7, onWpaBuild: null },
      { championId: 51, role: 3, win: true, kills: 6, deaths: 1, assists: 9, onWpaBuild: true },
      { championId: 412, role: 4, win: false, kills: 0, deaths: 3, assists: 14, onWpaBuild: null },
    ]);
  });

  // ── v0.74 closes the gap flagged in HANDOFF-engo.md: feeding a REAL
  // (normalized) server payload's nOnBuild/nOffBuild into
  // computeBuildWinrateDelta must now actually reach `comparable: true` on
  // an ordinary production load -- this is the end-to-end proof, not a
  // synthetic-only unit test of the delta function in isolation. ──────────
  it("end-to-end: the normalized prod payload's nOnBuild/nOffBuild make computeBuildWinrateDelta return comparable:true", () => {
    const result = normalizeMyStatsSummary(PROD_PAYLOAD);
    expect(result).not.toBeNull();
    const delta = computeBuildWinrateDelta(
      result!.winrateOnBuild ?? null,
      result!.winrateOffBuild ?? null,
      result!.nOnBuild,
      result!.nOffBuild
    );
    expect(delta).toEqual({
      comparable: true,
      delta: 0.68 - 0.45,
      onBuild: { winrate: 0.68, n: 22 },
      offBuild: { winrate: 0.45, n: 14 },
    });
  });

  it("buildAdherencePct/winrateOnBuild/winrateOffBuild/priorSplitWinrate/nOnBuild/nOffBuild of exactly 0 survive (never coerced to null)", () => {
    const result = normalizeMyStatsSummary({
      buildAdherencePct: 0,
      winrateOnBuild: 0,
      winrateOffBuild: 0,
      priorSplitWinrate: 0,
      // nOnBuild/nOffBuild are never actually 0 in practice (the aggregate
      // layer returns null instead, see mystats-aggregate.test.ts) -- this
      // exercises the NORMALIZER's own numOrNull passthrough in isolation,
      // same "0 is a real value" discipline as every other field here.
      nOnBuild: 0,
      nOffBuild: 0,
    });
    expect(result?.buildAdherencePct).toBe(0);
    expect(result?.winrateOnBuild).toBe(0);
    expect(result?.winrateOffBuild).toBe(0);
    expect(result?.priorSplitWinrate).toBe(0);
    expect(result?.nOnBuild).toBe(0);
    expect(result?.nOffBuild).toBe(0);
  });

  it("a non-finite/wrong-typed extended stat degrades to null, never NaN or a string", () => {
    const result = normalizeMyStatsSummary({
      buildAdherencePct: NaN,
      winrateOnBuild: "0.5",
      priorSplitWinrate: undefined,
      nOnBuild: "22",
      nOffBuild: NaN,
    });
    expect(result?.buildAdherencePct).toBeNull();
    expect(result?.winrateOnBuild).toBeNull();
    expect(result?.priorSplitWinrate).toBeNull();
    expect(result?.nOnBuild).toBeNull();
    expect(result?.nOffBuild).toBeNull();
  });

  it("drops a malformed recentGames entry without dropping the rest of the list", () => {
    const result = normalizeMyStatsSummary({
      recentGames: [
        { championId: 112, role: 2, win: true, kills: 8, deaths: 2, assists: 11, onWpaBuild: true },
        { role: 2, win: true }, // missing championId
        { championId: 64, role: 1 }, // missing win
      ],
    });
    expect(result?.recentGames).toHaveLength(1);
    expect(result?.recentGames?.[0].championId).toBe(112);
  });

  it("a recentGames entry missing `role` degrades to -1, not a crash or a fabricated 0", () => {
    const result = normalizeMyStatsSummary({
      recentGames: [{ championId: 1, win: true, kills: 1, deaths: 1, assists: 1 }],
    });
    expect(result?.recentGames?.[0].role).toBe(-1);
  });

  it("a recentGames entry's onWpaBuild coerces anything non-boolean to null, never fabricated as false", () => {
    const result = normalizeMyStatsSummary({
      recentGames: [
        { championId: 1, role: 0, win: true, onWpaBuild: undefined },
        { championId: 2, role: 0, win: true, onWpaBuild: "true" },
        { championId: 3, role: 0, win: true, onWpaBuild: false },
        { championId: 4, role: 0, win: true, onWpaBuild: true },
      ],
    });
    expect(result?.recentGames?.map((g) => g.onWpaBuild)).toEqual([null, null, false, true]);
  });

  it("a non-array recentGames degrades to [] rather than crashing", () => {
    expect(normalizeMyStatsSummary({ recentGames: "not-an-array" })?.recentGames).toEqual([]);
  });
});

describe("normalizeMyStatsMatchups", () => {
  it("returns null for a non-object payload", () => {
    expect(normalizeMyStatsMatchups(undefined)).toBeNull();
  });

  it("parses a full envelope (incl. role) and drops a malformed matchup entry", () => {
    const result = normalizeMyStatsMatchups({
      accountUnresolved: false,
      season: "Season 2026",
      championId: 112,
      role: 2,
      matchups: [
        { oppChampionId: 99, games: 8, wins: 3, winrate: 0.375 },
        { games: 2 }, // missing oppChampionId
      ],
    });
    expect(result?.role).toBe(2);
    expect(result?.matchups).toEqual([{ oppChampionId: 99, games: 8, wins: 3, winrate: 0.375 }]);
  });

  it("role degrades to null when absent or non-numeric -- champion-wide is a real, distinct scope from role -1", () => {
    expect(normalizeMyStatsMatchups({ championId: 1, matchups: [] })?.role).toBeNull();
    expect(normalizeMyStatsMatchups({ championId: 1, role: "abc", matchups: [] })?.role).toBeNull();
    expect(normalizeMyStatsMatchups({ championId: 1, role: -1, matchups: [] })?.role).toBe(-1);
  });
});

describe("fetchMyStatsSummary / fetchMyStatsMatchups", () => {
  it("returns the normalized response on success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ accountUnresolved: false, season: "Season 2026", riotId: "X#EUW", records: [] }),
    })) as unknown as typeof fetch;
    const result = await fetchMyStatsSummary({ fetchImpl });
    expect(result?.riotId).toBe("X#EUW");
  });

  it("returns null on a non-ok response, never throws", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(await fetchMyStatsSummary({ fetchImpl })).toBeNull();
  });

  it("returns null on a network error, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchMyStatsSummary({ fetchImpl })).toBeNull();
  });

  it("fetchMyStatsMatchups hits the URL with championId encoded, no role param when role is omitted (champion-wide)", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    await fetchMyStatsMatchups(112, undefined, { fetchImpl });
    expect(calledUrl).toBe("/api/mystats/matchups?championId=112");
  });

  it("fetchMyStatsMatchups includes role in the URL when given -- role=-1 (unresolved lane) included too, not treated as absent", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await fetchMyStatsMatchups(112, 2, { fetchImpl });
    expect(calledUrl).toBe("/api/mystats/matchups?championId=112&role=2");

    await fetchMyStatsMatchups(112, -1, { fetchImpl });
    expect(calledUrl).toBe("/api/mystats/matchups?championId=112&role=-1");
  });
});

describe("myStatsRoleLabel", () => {
  it("maps 0-4 to lane names", () => {
    expect(myStatsRoleLabel(0)).toBe("Top");
    expect(myStatsRoleLabel(1)).toBe("Jungle");
    expect(myStatsRoleLabel(2)).toBe("Mid");
    expect(myStatsRoleLabel(3)).toBe("Bot");
    expect(myStatsRoleLabel(4)).toBe("Support");
  });

  it("-1 and any unrecognized value reads as 'Other'", () => {
    expect(myStatsRoleLabel(-1)).toBe("Other");
    expect(myStatsRoleLabel(99)).toBe("Other");
  });
});

describe("buildMyStatsRows", () => {
  const iconOf = (id: number): IconEntry | undefined => (id === 112 ? { name: "Viktor", icon: "viktor.webp" } : undefined);

  it("decorates a record with icon/name/role label and losses", () => {
    const records: MyStatsRecord[] = [{ championId: 112, role: 2, games: 39, wins: 25, winrate: 0.641, lastPlayed: "x" }];
    const rows = buildMyStatsRows(records, iconOf);
    expect(rows).toEqual([
      {
        championId: 112,
        role: 2,
        roleLabel: "Mid",
        name: "Viktor",
        icon: "viktor.webp",
        games: 39,
        wins: 25,
        losses: 14,
        winrate: 0.641,
        lowSample: false,
      },
    ]);
  });

  it(`marks games below ${MYSTATS_LOW_SAMPLE_THRESHOLD} as lowSample`, () => {
    const records: MyStatsRecord[] = [{ championId: 1, role: 0, games: 9, wins: 5, winrate: 0.556, lastPlayed: "x" }];
    expect(buildMyStatsRows(records, () => undefined)[0].lowSample).toBe(true);
  });

  it(`exactly ${MYSTATS_LOW_SAMPLE_THRESHOLD} games is NOT lowSample (threshold is exclusive on the low side)`, () => {
    const records: MyStatsRecord[] = [{ championId: 1, role: 0, games: 10, wins: 5, winrate: 0.5, lastPlayed: "x" }];
    expect(buildMyStatsRows(records, () => undefined)[0].lowSample).toBe(false);
  });

  it("unresolved icon falls back to a placeholder name, never an empty label", () => {
    const records: MyStatsRecord[] = [{ championId: 999, role: -1, games: 3, wins: 1, winrate: 0.333, lastPlayed: "x" }];
    const row = buildMyStatsRows(records, () => undefined)[0];
    expect(row.name).toBe("Champion #999");
    expect(row.roleLabel).toBe("Other");
  });

  it("does NOT re-sort -- preserves whatever order the records arrived in", () => {
    const records: MyStatsRecord[] = [
      { championId: 1, role: 0, games: 5, wins: 1, winrate: 0.2, lastPlayed: "x" },
      { championId: 2, role: 0, games: 50, wins: 40, winrate: 0.8, lastPlayed: "x" },
    ];
    const rows = buildMyStatsRows(records, () => undefined);
    expect(rows.map((r) => r.championId)).toEqual([1, 2]); // input order kept even though champ 2 has more games
  });
});

describe("computeMyStatsOverall", () => {
  it("sums games/wins across every record", () => {
    const records: MyStatsRecord[] = [
      { championId: 1, role: 0, games: 39, wins: 25, winrate: 0.641, lastPlayed: "x" },
      { championId: 2, role: 1, games: 11, wins: 4, winrate: 0.364, lastPlayed: "x" },
    ];
    expect(computeMyStatsOverall(records)).toEqual({ games: 50, wins: 29, losses: 21, winrate: 0.58 });
  });

  it("zero records -> zeroed totals, winrate 0 (not NaN)", () => {
    expect(computeMyStatsOverall([])).toEqual({ games: 0, wins: 0, losses: 0, winrate: 0 });
  });
});

describe("buildMyStatsMatchupRows", () => {
  const iconOf = (id: number): IconEntry | undefined => (id === 64 ? { name: "Lee Sin", icon: "leesin.webp" } : undefined);

  it("decorates a matchup record with icon/name and losses", () => {
    const matchups: MyStatsMatchupRecord[] = [{ oppChampionId: 64, games: 8, wins: 3, winrate: 0.375 }];
    expect(buildMyStatsMatchupRows(matchups, iconOf)).toEqual([
      { oppChampionId: 64, name: "Lee Sin", icon: "leesin.webp", games: 8, wins: 3, losses: 5, winrate: 0.375, lowSample: true },
    ]);
  });

  it("does NOT re-sort -- preserves server order", () => {
    const matchups: MyStatsMatchupRecord[] = [
      { oppChampionId: 1, games: 2, wins: 1, winrate: 0.5 },
      { oppChampionId: 2, games: 20, wins: 15, winrate: 0.75 },
    ];
    expect(buildMyStatsMatchupRows(matchups, () => undefined).map((r) => r.oppChampionId)).toEqual([1, 2]);
  });
});

// ── v0.74 wave -- KPI-strip + bar-chart helpers (engo) ──────────────────────

describe("computeAverageKda", () => {
  it("computes KDA from the AVERAGED components, not the average of per-game ratios (realistic 2-game sample)", () => {
    // avgKills=8, avgDeaths=3, avgAssists=7 -> kda = (8+7)/3 = 5
    const games = [
      { kills: 10, deaths: 4, assists: 6 },
      { kills: 6, deaths: 2, assists: 8 },
    ];
    const result = computeAverageKda(games);
    expect(result).toEqual({ avgKills: 8, avgDeaths: 3, avgAssists: 7, kda: 5, n: 2 });
  });

  it("zero deaths across every game -> finite kda (kills+assists), never Infinity or NaN", () => {
    const games = [
      { kills: 10, deaths: 0, assists: 5 },
      { kills: 6, deaths: 0, assists: 9 },
    ];
    const result = computeAverageKda(games);
    expect(result.avgDeaths).toBe(0);
    expect(result.kda).toBe(15); // avgKills(8) + avgAssists(7)
    expect(Number.isFinite(result.kda)).toBe(true);
  });

  it("zero games -> all-zero totals, kda 0 (not NaN) -- an empty state, not an error", () => {
    expect(computeAverageKda([])).toEqual({ avgKills: 0, avgDeaths: 0, avgAssists: 0, kda: 0, n: 0 });
  });

  it("a single game is a real input -- averages equal that game's own numbers", () => {
    const result = computeAverageKda([{ kills: 4, deaths: 2, assists: 6 }]);
    expect(result).toEqual({ avgKills: 4, avgDeaths: 2, avgAssists: 6, kda: 5, n: 1 });
  });
});

describe("computeGameKda", () => {
  it("computes (kills+assists)/deaths for a normal game", () => {
    expect(computeGameKda({ kills: 6, deaths: 3, assists: 3 })).toEqual({ kda: 3, perfect: false });
  });

  it("zero deaths -> finite kda (kills+assists) and perfect: true, never Infinity", () => {
    const result = computeGameKda({ kills: 12, deaths: 0, assists: 7 });
    expect(result).toEqual({ kda: 19, perfect: true });
    expect(Number.isFinite(result.kda)).toBe(true);
  });

  it("a scoreless game (0/0/0) is a real input -- 0 kda, perfect: true (0 deaths), not NaN", () => {
    expect(computeGameKda({ kills: 0, deaths: 0, assists: 0 })).toEqual({ kda: 0, perfect: true });
  });
});

describe("normalizeKdaBars", () => {
  it("maps kda to a 0..1 fraction of MYSTATS_KDA_BAR_CEILING for ordinary games", () => {
    const bars = normalizeKdaBars([{ kills: 3, deaths: 3, assists: 3 }]); // kda 2
    expect(bars[0].kda).toBe(2);
    expect(bars[0].fraction).toBeCloseTo(2 / MYSTATS_KDA_BAR_CEILING, 5);
  });

  it("an outlier game clamps at the ceiling (fraction 1) instead of stretching the scale for every other bar", () => {
    const bars = normalizeKdaBars([
      { kills: 20, deaths: 0, assists: 20 }, // kda 40 -- the outlier
      { kills: 3, deaths: 3, assists: 3 }, // kda 2 -- an ordinary game
    ]);
    expect(bars[0].kda).toBe(40);
    expect(bars[0].fraction).toBe(1); // clamped, not 40/40
    expect(bars[1].fraction).toBeCloseTo(2 / MYSTATS_KDA_BAR_CEILING, 5); // still a visible, undistorted bar
  });

  it("does NOT re-sort -- one bar per input game, in input order", () => {
    const bars = normalizeKdaBars([
      { kills: 1, deaths: 1, assists: 1 },
      { kills: 9, deaths: 1, assists: 9 },
    ]);
    expect(bars.map((b) => b.kda)).toEqual([2, 18]);
  });

  it("empty input -> empty output", () => {
    expect(normalizeKdaBars([])).toEqual([]);
  });
});

describe("computeBuildWinrateDelta", () => {
  it("returns comparable:true with a signed delta when both sides have adequate samples", () => {
    // realistic figures matching the module's own prod-payload fixture style
    const result = computeBuildWinrateDelta(0.68, 0.45, 22, 14);
    expect(result).toEqual({
      comparable: true,
      delta: 0.68 - 0.45,
      onBuild: { winrate: 0.68, n: 22 },
      offBuild: { winrate: 0.45, n: 14 },
    });
  });

  it("winrateOnBuild null -> not comparable, reason no-on-build-data (checked before offBuild)", () => {
    expect(computeBuildWinrateDelta(null, 0.45, 22, 14)).toEqual({ comparable: false, reason: "no-on-build-data" });
    expect(computeBuildWinrateDelta(null, null, 22, 14)).toEqual({ comparable: false, reason: "no-on-build-data" });
  });

  it("winrateOffBuild null (onBuild present) -> not comparable, reason no-off-build-data", () => {
    expect(computeBuildWinrateDelta(0.68, null, 22, 14)).toEqual({ comparable: false, reason: "no-off-build-data" });
  });

  it("both winrates present but sample sizes unknown -- degrades to sample-unknown, never guesses a count", () => {
    expect(computeBuildWinrateDelta(0.68, 0.45)).toEqual({ comparable: false, reason: "sample-unknown" });
    expect(computeBuildWinrateDelta(0.68, 0.45, null, null)).toEqual({ comparable: false, reason: "sample-unknown" });
    expect(computeBuildWinrateDelta(0.68, 0.45, 22, undefined)).toEqual({ comparable: false, reason: "sample-unknown" });
  });

  it(`either side below MYSTATS_LOW_SAMPLE_THRESHOLD (${MYSTATS_LOW_SAMPLE_THRESHOLD}) -- not comparable, reason low-sample`, () => {
    expect(computeBuildWinrateDelta(0.68, 0.45, 5, 14)).toEqual({ comparable: false, reason: "low-sample" });
    expect(computeBuildWinrateDelta(0.68, 0.45, 22, 3)).toEqual({ comparable: false, reason: "low-sample" });
  });

  it("never returns a delta of 0 for an unknown comparison -- 0 only appears inside a comparable:true result", () => {
    const result = computeBuildWinrateDelta(0.5, 0.5, 22, 14);
    expect(result).toEqual({
      comparable: true,
      delta: 0,
      onBuild: { winrate: 0.5, n: 22 },
      offBuild: { winrate: 0.5, n: 14 },
    });
    // contrast: the "unknown" cases never carry a numeric delta field at all
    const unknown = computeBuildWinrateDelta(0.5, 0.5);
    expect((unknown as { delta?: number }).delta).toBeUndefined();
  });
});

describe("computeRecentWinLoss", () => {
  it("counts wins/losses over the given window, n is the exact input length", () => {
    const games = [{ win: true }, { win: false }, { win: true }, { win: true }];
    expect(computeRecentWinLoss(games)).toEqual({ wins: 3, losses: 1, n: 4, lowSample: true });
  });

  it(`at/above MYSTATS_LOW_SAMPLE_THRESHOLD (${MYSTATS_LOW_SAMPLE_THRESHOLD}) is not lowSample`, () => {
    const games = Array.from({ length: MYSTATS_LOW_SAMPLE_THRESHOLD }, (_, i) => ({ win: i % 2 === 0 }));
    expect(computeRecentWinLoss(games).lowSample).toBe(false);
  });

  it("zero games -> all-zero counts, lowSample true, never a crash", () => {
    expect(computeRecentWinLoss([])).toEqual({ wins: 0, losses: 0, n: 0, lowSample: true });
  });

  it("a single game is a real input", () => {
    expect(computeRecentWinLoss([{ win: false }])).toEqual({ wins: 0, losses: 1, n: 1, lowSample: true });
  });
});
