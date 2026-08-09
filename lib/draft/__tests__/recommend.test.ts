import { describe, expect, it } from "vitest";
import { matchupEstimate } from "../blindPick";
import { buildMatchupPreviews, type DraftLaneStat } from "../recommend";
import type { ChampBaseline } from "../score";

describe("buildMatchupPreviews", () => {
  it("exposes every locked-enemy value from the loaded matrix after the compact slices", () => {
    const fullPool: ChampBaseline[] = [
      { champId: 1, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 500 },
      { champId: 2, baselineWr: 0.5, pickrate: null, banrate: null, totalGames: 500 },
    ];
    const rows = [10, 11, 12, 13, 14].flatMap((oppId) => [
      { champ_id: 1, opp_id: oppId, wins: 40 + (oppId - 10) * 5, games: 100 },
      { champ_id: 2, opp_id: oppId, wins: 50, games: 100 },
    ]);
    const laneStats: DraftLaneStat[] = fullPool.map((candidate) => ({
      champId: candidate.champId,
      baselineWr: candidate.baselineWr,
      totalGames: 500,
      laneShare: 0.5,
    }));

    const [preview] = buildMatchupPreviews(fullPool, rows, laneStats, new Set([1]), new Set([10, 11, 12, 13, 14]));
    const exposed = new Map(preview.best.map((row) => [row.oppId, row.winRate]));

    for (const row of rows.filter((candidateRow) => candidateRow.champ_id === 1)) {
      expect(exposed.get(row.opp_id)).toBeCloseTo(matchupEstimate(0.5, row.wins, row.games)!, 10);
    }
    expect(preview.best.slice(0, 3).map((row) => row.oppId)).toEqual([14, 13, 12]);
  });
});
