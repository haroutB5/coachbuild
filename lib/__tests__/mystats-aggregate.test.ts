import { describe, it, expect } from "vitest";
import {
  summarizeByChampion,
  summarizeMatchup,
  summarizeMatchupsByOpponent,
  computeBuildAdherence,
  computePriorSplitWinrate,
  buildRecentGames,
  type MyMatchRecord,
  type AdherenceRecord,
  type RecentGameInput,
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

// ─────────────────────────────────────────────────────────────────────────────
// v0.51 additions — build adherence, prior-split delta, recent games.
// ─────────────────────────────────────────────────────────────────────────────

function adh(over: Partial<AdherenceRecord>): AdherenceRecord {
  return { win: true, onWpaBuild: null, ...over };
}

describe("computeBuildAdherence", () => {
  it("all null when there are zero rows with a resolved recommendation", () => {
    const out = computeBuildAdherence([adh({ onWpaBuild: null }), adh({ onWpaBuild: null })]);
    expect(out).toEqual({
      buildAdherencePct: null,
      winrateOnBuild: null,
      winrateOffBuild: null,
      nOnBuild: null,
      nOffBuild: null,
    });
  });

  it("excludes unresolved (null) rows from the denominator", () => {
    const out = computeBuildAdherence([
      adh({ onWpaBuild: null, win: true }), // excluded entirely
      adh({ onWpaBuild: true, win: true }),
      adh({ onWpaBuild: false, win: false }),
    ]);
    expect(out.buildAdherencePct).toBe(50); // 1 of 2 RESOLVED rows on-build
  });

  it("computes buildAdherencePct + separate on/off win rates + the row count behind each", () => {
    const out = computeBuildAdherence([
      adh({ onWpaBuild: true, win: true }),
      adh({ onWpaBuild: true, win: true }),
      adh({ onWpaBuild: true, win: false }),
      adh({ onWpaBuild: false, win: false }),
    ]);
    expect(out.buildAdherencePct).toBe(75); // 3 of 4
    expect(out.winrateOnBuild).toBeCloseTo(2 / 3, 5);
    expect(out.winrateOffBuild).toBe(0);
    expect(out.nOnBuild).toBe(3);
    expect(out.nOffBuild).toBe(1);
  });

  it("winrateOffBuild/nOffBuild are null when every resolved row was on-build (no off-build rows to average)", () => {
    const out = computeBuildAdherence([adh({ onWpaBuild: true, win: true })]);
    expect(out.winrateOffBuild).toBeNull();
    expect(out.nOffBuild).toBeNull();
    expect(out.winrateOnBuild).toBe(1);
    expect(out.nOnBuild).toBe(1);
  });

  it("nOnBuild/nOffBuild are real counts on a larger realistic sample, not percentages", () => {
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => adh({ onWpaBuild: true, win: i % 3 !== 0 })), // 22 on-build
      ...Array.from({ length: 14 }, (_, i) => adh({ onWpaBuild: false, win: i % 2 === 0 })), // 14 off-build
      adh({ onWpaBuild: null, win: true }), // unresolved, excluded from every figure
    ];
    const out = computeBuildAdherence(rows);
    expect(out.nOnBuild).toBe(22);
    expect(out.nOffBuild).toBe(14);
    expect(out.buildAdherencePct).toBeCloseTo((22 / 36) * 100, 1);
  });

  it("empty input -> all null", () => {
    expect(computeBuildAdherence([])).toEqual({
      buildAdherencePct: null,
      winrateOnBuild: null,
      winrateOffBuild: null,
      nOnBuild: null,
      nOffBuild: null,
    });
  });
});

describe("computePriorSplitWinrate", () => {
  it("null for zero rows (no prior-split data at all)", () => {
    expect(computePriorSplitWinrate([])).toBeNull();
  });

  it("computes a plain win rate over whatever rows it's given", () => {
    expect(computePriorSplitWinrate([{ win: true }, { win: true }, { win: false }, { win: false }])).toBe(0.5);
  });
});

function recentRow(over: Partial<RecentGameInput>): RecentGameInput {
  return {
    championId: 1,
    role: 2,
    win: true,
    kills: 5,
    deaths: 2,
    assists: 7,
    onWpaBuild: null,
    gameCreation: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildRecentGames", () => {
  it("sorts newest first regardless of input order", () => {
    const rows = [
      recentRow({ championId: 1, gameCreation: "2026-01-01T00:00:00.000Z" }),
      recentRow({ championId: 2, gameCreation: "2026-03-01T00:00:00.000Z" }),
      recentRow({ championId: 3, gameCreation: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(buildRecentGames(rows).map((g) => g.championId)).toEqual([2, 3, 1]);
  });

  it("caps at the given limit (default 5)", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      recentRow({ championId: i, gameCreation: `2026-01-0${i + 1}T00:00:00.000Z` })
    );
    expect(buildRecentGames(rows)).toHaveLength(5);
    expect(buildRecentGames(rows, 3)).toHaveLength(3);
  });

  it("strips gameCreation from the output shape (display doesn't need it)", () => {
    const [g] = buildRecentGames([recentRow({})]);
    expect(g).toEqual({
      championId: 1,
      role: 2,
      win: true,
      kills: 5,
      deaths: 2,
      assists: 7,
      onWpaBuild: null,
    });
  });

  it("empty input -> empty output", () => {
    expect(buildRecentGames([])).toEqual([]);
  });
});
