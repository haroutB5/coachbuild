/**
 * Tests for lib/pro/mergeGames.ts — the soloq/prostage merge behind
 * GET /api/pros, including the pro-play FLOOR added 2026-07-28 in response to
 * the "only 4 out of 100 are pro games" report.
 *
 * The scenario numbers below are the real measured Viktor-mid shape (90-day
 * fresh window, 2026-07-28): 318 soloq rows and 94 prostage rows exist, and
 * the newest 96 soloq games are all newer than the newest prostage game.
 */
import { describe, it, expect } from "vitest";
import { mergeProGames } from "../pro/mergeGames";
import type { ProGame } from "../pro/types";

/** Minimal ProGame stub — mergeProGames only ever reads `gameCreation`,
 *  `source` and `id`, so the rest stays deliberately absent rather than
 *  fabricating a full row that would rot against the real type. */
function game(source: ProGame["source"], daysAgo: number, id: string): ProGame {
  const ts = new Date(Date.UTC(2026, 6, 28) - daysAgo * 86_400_000).toISOString();
  return { id, source, gameCreation: ts } as ProGame;
}

/** soloq rows dated 0..n-1 days ago; prostage rows start `offsetDays` back,
 *  reproducing the cadence gap that causes the starvation. */
function scenario(soloqCount: number, prostageCount: number, offsetDays = 1) {
  const soloq = Array.from({ length: soloqCount }, (_, i) => game("soloq", i * 0.01, `s${i}`));
  const prostage = Array.from({ length: prostageCount }, (_, i) =>
    game("prostage", offsetDays + i * 0.5, `p${i}`)
  );
  return { soloq, prostage };
}

const countBySource = (games: ProGame[]) => ({
  soloq: games.filter((g) => g.source === "soloq").length,
  prostage: games.filter((g) => g.source === "prostage").length,
});

describe("mergeProGames", () => {
  it("with no floor, reproduces the old plain recency merge (and its starvation)", () => {
    const { soloq, prostage } = scenario(318, 94);
    const merged = mergeProGames(soloq, prostage, 100);
    expect(merged).toHaveLength(100);
    // This is the BUG being fixed, pinned here deliberately: the default
    // (floor 0) path must stay byte-identical for /history's recency feed.
    expect(countBySource(merged).prostage).toBeLessThan(10);
  });

  it("reserves the floor for pro play when that many pro-play rows exist", () => {
    const { soloq, prostage } = scenario(318, 94);
    const merged = mergeProGames(soloq, prostage, 200, 100);
    expect(merged).toHaveLength(200);
    // 94 available < the 100 floor, so all 94 land and soloq fills the rest.
    expect(countBySource(merged)).toEqual({ prostage: 94, soloq: 106 });
  });

  it("caps the reserved slots at the floor when pro play is plentiful", () => {
    const { soloq, prostage } = scenario(318, 250);
    const merged = mergeProGames(soloq, prostage, 200, 100);
    expect(countBySource(merged)).toEqual({ prostage: 100, soloq: 100 });
  });

  it("backfills past the floor when solo queue is the thin side", () => {
    const { soloq, prostage } = scenario(20, 250);
    const merged = mergeProGames(soloq, prostage, 200, 100);
    // A floor must never SHRINK the sample: all 20 soloq rows plus 180
    // prostage rows, not 100 prostage + 20 soloq = 120.
    expect(merged).toHaveLength(200);
    expect(countBySource(merged)).toEqual({ prostage: 180, soloq: 20 });
  });

  it("never returns more rows than exist", () => {
    const { soloq, prostage } = scenario(5, 3);
    const merged = mergeProGames(soloq, prostage, 200, 100);
    expect(merged).toHaveLength(8);
  });

  it("returns the result recency-sorted regardless of the floor", () => {
    const { soloq, prostage } = scenario(50, 50);
    const merged = mergeProGames(soloq, prostage, 60, 30);
    const times = merged.map((g) => new Date(g.gameCreation).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("breaks equal-timestamp ties by source and id, independent of input order", () => {
    const sameTimeSolos = [game("soloq", 1, "s2"), game("soloq", 1, "s1")];
    const sameTimePro = [game("prostage", 1, "p2"), game("prostage", 1, "p1")];
    expect(mergeProGames(sameTimeSolos, sameTimePro, 4).map((g) => g.id)).toEqual(["p1", "p2", "s1", "s2"]);
  });

  it("never duplicates a row when backfilling", () => {
    const { soloq, prostage } = scenario(3, 40);
    const merged = mergeProGames(soloq, prostage, 30, 10);
    expect(new Set(merged.map((g) => g.id)).size).toBe(merged.length);
  });

  it("returns an empty list for a non-positive limit", () => {
    const { soloq, prostage } = scenario(10, 10);
    expect(mergeProGames(soloq, prostage, 0, 5)).toEqual([]);
  });

  it("handles an empty pro-play side without dropping soloq rows", () => {
    const { soloq } = scenario(40, 0);
    const merged = mergeProGames(soloq, [], 30, 100);
    expect(countBySource(merged)).toEqual({ prostage: 0, soloq: 30 });
  });
});
