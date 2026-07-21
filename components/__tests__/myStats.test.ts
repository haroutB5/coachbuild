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
  MYSTATS_LOW_SAMPLE_THRESHOLD,
  type MyStatsRecord,
  type MyStatsMatchupRecord,
  type IconEntry,
} from "../hextech/myStats";

describe("normalizeMyStatsSummary", () => {
  it("returns null for a non-object payload", () => {
    expect(normalizeMyStatsSummary(null)).toBeNull();
    expect(normalizeMyStatsSummary("<html>error</html>")).toBeNull();
  });

  it("parses a full, well-formed envelope", () => {
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
    expect(result).toEqual({ accountUnresolved: false, season: "", riotId: null, records: [] });
  });

  it("a record missing `role` degrades to -1 (unresolved), not a crash or a fabricated 0", () => {
    const result = normalizeMyStatsSummary({ records: [{ championId: 1, games: 1, wins: 1, winrate: 1 }] });
    expect(result?.records[0].role).toBe(-1);
  });
});

describe("normalizeMyStatsMatchups", () => {
  it("returns null for a non-object payload", () => {
    expect(normalizeMyStatsMatchups(undefined)).toBeNull();
  });

  it("parses a full envelope and drops a malformed matchup entry", () => {
    const result = normalizeMyStatsMatchups({
      accountUnresolved: false,
      season: "Season 2026",
      championId: 112,
      matchups: [
        { oppChampionId: 99, games: 8, wins: 3, winrate: 0.375 },
        { games: 2 }, // missing oppChampionId
      ],
    });
    expect(result?.matchups).toEqual([{ oppChampionId: 99, games: 8, wins: 3, winrate: 0.375 }]);
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

  it("fetchMyStatsMatchups hits the URL with championId encoded", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    await fetchMyStatsMatchups(112, { fetchImpl });
    expect(calledUrl).toBe("/api/mystats/matchups?championId=112");
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
