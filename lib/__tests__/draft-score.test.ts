/**
 * Exhaustive test list per _research/draft-feature-plan.md §3 + audit
 * P1-1/P2-2 patches (2026-07-21): shrink anchors, floor boundary, missing-row
 * omission, empty-enemies baseline ranking (now with HONEST confidence/
 * minGames from the candidate's own totalGames), pool cutoff (pickrate +
 * the new total-games playrate-proxy floor), weight ordering, ban
 * clamp+presence+confidence, determinism.
 */
import { describe, it, expect } from "vitest";
import {
  K,
  N_FLOOR,
  W_DIRECT,
  W_OFFLANE,
  POOL_MIN_PICKRATE,
  POOL_MIN_TOTAL_GAMES,
  shrinkFactor,
  shrunkDelta,
  filterPoolByPickrate,
  filterPoolByTotalGames,
  rankPlays,
  rankBans,
  type ChampBaseline,
  type MatchupRow,
  type EnemyInput,
} from "@/lib/draft/score";

/** Default totalGames is well above BOTH K (200) and POOL_MIN_TOTAL_GAMES
 *  (5000) so existing tests that don't care about baseline-sample behavior
 *  keep getting confidence:"normal" unless they explicitly override it. */
function baseline(
  champId: number,
  baselineWr: number,
  pickrate: number | null = null,
  banrate: number | null = null,
  totalGames = 10000
): ChampBaseline {
  return { champId, baselineWr, pickrate, banrate, totalGames };
}

function matchupMap(entries: Array<[number, Map<number, MatchupRow>]>): Map<number, Map<number, MatchupRow>> {
  return new Map(entries);
}

describe("shrinkFactor anchors", () => {
  it("n=20 -> ~9%", () => {
    expect(shrinkFactor(20)).toBeCloseTo(20 / 220, 5);
    expect(shrinkFactor(20)).toBeCloseTo(0.0909, 3);
  });
  it("n=2000 -> ~91%", () => {
    expect(shrinkFactor(2000)).toBeCloseTo(2000 / 2200, 5);
    expect(shrinkFactor(2000)).toBeCloseTo(0.9091, 3);
  });
});

describe("shrunkDelta floor boundary", () => {
  it("n=29 (below N_FLOOR=30) -> null", () => {
    expect(N_FLOOR).toBe(30);
    expect(shrunkDelta(0.55, 0.5, 29)).toBeNull();
  });
  it("n=30 (at N_FLOOR) -> a real number", () => {
    const d = shrunkDelta(0.55, 0.5, 30);
    expect(d).not.toBeNull();
    expect(d).toBeCloseTo((0.55 - 0.5) * shrinkFactor(30), 6);
  });
});

describe("rankPlays", () => {
  it("missing matchup row -> term omitted, not zeroed (falls back to baseline)", () => {
    const pool = [baseline(1, 0.52), baseline(2, 0.5)];
    const enemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    // champ 1 has no row at all vs 99; champ 2 has a row.
    const matchups = matchupMap([
      [2, new Map([[99, { wins: 600, games: 1000 }]])], // 60% wr, strong positive delta
    ]);
    const results = rankPlays(pool, matchups, enemies);
    const r1 = results.find((r) => r.champId === 1)!;
    const r2 = results.find((r) => r.champId === 2)!;
    expect(r1.score).toBeCloseTo(0.52, 6); // pure baseline -- no term contributed
    expect(r1.minGames).toBe(10000); // audit P1-1: seeded from the candidate's own totalGames, never null
    expect(r1.confidence).toBe("normal");
    expect(r2.score).toBeGreaterThan(r2.champId ? 0.5 : 0); // sanity
    expect(r2.score).toBeGreaterThan(0.5);
  });

  it("empty enemies -> pure baseline meta ranking with HONEST confidence/minGames (audit P1-1)", () => {
    const pool = [baseline(3, 0.5), baseline(1, 0.55), baseline(2, 0.55, null, null, 50)];
    const results = rankPlays(pool, matchupMap([]), []);
    expect(results.map((r) => r.champId)).toEqual([1, 2, 3]); // 0.55 ties broken by champId asc, then 0.5
    const r1 = results.find((r) => r.champId === 1)!;
    const r3 = results.find((r) => r.champId === 3)!;
    const r2 = results.find((r) => r.champId === 2)!;
    expect(r1.winVsLaneOpp).toBeNull();
    expect(r3.winVsLaneOpp).toBeNull();
    expect(r1.confidence).toBe("normal"); // totalGames=10000 >= K
    expect(r1.minGames).toBe(10000);
    expect(r3.minGames).toBe(10000);
    expect(r2.confidence).toBe("low"); // totalGames=50 < K=200 -- a REAL low-sample champion
    expect(r2.minGames).toBe(50);
    for (const r of results) {
      expect(r.score).toBe(pool.find((c) => c.champId === r.champId)!.baselineWr);
    }
  });

  it("weight ordering: direct-lane opponent term outweighs an identical off-lane term", () => {
    const enemyRow: MatchupRow = { wins: 600, games: 1000 }; // 60% wr, +delta vs 50% baseline
    const poolDirect = [baseline(1, 0.5)];
    const poolOfflane = [baseline(1, 0.5)];
    const directEnemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    const offlaneEnemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: false }];
    const matchups = matchupMap([[1, new Map([[99, enemyRow]])]]);

    const directResult = rankPlays(poolDirect, matchups, directEnemies)[0];
    const offlaneResult = rankPlays(poolOfflane, matchups, offlaneEnemies)[0];

    const directDelta = directResult.score - 0.5;
    const offlaneDelta = offlaneResult.score - 0.5;
    expect(directDelta).toBeGreaterThan(offlaneDelta);
    expect(directDelta).toBeCloseTo(offlaneDelta * (W_DIRECT / W_OFFLANE), 6);
  });

  it("winVsLaneOpp is the raw (unshrunk) winrate vs the tagged direct opponent", () => {
    const pool = [baseline(1, 0.5)];
    const enemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    const matchups = matchupMap([[1, new Map([[99, { wins: 650, games: 1000 }]])]]);
    const result = rankPlays(pool, matchups, enemies)[0];
    expect(result.winVsLaneOpp).toBeCloseTo(0.65, 6);
  });

  it("confidence is low iff a CONTRIBUTING term has n<K, ignoring omitted (n<N_FLOOR) terms", () => {
    const pool = [baseline(1, 0.5)]; // totalGames=10000, well above K -- baseline alone wouldn't trip low confidence
    // one enemy below N_FLOOR (omitted), one enemy between N_FLOOR and K (contributes, low confidence)
    const enemies: EnemyInput[] = [
      { champId: 10, isDirectLaneOpp: false },
      { champId: 11, isDirectLaneOpp: false },
    ];
    const matchups = matchupMap([
      [
        1,
        new Map([
          [10, { wins: 10, games: 20 }], // below N_FLOOR -- omitted entirely
          [11, { wins: 55, games: 100 }], // contributes, n=100 < K=200 -> low confidence
        ]),
      ],
    ]);
    const result = rankPlays(pool, matchups, enemies)[0];
    expect(result.confidence).toBe("low");
    expect(result.minGames).toBe(100); // only the contributing term counts (lower than the 10000 baseline)
  });

  it("baseline totalGames below K makes confidence low even with zero enemy terms", () => {
    const pool = [baseline(1, 0.5, null, null, 199)]; // just under K=200
    const result = rankPlays(pool, matchupMap([]), [])[0];
    expect(result.confidence).toBe("low");
    expect(result.minGames).toBe(199);
  });

  it("determinism: identical inputs produce identical output on repeat calls", () => {
    const pool = [baseline(3, 0.51), baseline(1, 0.55), baseline(2, 0.55), baseline(4, 0.49)];
    const enemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    const matchups = matchupMap([
      [1, new Map([[99, { wins: 520, games: 1000 }]])],
      [2, new Map([[99, { wins: 480, games: 1000 }]])],
    ]);
    const run1 = rankPlays(pool, matchups, enemies);
    const run2 = rankPlays(pool, matchups, enemies);
    expect(run2).toEqual(run1);
  });

  it("returns at most the top 10", () => {
    const pool = Array.from({ length: 15 }, (_, i) => baseline(i + 1, 0.5 + i * 0.001));
    const results = rankPlays(pool, matchupMap([]), []);
    expect(results).toHaveLength(10);
  });
});

describe("filterPoolByPickrate (pool cutoff)", () => {
  it("drops known pickrate at/below the cutoff, keeps above and unknown(null)", () => {
    const candidates = [
      baseline(1, 0.5, 0.001), // below cutoff -- dropped
      baseline(2, 0.5, POOL_MIN_PICKRATE), // exactly at cutoff -- dropped (strictly greater required)
      baseline(3, 0.5, 0.01), // above cutoff -- kept
      baseline(4, 0.5, null), // unknown -- kept (never excluded on unknown data)
    ];
    const kept = filterPoolByPickrate(candidates).map((c) => c.champId);
    expect(kept).toEqual([3, 4]);
  });
});

describe("filterPoolByTotalGames (audit P1-1 playrate-proxy pool floor)", () => {
  it("drops below the floor, keeps at/above it -- unconditional, never null-exempted", () => {
    const candidates = [
      baseline(1, 0.5, null, null, 4999), // just under -- dropped
      baseline(2, 0.5, null, null, POOL_MIN_TOTAL_GAMES), // exactly at floor -- kept (>=)
      baseline(3, 0.5, null, null, 50000), // well above -- kept
      baseline(4, 0.5, null, null, 0), // no data at all -- dropped
    ];
    const kept = filterPoolByTotalGames(candidates).map((c) => c.champId);
    expect(kept).toEqual([2, 3]);
  });

  it("live-shape regression: an off-role one-trick artifact (low totalGames) never survives the floor", () => {
    // e.g. Yuumi/Bard/Braum showing up in a Top pool off a 128-game sample --
    // the exact class of artifact the audit's live repro found.
    const offRoleArtifact = baseline(350, 0.813, null, null, 128); // Yuumi-shaped
    const realLaneStaple = baseline(86, 0.5, null, null, 137678); // Garen-shaped
    const kept = filterPoolByTotalGames([offRoleArtifact, realLaneStaple]).map((c) => c.champId);
    expect(kept).toEqual([86]);
  });
});

describe("rankBans", () => {
  it("clamps a negative disadvantage (hovered champ is favored) to 0", () => {
    const hoverBaseline = 0.5;
    const pool = [baseline(99, 0.5, 0.1, 0.05)];
    // hovered champ WINS 65% vs t -- (baseline-mWr) is negative -> clamp to 0
    const matchups = new Map<number, MatchupRow>([[99, { wins: 650, games: 1000 }]]);
    const results = rankBans(1, hoverBaseline, pool, matchups);
    expect(results[0].score).toBe(0);
  });

  it("presence multiplies a real disadvantage", () => {
    const hoverBaseline = 0.5;
    // hovered champ LOSES 65% of the time vs t -- real disadvantage
    const matchups = new Map<number, MatchupRow>([
      [10, { wins: 350, games: 1000 }],
      [11, { wins: 350, games: 1000 }],
    ]);
    const highPresence = baseline(10, 0.5, 0.2, 0.1);
    const lowPresence = baseline(11, 0.5, 0.01, 0.01);
    const results = rankBans(1, hoverBaseline, [highPresence, lowPresence], matchups);
    const high = results.find((r) => r.champId === 10)!;
    const low = results.find((r) => r.champId === 11)!;
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("excludes the hovered champion from its own ban pool", () => {
    const pool = [baseline(1, 0.5, 0.1), baseline(2, 0.5, 0.1)];
    const matchups = new Map<number, MatchupRow>([[2, { wins: 350, games: 1000 }]]);
    const results = rankBans(1, 0.5, pool, matchups);
    expect(results.some((r) => r.champId === 1)).toBe(false);
  });

  it("returns at most the top 5, stable champId tiebreak on equal score", () => {
    const pool = Array.from({ length: 8 }, (_, i) => baseline(i + 1, 0.5, null, null));
    const results = rankBans(999, 0.5, pool, new Map());
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.score === 0)).toBe(true);
    expect(results.map((r) => r.champId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("K constant sanity (used by both play and ban shrink math)", () => {
    expect(K).toBe(200);
  });

  describe("confidence/minGames (audit P2-2 -- previously absent entirely)", () => {
    it("real matchup row -> minGames = row.games, confidence from n<K", () => {
      const pool = [baseline(10, 0.5), baseline(11, 0.5)];
      const matchups = new Map<number, MatchupRow>([
        [10, { wins: 100, games: 300 }], // n=300 >= K -- normal
        [11, { wins: 30, games: 90 }], // n=90 < K -- low
      ]);
      const results = rankBans(1, 0.5, pool, matchups);
      const r10 = results.find((r) => r.champId === 10)!;
      const r11 = results.find((r) => r.champId === 11)!;
      expect(r10.minGames).toBe(300);
      expect(r10.confidence).toBe("normal");
      expect(r11.minGames).toBe(90);
      expect(r11.confidence).toBe("low");
    });

    it("no matchup row at all -> minGames null, confidence low (never a fabricated 0/normal)", () => {
      const pool = [baseline(10, 0.5)];
      const results = rankBans(1, 0.5, pool, new Map());
      expect(results[0].minGames).toBeNull();
      expect(results[0].confidence).toBe("low");
    });
  });
});
