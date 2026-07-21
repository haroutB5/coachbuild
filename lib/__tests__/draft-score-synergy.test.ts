/**
 * Draft redesign plan §2.4/§6 — lib/draft/score.ts's synergyDelta/synergyBand
 * addition. Covers: synergyDelta = score - baselineWr exactly; band
 * thresholds; empty-enemies -> ~0/"Even"; and a regression pin proving
 * rankPlays/splitPlaysBySampleSize/rankBans' PRE-EXISTING fields
 * (score/confidence/minGames/winVsLaneOpp/BanResult) are byte-identical to
 * hand-computed expected values under the LOCKED formula (K=200, N_FLOOR=30,
 * W_DIRECT=1.0, W_OFFLANE=0.2) — i.e. adding synergyDelta touched nothing
 * else.
 */
import { describe, it, expect } from "vitest";
import {
  K,
  N_FLOOR,
  W_DIRECT,
  W_OFFLANE,
  SYNERGY_STRONG_DELTA,
  SYNERGY_WEAK_DELTA,
  synergyBand,
  shrinkFactor,
  shrunkDelta,
  rankPlays,
  rankBans,
  splitPlaysBySampleSize,
  type ChampBaseline,
  type MatchupRow,
  type EnemyInput,
} from "../draft/score";

function baseline(champId: number, baselineWr: number, totalGames = 10000): ChampBaseline {
  return { champId, baselineWr, pickrate: null, banrate: null, totalGames };
}

function matchupMap(entries: Array<[number, Map<number, MatchupRow>]>): Map<number, Map<number, MatchupRow>> {
  return new Map(entries);
}

describe("locked formula constants (sanity — this file must never retune these)", () => {
  it("K=200, N_FLOOR=30, W_DIRECT=1.0, W_OFFLANE=0.2", () => {
    expect(K).toBe(200);
    expect(N_FLOOR).toBe(30);
    expect(W_DIRECT).toBe(1.0);
    expect(W_OFFLANE).toBe(0.2);
  });
});

describe("synergyDelta = score - baselineWr exactly", () => {
  it("single direct-lane-opponent term: hand-computed delta matches synergyDelta", () => {
    const pool = [baseline(1, 0.5)];
    const enemies: EnemyInput[] = [{ champId: 50, isDirectLaneOpp: true }];
    const matchups = matchupMap([[1, new Map([[50, { wins: 560, games: 800 }]])]]);

    // Hand-computed: mWr=0.7, shrinkFactor(800)=800/1000=0.8, delta=(0.7-0.5)*0.8=0.16
    const expectedDelta = (0.7 - 0.5) * shrinkFactor(800);
    expect(expectedDelta).toBeCloseTo(0.16, 10);

    const [result] = rankPlays(pool, matchups, enemies);
    expect(result.score).toBeCloseTo(0.5 + expectedDelta, 10);
    expect(result.synergyDelta).toBeCloseTo(expectedDelta, 10);
    // Exact identity: synergyDelta always equals score - baselineWr, byte for byte.
    expect(result.synergyDelta).toBe(result.score - 0.5);
  });

  it("empty enemies -> scoreDelta never accumulates -> synergyDelta exactly 0", () => {
    const pool = [baseline(1, 0.53)];
    const [result] = rankPlays(pool, matchupMap([]), []);
    expect(result.synergyDelta).toBe(0);
    expect(result.score).toBe(0.53);
  });

  it("multiple contributing terms (direct + off-lane) sum correctly into synergyDelta", () => {
    const pool = [baseline(1, 0.5)];
    const enemies: EnemyInput[] = [
      { champId: 50, isDirectLaneOpp: true },
      { champId: 60, isDirectLaneOpp: false },
    ];
    const matchups = matchupMap([
      [
        1,
        new Map([
          [50, { wins: 560, games: 800 }], // direct: delta=(0.7-0.5)*shrinkFactor(800)
          [60, { wins: 300, games: 500 }], // off-lane: wr=0.6, delta=(0.6-0.5)*shrinkFactor(500), weighted 0.2
        ]),
      ],
    ]);
    const directDelta = (0.7 - 0.5) * shrinkFactor(800);
    const offDelta = (0.6 - 0.5) * shrinkFactor(500);
    const expectedSynergy = W_DIRECT * directDelta + W_OFFLANE * offDelta;

    const [result] = rankPlays(pool, matchups, enemies);
    expect(result.synergyDelta).toBeCloseTo(expectedSynergy, 10);
  });
});

describe("synergyBand thresholds", () => {
  it("constants: SYNERGY_STRONG_DELTA=0.015, SYNERGY_WEAK_DELTA=-0.015", () => {
    expect(SYNERGY_STRONG_DELTA).toBe(0.015);
    expect(SYNERGY_WEAK_DELTA).toBe(-0.015);
  });

  it("delta == SYNERGY_STRONG_DELTA (boundary, inclusive) -> Strong", () => {
    expect(synergyBand(0.015)).toBe("Strong");
  });

  it("delta just below the strong boundary -> Even", () => {
    expect(synergyBand(0.0149)).toBe("Even");
  });

  it("delta == SYNERGY_WEAK_DELTA (boundary, inclusive) -> Weak", () => {
    expect(synergyBand(-0.015)).toBe("Weak");
  });

  it("delta just above the weak boundary -> Even", () => {
    expect(synergyBand(-0.0149)).toBe("Even");
  });

  it("delta == 0 -> Even", () => {
    expect(synergyBand(0)).toBe("Even");
  });

  it("a large positive delta -> Strong; a large negative delta -> Weak", () => {
    expect(synergyBand(0.3)).toBe("Strong");
    expect(synergyBand(-0.3)).toBe("Weak");
  });
});

describe("regression pin — pre-existing rankPlays fields untouched by synergyDelta", () => {
  it("missing-row scenario: score/confidence/minGames/winVsLaneOpp exactly match hand-computed values", () => {
    // Mirrors draft-score.test.ts's own "missing matchup row" fixture.
    const pool = [baseline(1, 0.52), baseline(2, 0.5)];
    const enemies: EnemyInput[] = [{ champId: 99, isDirectLaneOpp: true }];
    const matchups = matchupMap([[2, new Map([[99, { wins: 600, games: 1000 }]])]]);

    const results = rankPlays(pool, matchups, enemies);
    const champ1 = results.find((r) => r.champId === 1)!;
    const champ2 = results.find((r) => r.champId === 2)!;

    // champ 1: no row at all vs 99 -- falls back to pure baseline.
    expect(champ1.score).toBe(0.52);
    expect(champ1.winVsLaneOpp).toBeNull();
    expect(champ1.winVsLaneOppGames).toBeNull();
    expect(champ1.confidence).toBe("normal"); // totalGames (10000) >= K
    expect(champ1.minGames).toBe(10000);

    // champ 2: mWr=0.6, shrinkFactor(1000)=1000/1200
    const delta2 = (0.6 - 0.5) * shrinkFactor(1000);
    expect(champ2.score).toBeCloseTo(0.5 + delta2, 10);
    expect(champ2.winVsLaneOpp).toBe(0.6);
    expect(champ2.winVsLaneOppGames).toBe(1000);
    expect(champ2.minGames).toBe(1000); // pulled down by the matchup row's own games (< totalGames)
  });

  it("splitPlaysBySampleSize main/potential partition is unaffected (byte-identical bucketing)", () => {
    const pool = [baseline(1, 0.55), baseline(2, 0.6)];
    const enemies: EnemyInput[] = [{ champId: 7, isDirectLaneOpp: true }];
    const matchups = matchupMap([
      [1, new Map([[7, { wins: 550, games: 1000 }]])], // n=1000 -> main
      [2, new Map([[7, { wins: 300, games: 500 }]])], // n=500 -> potential
    ]);
    const { main, potential } = splitPlaysBySampleSize(pool, matchups, enemies);
    expect(main.map((p) => p.champId)).toEqual([1]);
    expect(potential.map((p) => p.champId)).toEqual([2]);
    // Both buckets still carry a real synergyDelta, additive-only.
    expect(main[0].synergyDelta).not.toBeUndefined();
    expect(potential[0].synergyDelta).not.toBeUndefined();
  });

  it("rankBans scoring is unaffected (BanResult has no synergyDelta field at all)", () => {
    const pool = [baseline(1, 0.5), baseline(2, 0.5)];
    const matchupsForHover = new Map<number, MatchupRow>([[2, { wins: 400, games: 1000 }]]); // hover loses to 2 40% -> hover disadvantage
    const bans = rankBans(1, 0.5, pool, matchupsForHover);
    expect(bans).toHaveLength(1);
    expect(bans[0].champId).toBe(2);
    const mWr = 0.4;
    const delta = shrunkDelta(mWr, 0.5, 1000)!;
    const expectedScore = Math.max(0, -delta) * 1; // presence defaults to 1 (pickrate/banrate both null)
    expect(bans[0].score).toBeCloseTo(expectedScore, 10);
    expect((bans[0] as unknown as { synergyDelta?: unknown }).synergyDelta).toBeUndefined();
  });
});
