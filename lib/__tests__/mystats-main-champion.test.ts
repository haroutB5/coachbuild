// ─────────────────────────────────────────────────────────────────────────────
// mystats-main-champion.test.ts
//
// WHY THIS FILE EXISTS.
//
// /mystats' MAIN tile used to read `rows[0]` — the first of the (champion,
// ROLE) records. That is the biggest single champion+lane pair, NOT the
// champion's total. Caught on the live site 2026-07-27: the account's pool
// contained Viktor three times (15g mid, 3g top, 1g), so the headline read
// "MAIN: Viktor, 15g" when the true total was 19. A user reads that tile as
// "how many games have I played of my main", and that reading was wrong.
//
// These tests are built around records where per-role and per-champion totals
// DISAGREE — a champion split across lanes has to out-total a champion that is
// bigger in any single lane. An implementation that still picks rows[0] fails.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { computeMainChampion, type MyStatsRecord, type IconEntry } from "@/components/hextech/myStats";

function rec(championId: number, role: number, games: number, wins: number): MyStatsRecord {
  return {
    championId,
    role,
    games,
    wins,
    winrate: games > 0 ? wins / games : 0,
    lastPlayed: "2026-07-27T00:00:00.000Z",
  };
}

const NAMES: Record<number, string> = { 112: "Viktor", 50: "Swain", 800: "Mel" };
const iconOf = (id: number): IconEntry | undefined =>
  NAMES[id] ? { name: NAMES[id], icon: "" } : undefined;

describe("computeMainChampion", () => {
  it("sums a champion across roles — the exact live regression", () => {
    // Viktor 15 + 3 + 1 = 19. Records arrive sorted by games desc, so rows[0]
    // is the 15-game mid row and the OLD code reported 15.
    const records = [
      rec(112, 2, 15, 9), // Viktor mid
      rec(50, 2, 7, 4), // Swain mid
      rec(112, 0, 3, 2), // Viktor top
      rec(112, 4, 1, 1), // Viktor support
    ];
    const main = computeMainChampion(records, iconOf);
    expect(main).not.toBeNull();
    expect(main!.name).toBe("Viktor");
    expect(main!.games).toBe(19);
    expect(main!.wins).toBe(12);
  });

  it("a champion split across lanes can OUT-TOTAL one that is bigger in any single lane", () => {
    // This is the case rows[0] gets wrong even with a stable sort: Swain's
    // single 10-game row leads the list, but Viktor has 12 games overall.
    const records = [rec(50, 2, 10, 5), rec(112, 2, 6, 3), rec(112, 0, 6, 4)];
    const main = computeMainChampion(records, iconOf);
    expect(main!.name).toBe("Viktor");
    expect(main!.games).toBe(12);
  });

  it("recomputes win rate from summed wins, not by averaging the per-role rates", () => {
    // Averaging the rates gives (1.0 + 0.0) / 2 = 50%. The honest number is
    // 9 wins from 10 games = 90%, because the 9-game row must outweigh the
    // 1-game one.
    const records = [rec(112, 2, 9, 9), rec(112, 0, 1, 0)];
    const main = computeMainChampion(records, iconOf);
    expect(main!.games).toBe(10);
    expect(main!.wins).toBe(9);
    expect(main!.winrate).toBeCloseTo(0.9, 10);
  });

  it("returns null on no records rather than a zero-game champion", () => {
    expect(computeMainChampion([], iconOf)).toBeNull();
  });

  it("falls back to a readable name when the icon lookup misses", () => {
    const main = computeMainChampion([rec(999, 1, 4, 2)], iconOf);
    expect(main!.name).toBe("Champion #999");
    expect(main!.games).toBe(4);
  });

  it("keeps the first-seen champion on a tie, so the ordering stays stable", () => {
    // Records arrive games-desc, so first-seen is the more recently dominant
    // one. Pinning this stops the tile flickering between two equal champions.
    const records = [rec(112, 2, 5, 3), rec(50, 2, 5, 1)];
    expect(computeMainChampion(records, iconOf)!.name).toBe("Viktor");
  });

  it("counts an unresolved role (-1, e.g. ARAM) toward the champion total", () => {
    // -1 is a real record the pool renders; excluding it here would make the
    // tile disagree with the list below it.
    const records = [rec(112, -1, 4, 2), rec(112, 2, 3, 3)];
    const main = computeMainChampion(records, iconOf);
    expect(main!.games).toBe(7);
    expect(main!.wins).toBe(5);
  });
});
