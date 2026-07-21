/**
 * Draft redesign plan §2.3/§6 — lib/draft/recommend.ts's enemyAnalysis
 * (additive). Covers: lane-opp lookup (winRateVsYou/winRateVsYouGames/
 * laneThreatBand only populate for the resolved lane opponent), null below
 * N_FLOOR (laneThreatBand suppressed while winRateVsYou itself still shows),
 * soft-fail (whole-query DB failure and a single bad champion-meta lookup
 * both degrade gracefully), and that plays/bans are unchanged by this
 * addition. Same sql-mock-by-content-match pattern as draft-recommend.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
vi.mock("@/lib/draft/patch", () => ({ resolveDraftPatchLabel: vi.fn() }));
vi.mock("@/lib/staticData", () => ({ getChampionMeta: vi.fn() }));

import { getSql } from "@/lib/pro/db";
import { computeDraftRecommend } from "@/lib/draft/recommend";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import { getChampionMeta } from "@/lib/staticData";
import { N_FLOOR, POOL_MIN_TOTAL_GAMES } from "@/lib/draft/score";

const ABOVE_FLOOR = POOL_MIN_TOTAL_GAMES + 1000;

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

function champStatsRow(overrides: Partial<{
  champ_id: number;
  winrate: number | null;
  pickrate: number | null;
  banrate: number | null;
  total_games: number | null;
}>) {
  return { champ_id: 1, winrate: 0.5, pickrate: null, banrate: null, total_games: ABOVE_FLOOR, ...overrides };
}

describe("computeDraftRecommend — enemyAnalysis (draft redesign plan §2.3)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    vi.mocked(resolveDraftPatchLabel).mockReset();
    vi.mocked(resolveDraftPatchLabel).mockResolvedValue("16.14");
    vi.mocked(getChampionMeta).mockReset();
    vi.mocked(getChampionMeta).mockResolvedValue(null);
  });

  it("empty enemies -> enemyAnalysis is [], no extra queries issued", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
    expect(result.enemyAnalysis).toEqual([]);
    expect(getChampionMeta).not.toHaveBeenCalled();
  });

  it("pending path -> enemyAnalysis is []", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));
    const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: 1 });
    expect(result.pending).toBe(true);
    expect(result.enemyAnalysis).toEqual([]);
  });

  it("one entry per enemy, isLaneOpponent flags the resolved direct lane opponent only", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 7 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7, 8], laneOpp: 7, hover: null });
    expect(result.enemyAnalysis).toHaveLength(2);
    const opp = result.enemyAnalysis.find((e) => e.champId === 7)!;
    const other = result.enemyAnalysis.find((e) => e.champId === 8)!;
    expect(opp.isLaneOpponent).toBe(true);
    expect(other.isLaneOpponent).toBe(false);
  });

  it("winRateVsYou/winRateVsYouGames/laneThreatBand populate ONLY for the lane opponent, with hover given", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        // lane opponent (7) needs its OWN baseline row in this lane for the
        // laneThreatBand shrunkDelta calc.
        return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 7, winrate: 0.5 })]);
      }
      if (text.includes("SELECT wins, games FROM coachbuild.draft_matchup")) {
        // opponent (7)'s own win rate vs my hovered champion (99): well above
        // N_FLOOR so laneThreatBand resolves (not suppressed).
        return Promise.resolve([{ wins: 600, games: 1000 }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7, 8], laneOpp: 7, hover: 99 });
    const opp = result.enemyAnalysis.find((e) => e.champId === 7)!;
    const other = result.enemyAnalysis.find((e) => e.champId === 8)!;

    expect(opp.winRateVsYou).toBe(0.6);
    expect(opp.winRateVsYouGames).toBe(1000);
    expect(opp.laneThreatBand).not.toBeNull(); // n=1000 >> N_FLOOR -- not suppressed

    expect(other.winRateVsYou).toBeNull();
    expect(other.winRateVsYouGames).toBeNull();
    expect(other.laneThreatBand).toBeNull();
  });

  it("below N_FLOOR: winRateVsYou still shows (with its real n), but laneThreatBand is suppressed (null)", async () => {
    const belowFloorGames = N_FLOOR - 1;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 7, winrate: 0.5 })]);
      }
      if (text.includes("SELECT wins, games FROM coachbuild.draft_matchup")) {
        return Promise.resolve([{ wins: 15, games: belowFloorGames }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: 99 });
    const opp = result.enemyAnalysis.find((e) => e.champId === 7)!;
    expect(opp.winRateVsYou).toBe(15 / belowFloorGames); // REAL, shown with its n -- never gated
    expect(opp.winRateVsYouGames).toBe(belowFloorGames);
    expect(opp.laneThreatBand).toBeNull(); // shrunkDelta returns null below N_FLOOR -> banding suppressed
  });

  it("laneOpp resolved but hover is null -> no matchup query issued, winRateVsYou/laneThreatBand stay null", async () => {
    let matchupQueried = false;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("SELECT wins, games FROM coachbuild.draft_matchup")) {
        matchupQueried = true;
        return Promise.resolve([]);
      }
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
    expect(matchupQueried).toBe(false);
    const opp = result.enemyAnalysis[0];
    expect(opp.winRateVsYou).toBeNull();
    expect(opp.laneThreatBand).toBeNull();
  });

  it("suggestedDefense populates per-enemy from getChampionMeta, independent of lane-opponent status", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      // laneOpp:null + non-empty enemies -> resolveLaneOpponent's inference
      // query fires first; no presence signal -> laneOppInferred stays null
      // (irrelevant to this test's assertions, but keeps the mock honest).
      if (text.includes("SELECT champ_id, pickrate, total_games")) return Promise.resolve([]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      return Promise.resolve([]);
    });
    vi.mocked(getChampionMeta).mockImplementation(async (id: number) => {
      if (id === 8) return { tags: ["Marksman"], difficulty: 4, info: { attack: 9, defense: 3, magic: 1 } };
      return null;
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7, 8], laneOpp: null, hover: null });
    const entry7 = result.enemyAnalysis.find((e) => e.champId === 7)!;
    const entry8 = result.enemyAnalysis.find((e) => e.champId === 8)!;
    expect(entry7.suggestedDefense).toBeNull(); // no meta -> nothing to derive
    expect(entry8.suggestedDefense).toEqual({
      label: "Armor / Plated Steelcaps",
      reason: "their kit leans physical damage",
    });
  });

  it("soft-fail: a single enemy's getChampionMeta rejecting never blanks the other enemies' entries", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("SELECT champ_id, pickrate, total_games")) return Promise.resolve([]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      return Promise.resolve([]);
    });
    vi.mocked(getChampionMeta).mockImplementation(async (id: number) => {
      if (id === 7) throw new Error("ddragon network blip");
      return { tags: ["Support"], difficulty: 3, info: { attack: 2, defense: 6, magic: 4 } };
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7, 8], laneOpp: null, hover: null });
    expect(result.enemyAnalysis).toHaveLength(2);
    const entry7 = result.enemyAnalysis.find((e) => e.champId === 7)!;
    const entry8 = result.enemyAnalysis.find((e) => e.champId === 8)!;
    expect(entry7.suggestedDefense).toBeNull(); // this one's lookup threw -- degrades to null
    expect(entry8.suggestedDefense?.label).toBe("Tenacity (Mercury's Treads)"); // unaffected
  });

  it("soft-fail: the whole-computation DB query throwing degrades enemyAnalysis to [] without touching plays/bans", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      if (text.includes("SELECT wins, games FROM coachbuild.draft_matchup")) {
        throw new Error("connection reset");
      }
      // The PLAYS-ranking matchup query (distinct from the line above) still
      // needs a real row so `plays` has something to report at all.
      if (text.includes("FROM coachbuild.draft_matchup")) {
        return Promise.resolve([{ champ_id: 1, opp_id: 7, wins: 5500, games: 10000 }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: 99 });
    expect(result.enemyAnalysis).toEqual([]);
    expect(result.plays).toHaveLength(1); // unaffected by the enemyAnalysis failure
  });

  it("plays/bans are unaffected by enemyAnalysis's presence (regression sanity)", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1, winrate: 0.55 }), champStatsRow({ champ_id: 7, winrate: 0.5 })]);
      }
      if (text.includes("FROM coachbuild.draft_matchup") && !text.includes("SELECT wins, games")) {
        return Promise.resolve([{ champ_id: 1, opp_id: 7, wins: 5500, games: 10000 }]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
    expect(result.plays.map((p) => p.champId)).toEqual([1]);
    expect(result.bans).toBeNull(); // no hover -- unaffected
  });
});
