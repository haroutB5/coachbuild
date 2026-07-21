/**
 * Tests for lib/draft/recommend.ts's DB orchestration: serving-patch
 * resolution (incl. audit P3-1's completeness preference), pending states,
 * laneOpp explicit-vs-inferred resolution, pool/matchup query shaping (incl.
 * audit P1-1's total-games floor), ban baseline lookup. sql mocked
 * content-based (see draft-ingest.test.ts for the same pattern).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

import { getSql } from "@/lib/pro/db";
import { computeDraftRecommend } from "@/lib/draft/recommend";
import { POOL_MIN_TOTAL_GAMES } from "@/lib/draft/score";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

/** Every fixture below defaults total_games comfortably above
 *  POOL_MIN_TOTAL_GAMES unless a test is specifically exercising the floor —
 *  otherwise every one of these pre-existing fixtures would get filtered
 *  out of the pool entirely by the audit P1-1 fix. */
const ABOVE_FLOOR = POOL_MIN_TOTAL_GAMES + 1000;

function champStatsRow(overrides: Partial<{
  champ_id: number;
  winrate: number | null;
  pickrate: number | null;
  banrate: number | null;
  total_games: number | null;
}>) {
  return { champ_id: 1, winrate: 0.5, pickrate: null, banrate: null, total_games: ABOVE_FLOOR, ...overrides };
}

describe("computeDraftRecommend", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("no patch ingested at all -> pending, patch null", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.pending).toBe(true);
    expect(result.meta.patch).toBeNull();
    expect(result.plays).toEqual([]);
    expect(result.bans).toBeNull();
  });

  it("patch present but this lane has zero champ_stats rows -> pending, patch reported", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.pending).toBe(true);
    expect(result.meta.patch).toBe("16.14");
  });

  it("resolveServingPatch query orders by completeness (>=120 champs) then recency (audit P3-1)", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) {
        expect(text).toContain("count(DISTINCT champ_id)");
        expect(text).toContain(">=");
        return Promise.resolve([{ patch: "16.13", champs: 173, latest: "x" }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.meta.patch).toBe("16.13");
  });

  it("empty enemies -> pure baseline ranking, laneOppInferred null, no matchup query needed", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
        return Promise.resolve([
          champStatsRow({ champ_id: 1, winrate: 0.52 }),
          champStatsRow({ champ_id: 2, winrate: 0.55 }),
        ]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.pending).toBeUndefined();
    expect(result.meta.laneOppInferred).toBeNull();
    expect(result.plays.map((p) => p.champId)).toEqual([2, 1]); // sorted by baselineWr desc
    const matchupCall = mockSql.mock.calls.find(([s]) => sqlText(s as TemplateStringsArray).includes("FROM coachbuild.draft_matchup"));
    expect(matchupCall).toBeUndefined();
  });

  describe("pool total-games floor (audit P1-1)", () => {
    it("a low-sample off-role artifact never reaches the ranked output", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          return Promise.resolve([
            // Yuumi-shaped: sky-high winrate off a tiny off-role sample.
            champStatsRow({ champ_id: 350, winrate: 0.813, total_games: 128 }),
            champStatsRow({ champ_id: 86, winrate: 0.5, total_games: 137678 }),
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays.map((p) => p.champId)).toEqual([86]);
      expect(result.plays.some((p) => p.champId === 350)).toBe(false);
    });

    it("pending when every candidate in the lane is below the floor (pool empties out)", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          return Promise.resolve([champStatsRow({ champ_id: 1, total_games: 10 })]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays).toEqual([]);
    });
  });

  it("explicit laneOpp, present in enemies, wins over inference", async () => {
    let enemyStatsQueried = false;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("champ_id = ANY")) {
        enemyStatsQueried = true;
        return Promise.resolve([{ champ_id: 99, pickrate: 0.9 }]); // would win inference if used
      }
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      if (text.includes("FROM coachbuild.draft_matchup")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7, 99], laneOpp: 7, hover: null });
    expect(result.meta.laneOppInferred).toBe(7); // explicit param wins, not the higher-pickrate 99
    expect(enemyStatsQueried).toBe(false); // inference query never even runs when laneOpp is valid
  });

  it("laneOpp not among enemies -> falls back to statistical inference", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("champ_id = ANY") && !text.includes("role = ")) {
        return Promise.resolve([]); // unreachable branch guard, not used
      }
      if (text.includes("SELECT champ_id, pickrate FROM")) {
        return Promise.resolve([
          { champ_id: 10, pickrate: 0.02 },
          { champ_id: 11, pickrate: 0.08 }, // highest -- should win
        ]);
      }
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [10, 11], laneOpp: 999, hover: null });
    expect(result.meta.laneOppInferred).toBe(11);
  });

  it("no enemy has a positive pickrate -> laneOppInferred stays null", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("SELECT champ_id, pickrate FROM")) {
        return Promise.resolve([{ champ_id: 10, pickrate: null }]);
      }
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [10], laneOpp: null, hover: null });
    expect(result.meta.laneOppInferred).toBeNull();
  });

  it("bans null when no hover given", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.bans).toBeNull();
  });

  it("bans empty array when hover champ has no baseline row in this lane", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: 555 });
    expect(result.bans).toEqual([]);
  });

  it("bans computed when hover has a baseline", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 2 })]);
      }
      if (text.includes("FROM coachbuild.draft_matchup")) {
        // hover-vs-pool matchup rows
        return Promise.resolve([{ opp_id: 2, wins: 300, games: 1000 }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: 1 });
    expect(result.bans).not.toBeNull();
    expect(result.bans!.length).toBeGreaterThan(0);
    expect(result.bans![0].confidence).toBeDefined();
    expect(result.bans![0].minGames).toBe(1000); // audit P2-2: real minGames from the matchup row
  });
});
