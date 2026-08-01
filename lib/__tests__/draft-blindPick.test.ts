import { describe, expect, it } from "vitest";
import {
  BAD_MATCHUP_WR,
  ES_TAIL_MASS,
  MASS_COVERAGE_GATE,
  MASS_GATE_MIN_GAMES,
  RISK_AVERSION,
  buildOpponentPrior,
  computeBlindPickCandidate,
  deriveBlindPickCandidates,
  matchupEstimate,
  rankBlindPicks,
  type BlindPickMatchupRow,
} from "@/lib/draft/blindPick";
import {
  K,
  POOL_MIN_PICKRATE,
  POOL_MIN_TOTAL_GAMES,
  filterPoolByLaneShare,
  laneShare,
  realLaneGames,
} from "@/lib/draft/score";

describe("blind-pick metrics", () => {
  it("uses fractional mass at the ES10 boundary", () => {
    // Champion 1 sees three opponents. Extra champion-2 rows make the global
    // lane prior exactly p(10)=.05, p(20)=.50, p(30)=.45; the candidate's own
    // baseline is exactly .50 and its shrunk matchup estimates are .40/.50/.60.
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 780, games: 2000 },
      { champId: 1, oppId: 20, wins: 1000, games: 2000 },
      { champId: 1, oppId: 30, wins: 1220, games: 2000 },
      { champId: 2, oppId: 20, wins: 9000, games: 18000 },
      { champId: 2, oppId: 30, wins: 8000, games: 16000 },
    ];
    const prior = buildOpponentPrior(rows);
    const candidate = deriveBlindPickCandidates(rows).find((c) => c.champId === 1)!;
    const result = computeBlindPickCandidate(candidate, rows, prior)!;

    expect(prior.get(10)).toBeCloseTo(0.05, 10);
    expect(prior.get(20)).toBeCloseTo(0.5, 10);
    expect(prior.get(30)).toBeCloseTo(0.45, 10);
    expect(result.fieldWr).toBeCloseTo(0.54, 10);
    expect(result.es10).toBeCloseTo(0.45, 10);
    expect(result.badMass).toBeCloseTo(0.05, 10);
    expect(result.blindScore).toBeCloseTo(0.515, 10);
    expect(ES_TAIL_MASS).toBe(0.1);
  });

  it("ranks a flatter champion above a stronger champion with a deep common counter", () => {
    // Both candidates face a 50/50 field. Champion 1's 54% baseline hides a
    // 38% common matchup; champion 2 is a flat 51% everywhere. The risk
    // penalty must put champion 2 first even though champion 1 is stronger in
    // aggregate.
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 1868, games: 5000 },
      { champId: 1, oppId: 20, wins: 3532, games: 5000 },
      { champId: 2, oppId: 10, wins: 2550, games: 5000 },
      { champId: 2, oppId: 20, wins: 2550, games: 5000 },
    ];
    const result = rankBlindPicks(deriveBlindPickCandidates(rows), rows);

    expect(result.picks.map((pick) => pick.champId)).toEqual([2, 1]);
    expect(result.picks[0].fieldWr).toBeCloseTo(0.51, 5);
    expect(result.picks[0].es10).toBeCloseTo(0.51, 5);
    expect(result.picks[1].fieldWr).toBeCloseTo(0.54, 5);
    expect(result.picks[1].es10).toBeCloseTo(0.38, 5);
    expect(result.picks[1].blindScore).toBeCloseTo(0.48, 5);
    expect(RISK_AVERSION).toBe(0.5);
  });

  it("shrinks a six-game cell back toward baseline instead of letting it fabricate the tail", () => {
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 0, games: 6 },
      { champId: 1, oppId: 20, wins: 3300, games: 5994 },
    ];
    const candidate = deriveBlindPickCandidates(rows)[0];
    const result = computeBlindPickCandidate(candidate, rows)!;
    const expectedThinCell = 0.55 + (6 / (6 + K)) * (0 - 0.55);

    expect(candidate.baselineWr).toBeCloseTo(0.55, 10);
    expect(matchupEstimate(0.55, 0, 6)).toBeCloseTo(expectedThinCell, 10);
    expect(result.worstMatchup?.wr).toBeCloseTo(expectedThinCell, 10);
    expect(result.es10).toBeGreaterThan(0.549);
    expect(result.coverageMass).toBeGreaterThanOrEqual(MASS_COVERAGE_GATE);
    expect(MASS_GATE_MIN_GAMES).toBe(30);
  });

  it("excludes and reports candidates below the mass coverage gate", () => {
    const rows: BlindPickMatchupRow[] = [
      // Candidate 1 has a 29-game cell in an opponent field that carries half
      // the mass, so it cannot pass the 90% gate despite 5,029 total games.
      { champId: 1, oppId: 10, wins: 14, games: 29 },
      { champId: 1, oppId: 20, wins: 2500, games: 5000 },
      { champId: 2, oppId: 10, wins: 2500, games: 5000 },
      { champId: 2, oppId: 20, wins: 2500, games: 5000 },
    ];
    const result = rankBlindPicks(deriveBlindPickCandidates(rows), rows);

    expect(result.poolCandidates).toBe(2);
    expect(result.qualifiedCandidates).toBe(1);
    expect(result.excludedByMassGate).toBe(1);
    expect(result.picks.map((pick) => pick.champId)).toEqual([2]);
    expect(POOL_MIN_TOTAL_GAMES).toBe(5000);
  });

  it("reuses the 5,000-game pool floor before applying the mass gate", () => {
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 2499, games: 4999 },
      { champId: 2, oppId: 10, wins: 2500, games: 5000 },
    ];
    const result = rankBlindPicks(deriveBlindPickCandidates(rows), rows);

    expect(result.poolCandidates).toBe(1);
    expect(result.excludedByMassGate).toBe(0);
    expect(result.picks.map((pick) => pick.champId)).toEqual([2]);
  });

  it("uses the lane-share floor after the total-game floor", () => {
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 3000, games: 6000 },
      { champId: 2, oppId: 10, wins: 500000, games: 1000000 },
      { champId: 3, oppId: 10, wins: 2500, games: 5000 },
    ];
    const candidates = deriveBlindPickCandidates(rows);
    const totalLaneGames = candidates.reduce((sum, candidate) => sum + candidate.totalGames, 0);
    const shares = new Map(candidates.map((candidate) => [candidate.champId, laneShare(candidate, totalLaneGames)]));

    expect(POOL_MIN_PICKRATE).toBe(0.01);
    expect(shares.get(1)).toBeGreaterThan(POOL_MIN_PICKRATE);
    expect(shares.get(3)).toBeLessThan(POOL_MIN_PICKRATE);
    expect(filterPoolByLaneShare(candidates, shares).map((candidate) => candidate.champId)).toEqual([1, 2]);

    const result = rankBlindPicks(candidates, rows);
    expect(result.poolCandidates).toBe(3);
    expect(result.excludedByLaneShare).toBe(1);
    expect(result.excludedByMassGate).toBe(0);
    expect(result.excludedUncomputable).toBe(0);
    expect(result.picks.map((pick) => pick.champId)).toEqual([1, 2]);
  });

  it("halves the symmetric matrix total once before calculating lane share", () => {
    expect(realLaneGames(2000)).toBe(1000);
    expect(laneShare({ champId: 1, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 250 }, 2000)).toBe(0.25);
  });

  it("keeps lane-share, mass-gate, and uncomputable exclusions disjoint", () => {
    const candidates = [
      { champId: 1, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 5001 },
      { champId: 2, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 7000 },
      // Deliberately has enough declared volume to clear both pool floors, but
      // no usable matchup rows, so it must reach the uncomputable counter.
      { champId: 3, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 1200000 },
    ];
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 2500, games: 5001 },
      { champId: 2, oppId: 10, wins: 15, games: 29 },
      { champId: 2, oppId: 20, wins: 3485, games: 6971 },
    ];

    const result = rankBlindPicks(candidates, rows);

    expect(result.poolCandidates).toBe(3);
    expect(result.excludedByLaneShare).toBe(1);
    expect(result.excludedByMassGate).toBe(1);
    expect(result.excludedUncomputable).toBe(1);
    expect(result.qualifiedCandidates).toBe(0);
    expect(
      result.excludedByLaneShare + result.excludedByMassGate + result.excludedUncomputable
    ).toBe(result.poolCandidates);
  });

  it("reports the worst matchup's OWN game count, not the champion's lane total", () => {
    // The reason this field exists: on live data Singed mid carries 11,476 lane
    // games while his worst matchup rests on 137. The row's Games column cannot
    // express that, so the cell carries its own denominator. Here the candidate
    // has 6,000 lane games and a worst matchup backed by 2,000 — the assertion
    // is that the smaller number is the one reported.
    const rows: BlindPickMatchupRow[] = [
      { champId: 1, oppId: 10, wins: 780, games: 2000 },
      { champId: 1, oppId: 20, wins: 1000, games: 2000 },
      { champId: 1, oppId: 30, wins: 1220, games: 2000 },
      { champId: 2, oppId: 20, wins: 9000, games: 18000 },
      { champId: 2, oppId: 30, wins: 8000, games: 16000 },
    ];
    const prior = buildOpponentPrior(rows);
    const candidate = deriveBlindPickCandidates(rows).find((c) => c.champId === 1)!;
    const result = computeBlindPickCandidate(candidate, rows, prior)!;

    // Opponent 10 is the worst matchup (.40 vs a .50 baseline).
    expect(result.worstMatchup?.oppId).toBe(10);
    expect(result.worstMatchup?.games).toBe(2000);
    // Explicitly NOT the champion's aggregate — the whole point of the field.
    expect(result.totalGames).toBe(6000);
    expect(result.worstMatchup?.games).not.toBe(result.totalGames);
  });
});
