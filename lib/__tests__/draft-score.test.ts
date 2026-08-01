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
  PLAY_MAIN_TOP_N,
  PLAY_POTENTIAL_TOP_N,
  PLAY_MAIN_SAMPLE_FLOOR,
  BAN_MIN_MATCHUP_GAMES,
  shrinkFactor,
  shrunkDelta,
  filterPoolByPickrate,
  filterPoolByTotalGames,
  rankPlays,
  rankBans,
  splitPlaysBySampleSize,
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

  it("winVsLaneOppGames (v0.37.4) is the direct-opponent row's own games, independent of minGames", () => {
    const pool = [baseline(1, 0.5)];
    // TWO enemies: the direct opponent (99, 1000 games) and an off-lane
    // enemy with a SMALLER game count (11, 50 games) -- minGames pulls down
    // to 50 (the smallest contributing term), but winVsLaneOppGames must
    // stay pinned to the direct opponent's OWN 1000, proving the two fields
    // are genuinely independent rather than aliases of each other.
    const enemies: EnemyInput[] = [
      { champId: 99, isDirectLaneOpp: true },
      { champId: 11, isDirectLaneOpp: false },
    ];
    const matchups = matchupMap([
      [1, new Map([[99, { wins: 650, games: 1000 }], [11, { wins: 30, games: 50 }]])],
    ]);
    const result = rankPlays(pool, matchups, enemies)[0];
    expect(result.winVsLaneOppGames).toBe(1000);
    expect(result.minGames).toBe(50);
  });

  it("winVsLaneOppGames is null under the same conditions as winVsLaneOpp (no direct opponent, or no row)", () => {
    const pool = [baseline(1, 0.5), baseline(2, 0.5)];
    // champ 1: no direct opponent tagged at all.
    const noOppResult = rankPlays(pool, matchupMap([]), [])[0];
    expect(noOppResult.winVsLaneOpp).toBeNull();
    expect(noOppResult.winVsLaneOppGames).toBeNull();
    // champ 2: direct opponent tagged, but no matchup row exists for it.
    const enemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    const missingRowResult = rankPlays([baseline(2, 0.5)], matchupMap([]), enemies)[0];
    expect(missingRowResult.winVsLaneOpp).toBeNull();
    expect(missingRowResult.winVsLaneOppGames).toBeNull();
  });

  it("v0.39.1 SUPERSEDES the old 'ANY contributing term' rule: a thin OFF-LANE term does NOT flip confidence low", () => {
    // Original audit-P1-1 contract (pre-v0.39.1) was "confidence is low iff a
    // CONTRIBUTING term has n<K, ignoring omitted (n<N_FLOOR) terms" -- that
    // included off-lane (0.2-weight) terms. Prod (2026-07-21) showed exactly
    // why that's wrong: every /draft main-list row badged "LOW SAMPLE" even
    // with huge direct-opponent samples (Sylas n=24030), because SOME
    // 0.2-weight off-lane matchup (e.g. Udyr-mid) was always thin somewhere
    // in a 4-enemy comp. The off-lane term's already-shrunk contribution to
    // `score` is near zero -- flagging the row over it overstated the exact
    // noise the shrink math neutralizes. New contract: only the DOMINANT
    // term (direct-opp, or baseline when no direct opp) can flip this flag.
    const pool = [baseline(1, 0.5)]; // totalGames=10000, well above K
    const enemies: EnemyInput[] = [
      { champId: 10, isDirectLaneOpp: false },
      { champId: 11, isDirectLaneOpp: false },
    ];
    const matchups = matchupMap([
      [
        1,
        new Map([
          [10, { wins: 10, games: 20 }], // below N_FLOOR -- omitted entirely
          [11, { wins: 55, games: 100 }], // contributes to score (n=100 >= N_FLOOR), but OFF-LANE -- must NOT trip low confidence
        ]),
      ],
    ]);
    const result = rankPlays(pool, matchups, enemies)[0];
    expect(result.confidence).toBe("normal"); // was "low" under the pre-v0.39.1 contract
    expect(result.minGames).toBe(100); // minGames still tracks the smallest contributing term, unchanged
  });

  it("main-tier row: fat direct-opp sample + thin off-lane term -> confidence normal (v0.39.1)", () => {
    const pool = [baseline(1, 0.5, null, null, 24030)]; // Sylas-shaped: huge baseline sample too
    const enemies: EnemyInput[] = [
      { champId: 999, isDirectLaneOpp: true }, // the resolved lane opponent, e.g. Ahri
      { champId: 42, isDirectLaneOpp: false }, // e.g. Udyr-mid -- barely played in this lane
    ];
    const matchups = matchupMap([
      [
        1,
        new Map([
          [999, { wins: 12500, games: 24030 }], // direct opp: n=24030, well above K -- dominant term is fat
          [42, { wins: 60, games: 100 }], // off-lane: n=100 < K -- thin, but must NOT dominate the badge
        ]),
      ],
    ]);
    const result = rankPlays(pool, matchups, enemies)[0];
    expect(result.confidence).toBe("normal");
  });

  it("potential-tier row: thin direct-opp sample (n<K) -> confidence low, that's the badge's honest job (v0.39.1)", () => {
    const pool = [baseline(1, 0.5)]; // baseline totalGames=10000, well above K
    const enemies: EnemyInput[] = [{ champId: 999, isDirectLaneOpp: true }];
    // n=150 clears N_FLOOR (30) so it's a real potential-tier row (< PLAY_MAIN_SAMPLE_FLOOR=1000),
    // but is itself below K=200 -- the direct-opp term IS this row's dominant (1.0-weight) evidence.
    const matchups = matchupMap([[1, new Map([[999, { wins: 80, games: 150 }]])]]);
    const { potential } = splitPlaysBySampleSize(pool, matchups, enemies);
    expect(potential.map((p) => p.champId)).toEqual([1]);
    expect(potential[0].confidence).toBe("low");
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

describe("splitPlaysBySampleSize (v0.37.4 sample-size split)", () => {
  /** One direct-lane-opponent enemy (champId 999) -- the only shape this
   *  feature partitions on. `n` is that candidate's OWN matchup games vs
   *  999; wins is fixed at 55% so scoring never ties. */
  function directOnly(): EnemyInput[] {
    return [{ champId: 999, isDirectLaneOpp: true }];
  }
  function row(n: number, wr = 0.55): MatchupRow {
    return { wins: Math.round(n * wr), games: n };
  }

  it("partition boundary: n=999 -> potential, n=1000 -> main", () => {
    const pool = [baseline(1, 0.5), baseline(2, 0.5)];
    const matchups = matchupMap([
      [1, new Map([[999, row(999)]])],
      [2, new Map([[999, row(1000)]])],
    ]);
    const { main, potential } = splitPlaysBySampleSize(pool, matchups, directOnly());
    expect(main.map((p) => p.champId)).toEqual([2]);
    expect(potential.map((p) => p.champId)).toEqual([1]);
  });

  it("no direct lane opponent resolved -> degrades to rankPlays' own (unchanged) output, potential always []", () => {
    const pool = [baseline(1, 0.55), baseline(2, 0.52), baseline(3, 0.5)];
    const enemies: EnemyInput[] = [{ champId: 999, isDirectLaneOpp: false }]; // off-lane only, no direct tag
    const matchups = matchupMap([[1, new Map([[999, row(5000)]])]]);

    const rankPlaysResult = rankPlays(pool, matchups, enemies);
    const split = splitPlaysBySampleSize(pool, matchups, enemies);
    expect(split.main).toEqual(rankPlaysResult);
    expect(split.potential).toEqual([]);

    // Same for genuinely empty enemies.
    const splitEmpty = splitPlaysBySampleSize(pool, matchupMap([]), []);
    expect(splitEmpty.main).toEqual(rankPlays(pool, matchupMap([]), []));
    expect(splitEmpty.potential).toEqual([]);
  });

  it("no evidence vs the direct opponent (no row, or n < N_FLOOR) -> excluded from BOTH lists", () => {
    const pool = [baseline(1, 0.5), baseline(2, 0.5), baseline(3, 0.5)];
    const matchups = matchupMap([
      // champ 1: no row at all vs 999.
      // champ 2: row exists but below N_FLOOR (30).
      [2, new Map([[999, row(29)]])],
      // champ 3: clears N_FLOOR -> included (potential, since n<1000).
      [3, new Map([[999, row(500)]])],
    ]);
    const { main, potential } = splitPlaysBySampleSize(pool, matchups, directOnly());
    const allListed = [...main, ...potential].map((p) => p.champId);
    expect(allListed).not.toContain(1);
    expect(allListed).not.toContain(2);
    expect(allListed).toContain(3);
  });

  it("empty potential when every eligible candidate clears the main sample floor", () => {
    const pool = [baseline(1, 0.5), baseline(2, 0.5)];
    const matchups = matchupMap([
      [1, new Map([[999, row(5000)]])],
      [2, new Map([[999, row(2000)]])],
    ]);
    const { main, potential } = splitPlaysBySampleSize(pool, matchups, directOnly());
    expect(main.map((p) => p.champId).sort()).toEqual([1, 2]);
    expect(potential).toEqual([]);
  });

  it("main is capped at PLAY_MAIN_TOP_N (10), potential at PLAY_POTENTIAL_TOP_N (5), independently", () => {
    const mainPool = Array.from({ length: 15 }, (_, i) => baseline(i + 1, 0.5 + i * 0.001));
    const mainMatchups = matchupMap(mainPool.map((c) => [c.champId, new Map([[999, row(5000)]])] as const));
    const { main } = splitPlaysBySampleSize(mainPool, mainMatchups, directOnly());
    expect(main).toHaveLength(PLAY_MAIN_TOP_N);

    const potentialPool = Array.from({ length: 8 }, (_, i) => baseline(i + 1, 0.5 + i * 0.001));
    const potentialMatchups = matchupMap(potentialPool.map((c) => [c.champId, new Map([[999, row(500)]])] as const));
    const { potential } = splitPlaysBySampleSize(potentialPool, potentialMatchups, directOnly());
    expect(potential).toHaveLength(PLAY_POTENTIAL_TOP_N);
  });

  it("same score formula in both buckets -- a potential-bucket score is computed identically to a main-bucket one", () => {
    const pool = [baseline(1, 0.5, null, null, 10000)];
    const matchups = matchupMap([[1, new Map([[999, row(500, 0.6)]])]]);
    const { potential } = splitPlaysBySampleSize(pool, matchups, directOnly());
    const rankPlaysEquivalent = rankPlays(pool, matchups, [{ champId: 999, isDirectLaneOpp: true }]);
    expect(potential[0].score).toBeCloseTo(rankPlaysEquivalent[0].score, 10);
  });

  it("PLAY_MAIN_SAMPLE_FLOOR is 1000 (pinned -- the exact threshold the feature spec calls out)", () => {
    expect(PLAY_MAIN_SAMPLE_FLOOR).toBe(1000);
  });
});

describe("filterPoolByPickrate (pool cutoff)", () => {
  it("drops known pickrate at/below the cutoff, keeps above and unknown(null)", () => {
    const candidates = [
      baseline(1, 0.5, 0.001), // below cutoff -- dropped
      baseline(2, 0.5, POOL_MIN_PICKRATE), // exactly at cutoff -- dropped (strictly greater required)
      baseline(3, 0.5, 0.02), // above cutoff -- kept
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

  it("winVsYou is the TARGET's winrate vs you = 1 - your winrate (direction pin, v0.37.2 lesson)", () => {
    // hover (you) wins 42% vs the target -> the target beats you 58% of the time.
    const matchups = new Map<number, MatchupRow>([[10, { wins: 420, games: 1000 }]]);
    const results = rankBans(1, 0.5, [baseline(10, 0.5, 0.1, 0.05)], matchups);
    expect(results[0].winVsYou).toBeCloseTo(0.58, 5);
    // a real counter (they beat you) reads ABOVE 50% — never inverted.
    expect(results[0].winVsYou!).toBeGreaterThan(0.5);
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
    // every candidate clears BAN_MIN_MATCHUP_GAMES with wr == baseline
    // (0.5) -- zero disadvantage, so all 8 tie at score 0.
    const matchups = new Map<number, MatchupRow>(pool.map((c) => [c.champId, { wins: 500, games: 1000 }]));
    const results = rankBans(999, 0.5, pool, matchups);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.score === 0)).toBe(true);
    expect(results.map((r) => r.champId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("K constant sanity (used by both play and ban shrink math)", () => {
    expect(K).toBe(200);
  });

  describe("confidence/minGames (audit P2-2 -- previously absent entirely)", () => {
    it("real matchup row clearing the ban floor -> minGames = row.games, confidence normal (floor 1000 > K 200)", () => {
      const pool = [baseline(10, 0.5)];
      const matchups = new Map<number, MatchupRow>([[10, { wins: 400, games: 1500 }]]);
      const results = rankBans(1, 0.5, pool, matchups);
      expect(results[0].minGames).toBe(1500);
      expect(results[0].confidence).toBe("normal");
    });

    it("no matchup row at all -> excluded entirely (never a fabricated 0/low placeholder)", () => {
      const pool = [baseline(10, 0.5)];
      const results = rankBans(1, 0.5, pool, new Map());
      expect(results).toEqual([]);
    });
  });

  describe("ban candidate floor (v0.40.0 -- user directive: no sub-1000-game ban candidates)", () => {
    it("BAN_MIN_MATCHUP_GAMES is 1000, same threshold class as PLAY_MAIN_SAMPLE_FLOOR", () => {
      expect(BAN_MIN_MATCHUP_GAMES).toBe(1000);
      expect(BAN_MIN_MATCHUP_GAMES).toBe(PLAY_MAIN_SAMPLE_FLOOR);
    });

    it("floor applied: a matchup at exactly the floor is included", () => {
      const pool = [baseline(10, 0.5)];
      const matchups = new Map<number, MatchupRow>([[10, { wins: 400, games: 1000 }]]);
      const results = rankBans(1, 0.5, pool, matchups);
      expect(results.map((r) => r.champId)).toEqual([10]);
    });

    it("sub-floor excluded: a real disadvantage under 1000 games never outranks a well-sampled one", () => {
      // reproduces the live bug: hovering Viktor surfaced Singed (n=463)
      // ranked ABOVE Xerath (n=16547) in Suggested bans -- a genuine but
      // tiny-sample disadvantage out-scoring a well-sampled one.
      const pool = [baseline(10, 0.5), baseline(11, 0.5)];
      const matchups = new Map<number, MatchupRow>([
        [10, { wins: 300, games: 463 }], // sub-floor -- excluded even though real signal
        [11, { wins: 6500, games: 16547 }], // well-sampled -- included
      ]);
      const results = rankBans(1, 0.5, pool, matchups);
      expect(results.map((r) => r.champId)).toEqual([11]);
    });

    it("just-under-the-floor (999 games) is excluded", () => {
      const pool = [baseline(10, 0.5)];
      const matchups = new Map<number, MatchupRow>([[10, { wins: 400, games: 999 }]]);
      const results = rankBans(1, 0.5, pool, matchups);
      expect(results).toEqual([]);
    });

    it("empty-result shape: zero candidates clear the floor -> []", () => {
      const pool = [baseline(10, 0.5), baseline(11, 0.5)];
      const matchups = new Map<number, MatchupRow>([
        [10, { wins: 300, games: 463 }],
        [11, { wins: 20, games: 30 }], // clears N_FLOOR but not the ban floor
      ]);
      const results = rankBans(1, 0.5, pool, matchups);
      expect(results).toEqual([]);
    });
  });
});
