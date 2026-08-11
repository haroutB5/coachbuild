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
// Round-B currentPatch fix — resolveDraftPatchLabel() calls the real
// getLatestPatch() (ddragon network probe) if left unmocked; stubbed here
// same as heroStats.test.ts/laneDefaults.test.ts mock @/lib/staticData
// directly for the same reason.
vi.mock("@/lib/draft/patch", () => ({ resolveDraftPatchLabel: vi.fn() }));
// Draft redesign plan §2.3 — computeEnemyAnalysis (new) calls
// getChampionMeta per enemy for suggestedDefense whenever `enemies` is
// non-empty. Mocked here (defaults to null = "no champion meta") so every
// PRE-EXISTING test in this file stays network-free and deterministic;
// draft-recommend-enemyAnalysis.test.ts exercises the real behavior with
// real fixture return values.
vi.mock("@/lib/staticData", () => ({ getChampionMeta: vi.fn() }));

import { getSql } from "@/lib/pro/db";
import { computeDraftRecommend } from "@/lib/draft/recommend";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import { getChampionMeta } from "@/lib/staticData";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

/** Migration 0020: attachPersonalRecords now resolves the ACTIVE linked account
 *  before reading my_matches, so a personal-record test must serve a my_account
 *  row or it gets the (correct, but uninteresting) all-zeros no-account path.
 *  Shape matches lib/mystats/account.ts's own SELECT. */
const MY_ACCOUNT_ROW = { id: 1, riot_id: "MunsterHunter#EUW", puuid: "my-puuid", region: "EUW" };
function isMyAccountQuery(text: string): boolean {
  return text.includes("FROM coachbuild.my_account");
}

/** Every fixture below defaults total_games comfortably above the pool floor
 *  unless a test is specifically exercising it — otherwise every one of these
 *  pre-existing fixtures would get filtered out of the pool entirely by the
 *  audit P1-1 fix.
 *
 *  v0.109.0: the floor is 0.1% of the LANE's own games (score.ts's
 *  POOL_MIN_LANE_SHARE), so on these small fixture pools it collapses to the
 *  absolute backstop, 30. A literal 6000 clears it by a wide margin at any
 *  fixture size and no longer has to be derived from a constant whose meaning
 *  has changed. */
const ABOVE_FLOOR = 6000;

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
    vi.mocked(resolveDraftPatchLabel).mockReset();
    vi.mocked(resolveDraftPatchLabel).mockResolvedValue("16.14"); // matches most fixtures' served patch by default -- no false-positive staleness
    vi.mocked(getChampionMeta).mockReset();
    vi.mocked(getChampionMeta).mockResolvedValue(null); // no champion meta by default -- enemyAnalysis[].suggestedDefense stays null, network-free
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

  it("empty enemies -> pure baseline ranking, laneOppInferred null, with additive lane facts", async () => {
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
    expect(matchupCall).toBeDefined();
    expect(result.laneStats?.map((stat) => stat.champId)).toEqual([1, 2]);
  });

  describe("pool lane-share floor (audit P1-1; recalibrated v0.109.0)", () => {
    it("a low-sample off-role artifact never reaches the ranked output", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          // v0.109.0: the floor is now a SHARE of the lane, so this fixture
          // has to describe a lane rather than two rows — with only Garen
          // present, 0.1% of the lane is 69 games and a 128-game artifact is
          // legitimately a big slice of it. Totals below are shaped like the
          // real measured tier-15 top lane (~601k lane games -> a 601-game
          // floor), which is the population this gate actually runs against.
          return Promise.resolve([
            // Yuumi-shaped: sky-high winrate off a tiny off-role sample.
            champStatsRow({ champ_id: 350, winrate: 0.813, total_games: 128 }),
            champStatsRow({ champ_id: 86, winrate: 0.5, total_games: 137678 }),
            champStatsRow({ champ_id: 122, winrate: 0.51, total_games: 420000 }),
            champStatsRow({ champ_id: 266, winrate: 0.49, total_games: 350000 }),
            champStatsRow({ champ_id: 24, winrate: 0.5, total_games: 295000 }),
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays.some((p) => p.champId === 350)).toBe(false);
      expect(result.plays.map((p) => p.champId).sort((a, b) => a - b)).toEqual([24, 86, 122, 266]);
      // The exclusion is now REPORTED rather than silent — the whole point of
      // the release. Before this, a champion the floor removed simply was not
      // on the page and nothing said so.
      expect(result.meta.poolTotal).toBe(5);
      expect(result.meta.poolIncluded).toBe(4);
      expect(result.meta.poolFloorGames).toBe(601);
    });

    it("reports poolTotal/poolIncluded/poolFloorGames even when nothing is withheld", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 2 })]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.poolTotal).toBe(2);
      expect(result.meta.poolIncluded).toBe(2);
      expect(result.meta.poolFloorGames).toBeGreaterThan(0);
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

    it("does not turn a missing baseline winrate into a fabricated 50% recommendation", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          return Promise.resolve([
            champStatsRow({ champ_id: 350, winrate: null, total_games: 120000 }),
            champStatsRow({ champ_id: 86, winrate: 0.51, total_games: 120000 }),
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays.map((p) => p.champId)).toEqual([86]);
      expect(result.plays.some((p) => p.champId === 350)).toBe(false);
    });

    it("keeps a missing-baseline row in the lane-share denominator without ranking it", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("role = ")) {
          return Promise.resolve([
            champStatsRow({ champ_id: 350, winrate: null, total_games: 100000 }),
            champStatsRow({ champ_id: 86, winrate: 0.51, total_games: 100000 }),
          ]);
        }
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([
            { champ_id: 350, opp_id: 9, wins: 50000, games: 100000 },
            { champ_id: 86, opp_id: 9, wins: 50000, games: 100000 },
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays.map((p) => p.champId)).toEqual([86]);
      expect(result.laneStats?.find((stat) => stat.champId === 86)?.laneShare).toBe(1);
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

  it("laneOpp not among enemies -> falls back to statistical inference (pickrate axis when known)", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("SELECT champ_id, pickrate, total_games")) {
        return Promise.resolve([
          { champ_id: 10, pickrate: 0.02, total_games: 99999 }, // total_games higher, but pickrate axis wins when known
          { champ_id: 11, pickrate: 0.08, total_games: 100 }, // highest pickrate, >2x -- should win
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

  it("no enemy has pickrate OR any lane games -> laneOppInferred stays null", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
      if (text.includes("SELECT champ_id, pickrate, total_games")) {
        return Promise.resolve([{ champ_id: 10, pickrate: null, total_games: 0 }]);
      }
      if (text.includes("FROM coachbuild.draft_champ_stats")) {
        return Promise.resolve([champStatsRow({ champ_id: 1 })]);
      }
      return Promise.resolve([]);
    });
    const result = await computeDraftRecommend({ lane: 0, enemies: [10], laneOpp: null, hover: null });
    expect(result.meta.laneOppInferred).toBeNull();
  });

  describe("total_games playrate-proxy inference (pickrate null — today's real state)", () => {
    // Helper: mock the inference query (the only champ_stats query with
    // `champ_id = ANY`) with the given enemy presence rows, plus a trivial
    // one-champ pool so the rest of the pipeline runs.
    function mockInference(inferenceRows: { champ_id: number; pickrate: number | null; total_games: number | null }[]) {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("SELECT champ_id, pickrate, total_games")) return Promise.resolve(inferenceRows);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]);
      });
    }

    it("user's exact case: [Aatrox, Ahri, Udyr, Jinx] for MID infers Ahri (103) off total_games", async () => {
      // Only Ahri and Aatrox even have a mid champ_stats row; Ahri dominates.
      // Udyr(77)/Jinx(222) have no mid row at all (absent from the result set).
      mockInference([
        { champ_id: 266, pickrate: null, total_games: 3200 }, // Aatrox: niche mid
        { champ_id: 103, pickrate: null, total_games: 84000 }, // Ahri: the mid staple
      ]);
      const result = await computeDraftRecommend({ lane: 2, enemies: [266, 103, 77, 222], laneOpp: null, hover: null });
      expect(result.meta.laneOppInferred).toBe(103);
    });

    it("single enemy with any lane games -> inferred (nothing to be ambiguous with)", async () => {
      mockInference([{ champ_id: 103, pickrate: null, total_games: 500 }]);
      const result = await computeDraftRecommend({ lane: 2, enemies: [103, 266], laneOpp: null, hover: null });
      expect(result.meta.laneOppInferred).toBe(103);
    });

    it("two comparable mid-capable enemies, no other lane signal -> stays null (ambiguous, user taps)", async () => {
      // Ahri(103) and Syndra(134) both genuinely play mid, near-equal presence
      // (runner-up within 2x of leader) -> dominance guard keeps it null.
      mockInference([
        { champ_id: 103, pickrate: null, total_games: 50000 },
        { champ_id: 134, pickrate: null, total_games: 45000 },
      ]);
      const result = await computeDraftRecommend({ lane: 2, enemies: [103, 134], laneOpp: null, hover: null });
      expect(result.meta.laneOppInferred).toBeNull();
    });

    it("dominance ratio exactly 2x -> leader IS inferred (>= boundary)", async () => {
      mockInference([
        { champ_id: 103, pickrate: null, total_games: 40000 }, // exactly 2x the runner-up
        { champ_id: 134, pickrate: null, total_games: 20000 },
      ]);
      const result = await computeDraftRecommend({ lane: 2, enemies: [103, 134], laneOpp: null, hover: null });
      expect(result.meta.laneOppInferred).toBe(103);
    });

    it("tie on presence -> null (neither dominates; ambiguous)", async () => {
      mockInference([
        { champ_id: 134, pickrate: null, total_games: 30000 },
        { champ_id: 103, pickrate: null, total_games: 30000 },
      ]);
      const result = await computeDraftRecommend({ lane: 2, enemies: [134, 103], laneOpp: null, hover: null });
      expect(result.meta.laneOppInferred).toBeNull();
    });
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

  describe("meta.currentPatch (Round-B stale-data honesty fix)", () => {
    it("reflects the live patch resolver, independent of the served patch", async () => {
      vi.mocked(resolveDraftPatchLabel).mockResolvedValue("16.15");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.patch).toBe("16.14"); // served -- what's actually ingested
      expect(result.meta.currentPatch).toBe("16.15"); // live -- what the rest of the app considers current
    });

    it("also populated on the pending path (patch ingested, but this lane is empty)", async () => {
      vi.mocked(resolveDraftPatchLabel).mockResolvedValue("16.15");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.pending).toBe(true);
      expect(result.meta.currentPatch).toBe("16.15");
    });

    it("degrades to null (not a thrown error) if the resolver itself fails", async () => {
      vi.mocked(resolveDraftPatchLabel).mockRejectedValue(new Error("network"));
      mockSql.mockImplementation(() => Promise.resolve([]));
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.currentPatch).toBeNull();
      expect(result.pending).toBe(true); // unrelated to the resolver failure -- still driven by patch-ingestion state
    });
  });

  describe("meta.ingestHealthy / ingestLastError (2026-07-31 audit P2, #2)", () => {
    function mockWithHealth(healthRows: unknown[]) {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.ingest_health")) return Promise.resolve(healthRows);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]);
      });
    }

    it("surfaces a failed last run", async () => {
      mockWithHealth([{ ingest: "draft", last_run_at: "x", last_success_at: "y", ok: false, last_error: "u.gg 403 on 12 champs", last_error_at: "x" }]);
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.ingestHealthy).toBe(false);
      expect(result.meta.ingestLastError).toBe("u.gg 403 on 12 champs");
    });

    it("surfaces a healthy last run with no error", async () => {
      mockWithHealth([{ ingest: "draft", last_run_at: "x", last_success_at: "x", ok: true, last_error: null, last_error_at: null }]);
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.ingestHealthy).toBe(true);
      expect(result.meta.ingestLastError).toBeNull();
    });

    it("null (unknown), never a fabricated false, when no health row exists yet", async () => {
      mockWithHealth([]);
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.ingestHealthy).toBeNull();
      expect(result.meta.ingestLastError).toBeNull();
    });

    it("degrades to unknown (not a thrown error) if the health read itself fails", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.ingest_health")) return Promise.reject(new Error("db hiccup"));
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.ingestHealthy).toBeNull();
    });

    it("also populated on the pending path", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.ingest_health")) {
          return Promise.resolve([{ ingest: "draft", last_run_at: "x", last_success_at: null, ok: false, last_error: "boom", last_error_at: "x" }]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.pending).toBe(true);
      expect(result.meta.ingestHealthy).toBe(false);
      expect(result.meta.ingestLastError).toBe("boom");
    });
  });

  describe("meta.fetchedAt (P2 fix, 2026-07-31 audit — data age, not request time)", () => {
    it("reflects MAX(ingested_at) from the served pool rows, not the request clock", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return Promise.resolve([
            { ...champStatsRow({ champ_id: 1 }), latest_ingested_at: "2026-07-28T08:59:00.000Z" },
          ]);
        }
        return Promise.resolve([]);
      });
      const before = Date.now();
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.meta.fetchedAt).toBe("2026-07-28T08:59:00.000Z");
      // Sanity: the real ingested_at is well before "now" -- proves this isn't
      // accidentally still the request-time value from a broken mock.
      expect(new Date(result.meta.fetchedAt).getTime()).toBeLessThan(before);
    });

    it("falls back to request time on the pending path (no pool rows to source freshness from)", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        return Promise.resolve([]);
      });
      const before = Date.now();
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.pending).toBe(true);
      expect(new Date(result.meta.fetchedAt).getTime()).toBeGreaterThanOrEqual(before);
    });
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

  describe("personal-record decoration (My Stats backend, additive, DISPLAY ONLY)", () => {
    it("plays are decorated with personalOverall (never null) and personal (null with no laneOpp)", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (isMyAccountQuery(text)) return Promise.resolve([MY_ACCOUNT_ROW]);
        if (text.includes("FROM coachbuild.my_matches")) {
          return Promise.resolve([
            { champion_id: 1, opp_champion_id: 55, win: true },
            { champion_id: 1, opp_champion_id: 55, win: false },
            { champion_id: 1, opp_champion_id: 77, win: true }, // different opponent -- still counts toward personalOverall
          ]);
        }
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]);
      });
      // enemies empty -> laneOppInferred is null (no lane opponent resolved)
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays).toHaveLength(1);
      expect(result.plays[0].personalOverall).toEqual({ games: 3, wins: 2 });
      expect(result.plays[0].personal).toBeNull(); // no laneOpp resolved -- nothing to compare against
    });

    it("personal is populated (even {games:0,wins:0}) once a laneOpp IS resolved", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (isMyAccountQuery(text)) return Promise.resolve([MY_ACCOUNT_ROW]);
        if (text.includes("FROM coachbuild.my_matches")) {
          return Promise.resolve([
            { champion_id: 1, opp_champion_id: 7, win: true }, // matches the resolved laneOpp (7)
            { champion_id: 1, opp_champion_id: 999, win: false }, // different opponent
            { champion_id: 2, opp_champion_id: 7, win: false }, // different champion -- doesn't leak into champ 1's record
          ]);
        }
        if (text.includes("FROM coachbuild.draft_champ_stats") && text.includes("champ_id = ANY")) {
          return Promise.resolve([]); // inference query -- irrelevant, laneOpp is explicit
        }
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return Promise.resolve([champStatsRow({ champ_id: 1 }), champStatsRow({ champ_id: 2 })]);
        }
        // v0.37.4: a laneOpp IS resolved (7), so splitPlaysBySampleSize now
        // requires real evidence vs 7 to keep a candidate on EITHER list --
        // both champs need a >=1000-game row here to land in `plays` (main),
        // same as this test's pre-v0.37.4 assumption, so its assertions
        // below (looking specifically in `result.plays`) stay meaningful.
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([
            { champ_id: 1, opp_id: 7, wins: 5500, games: 10000 },
            { champ_id: 2, opp_id: 7, wins: 4800, games: 10000 },
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
      expect(result.meta.laneOppInferred).toBe(7);
      const champ1 = result.plays.find((p) => p.champId === 1)!;
      expect(champ1.personal).toEqual({ games: 1, wins: 1 });
      expect(champ1.personalOverall).toEqual({ games: 2, wins: 1 }); // both my_matches rows for champ 1
      const champ2 = result.plays.find((p) => p.champId === 2)!;
      expect(champ2.personal).toEqual({ games: 1, wins: 0 }); // champ2's own row vs opp 7, not leaked from champ1
    });

    it("no rows at all -> every play still gets personalOverall {games:0,wins:0}, never crashes/omits the field", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        return Promise.resolve([]); // my_matches query -- empty, table might not be migrated yet
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.plays[0].personalOverall).toEqual({ games: 0, wins: 0 });
      expect(result.plays[0].personal).toBeNull();
    });

    it("empty pool (pending) -> no my_matches query is ever issued", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));
      await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      const myMatchesCall = mockSql.mock.calls.find(([s]) => sqlText(s as TemplateStringsArray).includes("FROM coachbuild.my_matches"));
      expect(myMatchesCall).toBeUndefined();
    });
  });

  describe("v0.37.4 sample-size split (plays = main, potentialPlays = new)", () => {
    it("no laneOpp resolved -> potentialPlays is [], plays unchanged (existing 5000-total-games pool floor governs)", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return Promise.resolve([champStatsRow({ champ_id: 1, winrate: 0.55 }), champStatsRow({ champ_id: 2, winrate: 0.52 })]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.potentialPlays).toEqual([]);
      expect(result.plays.map((p) => p.champId)).toEqual([1, 2]);
    });

    it("laneOpp resolved: n>=1000 vs opponent -> plays (main); n<1000 (but >=30) -> potentialPlays", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return Promise.resolve([
            champStatsRow({ champ_id: 1, winrate: 0.55 }), // will have n=1000 vs opp -> main
            champStatsRow({ champ_id: 2, winrate: 0.6 }), // will have n=100 vs opp -> potential
          ]);
        }
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([
            { champ_id: 1, opp_id: 7, wins: 550, games: 1000 },
            // v0.109.0: n=500 is now a MAIN sample (floor 125, was 1000).
            { champ_id: 2, opp_id: 7, wins: 60, games: 100 },
          ]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
      expect(result.plays.map((p) => p.champId)).toEqual([1]);
      expect(result.potentialPlays.map((p) => p.champId)).toEqual([2]);
    });

    it("laneOpp resolved but a pool candidate has NO matchup row vs it -> excluded from BOTH lists", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) {
          return Promise.resolve([
            champStatsRow({ champ_id: 1 }), // has a row vs 7 -> listed
            champStatsRow({ champ_id: 2 }), // no row vs 7 at all -> excluded
          ]);
        }
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([{ champ_id: 1, opp_id: 7, wins: 5500, games: 10000 }]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
      const allListed = [...result.plays, ...result.potentialPlays].map((p) => p.champId);
      expect(allListed).toEqual([1]);
      expect(allListed).not.toContain(2);
    });

    it("potentialPlays candidates are ALSO decorated with personal-record fields (same as plays)", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([{ champ_id: 1, opp_id: 7, wins: 60, games: 100 }]); // n=100 -> potential (floor is 125)
        }
        if (isMyAccountQuery(text)) return Promise.resolve([MY_ACCOUNT_ROW]);
        if (text.includes("FROM coachbuild.my_matches")) {
          return Promise.resolve([{ champion_id: 1, opp_champion_id: 7, win: true }]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
      expect(result.plays).toEqual([]);
      expect(result.potentialPlays).toHaveLength(1);
      expect(result.potentialPlays[0].personal).toEqual({ games: 1, wins: 1 });
    });

    it("empty potential when every eligible candidate clears the main sample floor", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.14", champs: 150 }]);
        if (text.includes("FROM coachbuild.draft_champ_stats")) return Promise.resolve([champStatsRow({ champ_id: 1 })]);
        if (text.includes("FROM coachbuild.draft_matchup")) {
          return Promise.resolve([{ champ_id: 1, opp_id: 7, wins: 5500, games: 10000 }]);
        }
        return Promise.resolve([]);
      });
      const result = await computeDraftRecommend({ lane: 0, enemies: [7], laneOpp: 7, hover: null });
      expect(result.plays).toHaveLength(1);
      expect(result.potentialPlays).toEqual([]);
    });

    it("pending path also reports potentialPlays: []", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));
      const result = await computeDraftRecommend({ lane: 0, enemies: [], laneOpp: null, hover: null });
      expect(result.pending).toBe(true);
      expect(result.potentialPlays).toEqual([]);
    });
  });
});
