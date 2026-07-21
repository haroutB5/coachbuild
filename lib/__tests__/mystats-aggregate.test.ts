import { describe, it, expect } from "vitest";
import {
  summarizeByChampion,
  summarizeMatchup,
  summarizeMatchupsByOpponent,
  type MyMatchRecord,
} from "@/lib/mystats/aggregate";

function rec(overrides: Partial<MyMatchRecord>): MyMatchRecord {
  return { championId: 1, role: 2, oppChampionId: null, win: true, gameCreation: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("summarizeByChampion", () => {
  it("groups by (championId, role), computes winrate and lastPlayed", () => {
    const rows = [
      rec({ championId: 1, role: 2, win: true, gameCreation: "2026-01-01T00:00:00.000Z" }),
      rec({ championId: 1, role: 2, win: false, gameCreation: "2026-02-01T00:00:00.000Z" }),
      rec({ championId: 1, role: 2, win: true, gameCreation: "2026-01-15T00:00:00.000Z" }),
    ];
    const out = summarizeByChampion(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ championId: 1, role: 2, games: 3, wins: 2, winrate: 2 / 3 });
    expect(out[0].lastPlayed).toBe("2026-02-01T00:00:00.000Z");
  });

  it("keeps the SAME champion in two different roles as two separate rows", () => {
    const rows = [rec({ championId: 1, role: 0 }), rec({ championId: 1, role: 2 })];
    const out = summarizeByChampion(rows);
    expect(out).toHaveLength(2);
  });

  it("sorts by games DESC, then winrate DESC, then championId ASC (deterministic)", () => {
    const rows = [
      rec({ championId: 5, role: 0, win: true }),
      rec({ championId: 3, role: 0, win: true }),
      rec({ championId: 3, role: 0, win: true }),
      rec({ championId: 3, role: 0, win: false }),
      rec({ championId: 4, role: 0, win: true }),
      rec({ championId: 4, role: 0, win: true }),
      rec({ championId: 4, role: 0, win: false }),
    ];
    const out = summarizeByChampion(rows);
    // championId 3 and 4 both have 3 games; 3 has 2/3 wins, 4 has 2/3 wins too (tie) -> championId ASC breaks it
    expect(out.map((r) => r.championId)).toEqual([3, 4, 5]);
  });

  it("empty input -> empty output", () => {
    expect(summarizeByChampion([])).toEqual([]);
  });
});

describe("summarizeMatchup", () => {
  it("null when there are zero games against that specific opponent", () => {
    const rows = [rec({ championId: 1, oppChampionId: 20 })];
    expect(summarizeMatchup(rows, 999)).toBeNull();
  });

  it("aggregates only rows matching the given oppChampionId", () => {
    const rows = [
      rec({ championId: 1, oppChampionId: 20, win: true }),
      rec({ championId: 1, oppChampionId: 20, win: false }),
      rec({ championId: 1, oppChampionId: 30, win: true }), // different opponent -- excluded
    ];
    expect(summarizeMatchup(rows, 20)).toEqual({ games: 2, wins: 1, winrate: 0.5 });
  });
});

describe("summarizeMatchupsByOpponent", () => {
  it("excludes rows with a null oppChampionId (unresolved role, e.g. ARAM)", () => {
    const rows = [rec({ oppChampionId: null }), rec({ oppChampionId: 20, win: true })];
    const out = summarizeMatchupsByOpponent(rows);
    expect(out).toEqual([{ oppChampionId: 20, games: 1, wins: 1, winrate: 1 }]);
  });

  it("sorts by games DESC then oppChampionId ASC", () => {
    const rows = [
      rec({ oppChampionId: 10, win: true }),
      rec({ oppChampionId: 20, win: true }),
      rec({ oppChampionId: 20, win: false }),
    ];
    const out = summarizeMatchupsByOpponent(rows);
    expect(out.map((o) => o.oppChampionId)).toEqual([20, 10]);
  });
});
