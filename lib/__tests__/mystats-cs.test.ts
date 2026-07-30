import { describe, it, expect } from "vitest";
import {
  CS_MIN_GAME_SEC,
  aggregateCs,
  countsTowardCsRate,
  csPerMinForGame,
} from "@/lib/mystats/cs";
import { summarizeByChampion, buildRecentGames, computeCsSummary } from "@/lib/mystats/aggregate";

// ─────────────────────────────────────────────────────────────────────────────
// THE TEST THAT MATTERS: a rate cannot be re-averaged across differing game
// lengths. Everything else in this file guards a null/absent distinction; this
// block guards the arithmetic that migration 0021's whole two-raw-column shape
// exists to make possible.
// ─────────────────────────────────────────────────────────────────────────────
describe("CS/min is TIME-WEIGHTED, not a mean of per-game rates", () => {
  // 40 min @ 320 CS = 8.0/min ; 20 min @ 100 CS = 5.0/min
  //   mean of rates  -> (8.0 + 5.0) / 2      = 6.5   WRONG
  //   time-weighted  -> 420 CS / 60 min      = 7.0   RIGHT
  const longGame = { cs: 320, gameDurationSec: 2400 };
  const shortGame = { cs: 100, gameDurationSec: 1200 };

  it("returns the time-weighted answer, not the mean of the rates", () => {
    expect(csPerMinForGame(longGame)).toBe(8.0);
    expect(csPerMinForGame(shortGame)).toBe(5.0);

    const agg = aggregateCs([longGame, shortGame]);
    expect(agg.csPerMin).toBe(7.0);
    // The wrong answer, stated explicitly so a regression that reintroduces it
    // fails here with an obvious diff rather than looking like a rounding drift.
    const meanOfRates =
      ((csPerMinForGame(longGame) as number) + (csPerMinForGame(shortGame) as number)) / 2;
    expect(meanOfRates).toBe(6.5);
    expect(agg.csPerMin).not.toBe(meanOfRates);
  });

  it("keeps the raw sums so a caller can re-aggregate correctly", () => {
    const agg = aggregateCs([longGame, shortGame]);
    expect(agg.totalCs).toBe(420);
    expect(agg.totalDurationSec).toBe(3600);
    expect(agg.games).toBe(2);
  });

  it("order of games does not change the answer", () => {
    expect(aggregateCs([longGame, shortGame]).csPerMin).toBe(
      aggregateCs([shortGame, longGame]).csPerMin
    );
  });

  it("weights a long game more heavily than a short one, as time-weighting must", () => {
    // One 40-min game at 8.0 plus three 20-min games at 5.0. Mean of rates
    // would be (8+5+5+5)/4 = 5.75; the honest answer leans toward the games
    // that actually consumed the minutes.
    const rows = [longGame, shortGame, shortGame, shortGame];
    const agg = aggregateCs(rows);
    expect(agg.totalCs).toBe(620);
    expect(agg.totalDurationSec).toBe(6000);
    expect(agg.csPerMin).toBe(6.2); // 620 / 100 min
    expect(agg.csPerMin).not.toBe(5.8); // rounded mean-of-rates, for contrast
  });

  it("aggregates identically whether rows arrive in one call or are summed from raw parts", () => {
    // The property that makes the raw columns worth storing: two disjoint
    // groups can be combined from their SUMS and give the same answer as
    // aggregating all the rows at once. That is false for stored rates.
    const groupA = [longGame, longGame];
    const groupB = [shortGame];
    const combined = aggregateCs([...groupA, ...groupB]);
    const a = aggregateCs(groupA);
    const b = aggregateCs(groupB);
    const recombined =
      ((a.totalCs as number) + (b.totalCs as number)) /
      (((a.totalDurationSec as number) + (b.totalDurationSec as number)) / 60);
    expect(Math.round(recombined * 10) / 10).toBe(combined.csPerMin);
  });
});

describe("short games and remakes", () => {
  it("excludes anything under CS_MIN_GAME_SEC from a rate", () => {
    const remake = { cs: 12, gameDurationSec: 221 }; // 3:41
    expect(CS_MIN_GAME_SEC).toBe(300);
    expect(countsTowardCsRate(remake)).toBe(false);
    expect(csPerMinForGame(remake)).toBeNull();
  });

  it("includes a game exactly at the threshold", () => {
    // The boundary is >=, not > — pinned so a later refactor cannot quietly
    // move a whole band of 5:00 games in or out of every figure.
    expect(countsTowardCsRate({ cs: 30, gameDurationSec: CS_MIN_GAME_SEC })).toBe(true);
    expect(countsTowardCsRate({ cs: 30, gameDurationSec: CS_MIN_GAME_SEC - 1 })).toBe(false);
  });

  it("a remake does not drag the average down", () => {
    const real = { cs: 280, gameDurationSec: 2100 };
    const remake = { cs: 12, gameDurationSec: 221 };
    const withRemake = aggregateCs([real, remake]);
    const withoutRemake = aggregateCs([real]);
    expect(withRemake.csPerMin).toBe(withoutRemake.csPerMin);
    expect(withRemake.games).toBe(1); // the remake is not counted, and says so
  });

  it("never divides by a zero duration", () => {
    expect(csPerMinForGame({ cs: 50, gameDurationSec: 0 })).toBeNull();
    expect(aggregateCs([{ cs: 50, gameDurationSec: 0 }]).csPerMin).toBeNull();
  });
});

describe("null is NOT zero", () => {
  it("drops an unmeasured row instead of counting it as a zero-CS game", () => {
    const measured = { cs: 200, gameDurationSec: 1500 }; // 8.0/min
    const unmeasured = { cs: null, gameDurationSec: null };
    const agg = aggregateCs([measured, unmeasured]);
    expect(agg.csPerMin).toBe(8.0); // NOT 4.0, which is what treating null as 0 gives
    expect(agg.games).toBe(1);
  });

  it("drops a half-measured row rather than inventing the missing half", () => {
    expect(countsTowardCsRate({ cs: 200, gameDurationSec: null })).toBe(false);
    expect(countsTowardCsRate({ cs: null, gameDurationSec: 1500 })).toBe(false);
  });

  it("reports null and zero games when nothing is measurable", () => {
    const agg = aggregateCs([{ cs: null, gameDurationSec: null }]);
    expect(agg.csPerMin).toBeNull();
    expect(agg.games).toBe(0);
    expect(agg.totalCs).toBeNull();
    expect(agg.totalDurationSec).toBeNull();
  });
});

describe("summarizeByChampion CS threading", () => {
  const base = { oppChampionId: null, win: true };

  it("time-weights within a champion+role group", () => {
    const rows = [
      { ...base, championId: 1, role: 2, gameCreation: "2026-07-01T00:00:00Z", cs: 320, gameDurationSec: 2400 },
      { ...base, championId: 1, role: 2, gameCreation: "2026-07-02T00:00:00Z", cs: 100, gameDurationSec: 1200 },
    ];
    const [entry] = summarizeByChampion(rows);
    expect(entry.csPerMin).toBe(7.0);
    expect(entry.csGames).toBe(2);
    expect(entry.games).toBe(2);
  });

  it("csGames is smaller than games when rows are unmeasured or too short", () => {
    const rows = [
      { ...base, championId: 5, role: 0, gameCreation: "2026-07-01T00:00:00Z", cs: 200, gameDurationSec: 1500 },
      { ...base, championId: 5, role: 0, gameCreation: "2026-07-02T00:00:00Z", cs: null, gameDurationSec: null },
      { ...base, championId: 5, role: 0, gameCreation: "2026-07-03T00:00:00Z", cs: 10, gameDurationSec: 200 },
    ];
    const [entry] = summarizeByChampion(rows);
    expect(entry.games).toBe(3);
    expect(entry.csGames).toBe(1);
    expect(entry.csPerMin).toBe(8.0);
  });

  it("reports null csPerMin (never 0) for a champion with no measured rows", () => {
    const rows = [
      { ...base, championId: 9, role: 1, gameCreation: "2026-07-01T00:00:00Z", cs: null, gameDurationSec: null },
    ];
    const [entry] = summarizeByChampion(rows);
    expect(entry.csPerMin).toBeNull();
    expect(entry.csGames).toBe(0);
    expect(entry.games).toBe(1);
  });

  it("still works for callers that pass no CS fields at all (back-compat)", () => {
    const rows = [{ ...base, championId: 3, role: 4, gameCreation: "2026-07-01T00:00:00Z" }];
    const [entry] = summarizeByChampion(rows);
    expect(entry.games).toBe(1);
    expect(entry.csPerMin).toBeNull();
    expect(entry.csGames).toBe(0);
  });

  it("does not let one champion's CS leak into another's", () => {
    const rows = [
      { ...base, championId: 1, role: 2, gameCreation: "2026-07-01T00:00:00Z", cs: 300, gameDurationSec: 1800 },
      { ...base, championId: 2, role: 2, gameCreation: "2026-07-02T00:00:00Z", cs: 60, gameDurationSec: 1800 },
    ];
    const byId = new Map(summarizeByChampion(rows).map((e) => [e.championId, e]));
    expect(byId.get(1)?.csPerMin).toBe(10.0);
    expect(byId.get(2)?.csPerMin).toBe(2.0);
  });
});

describe("computeCsSummary (the headline KPI)", () => {
  it("re-aggregates from raw rows, NOT by averaging per-champion rates", () => {
    // Champion A: one 40-min game at 8.0/min. Champion B: three 10-min games
    // at 2.0/min. Averaging the two champions' rates gives 5.0; the honest
    // account-wide answer weights A's 40 minutes against B's 30.
    const base = { oppChampionId: null, win: true };
    const rows = [
      { ...base, championId: 1, role: 2, gameCreation: "2026-07-01T00:00:00Z", cs: 320, gameDurationSec: 2400 },
      { ...base, championId: 2, role: 3, gameCreation: "2026-07-02T00:00:00Z", cs: 20, gameDurationSec: 600 },
      { ...base, championId: 2, role: 3, gameCreation: "2026-07-03T00:00:00Z", cs: 20, gameDurationSec: 600 },
      { ...base, championId: 2, role: 3, gameCreation: "2026-07-04T00:00:00Z", cs: 20, gameDurationSec: 600 },
    ];
    const perChampion = summarizeByChampion(rows);
    const meanOfChampionRates =
      perChampion.reduce((s, e) => s + (e.csPerMin as number), 0) / perChampion.length;
    expect(meanOfChampionRates).toBe(5.0);

    const summary = computeCsSummary(rows);
    expect(summary.csPerMin).toBe(5.4); // 380 CS / 70 min = 5.428... -> 5.4
    expect(summary.csGames).toBe(4);
    expect(summary.csPerMin).not.toBe(meanOfChampionRates);
  });

  it("is null with zero games when nothing qualifies", () => {
    expect(computeCsSummary([])).toEqual({ csPerMin: null, csGames: 0 });
  });
});

describe("buildRecentGames CS fields", () => {
  const g = (over: Record<string, unknown>) => ({
    championId: 1,
    role: 2,
    win: true,
    kills: 1,
    deaths: 2,
    assists: 3,
    onWpaBuild: null,
    gameCreation: "2026-07-01T00:00:00Z",
    ...over,
  });

  it("emits cs, gameDurationSec and a per-game rate", () => {
    const [row] = buildRecentGames([g({ cs: 240, gameDurationSec: 1800 })]);
    expect(row.cs).toBe(240);
    expect(row.gameDurationSec).toBe(1800);
    expect(row.csPerMin).toBe(8.0);
  });

  it("KEEPS the raw values on a remake but WITHHOLDS the rate", () => {
    // The whole point of the null-rate-but-real-raws split: the UI can still
    // honestly render "12 CS in 3:41" without a farming rate that would read
    // as a measurement of the player rather than of the game ending.
    const [row] = buildRecentGames([g({ cs: 12, gameDurationSec: 221 })]);
    expect(row.cs).toBe(12);
    expect(row.gameDurationSec).toBe(221);
    expect(row.csPerMin).toBeNull();
  });

  it("nulls all three on an unbackfilled row", () => {
    const [row] = buildRecentGames([g({ cs: null, gameDurationSec: null })]);
    expect(row.cs).toBeNull();
    expect(row.gameDurationSec).toBeNull();
    expect(row.csPerMin).toBeNull();
  });

  it("defaults to nulls when a caller omits the CS fields entirely", () => {
    const [row] = buildRecentGames([g({})]);
    expect(row.cs).toBeNull();
    expect(row.gameDurationSec).toBeNull();
    expect(row.csPerMin).toBeNull();
  });

  it("does not drop or reorder existing fields", () => {
    const [row] = buildRecentGames([g({ cs: 100, gameDurationSec: 1200 })]);
    expect(row).toMatchObject({ championId: 1, role: 2, win: true, kills: 1, deaths: 2, assists: 3 });
    expect("gameCreation" in row).toBe(false); // unchanged behaviour
  });
});
