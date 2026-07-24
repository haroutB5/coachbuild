/**
 * Feature 4 (v0.51 rewrite): patch movers — per-champion ROLE win-rate shift
 * between the current and previous populated coachless patch. Covers: pure
 * primary-role selection (dual-role champs), the mover computation + minGames
 * gate, ranking/cap, and the orchestrator's unsupported/dedupe/failure paths.
 */
import { describe, it, expect } from "vitest";
import {
  pickPrimaryRole,
  computeMoverForChamp,
  computeRankedMovers,
  computePatchMovers,
  type ChampRoleWinrateData,
  type ChampRoleWinrate,
  type PatchMoversDeps,
} from "../patchMovers";
import type { ResolvedPatch } from "../staticData";

const wr = (games: number, winRatePct: number | null): ChampRoleWinrate => ({ games, winRatePct });

const row = (over: Partial<ChampRoleWinrateData>): ChampRoleWinrateData => ({
  championId: 112,
  role: 2,
  curr: wr(10000, 52.0),
  prev: wr(10000, 50.0),
  ...over,
});

describe("pickPrimaryRole", () => {
  it("null for an empty list", () => {
    expect(pickPrimaryRole([])).toBeNull();
  });

  it("single row is trivially primary", () => {
    const r = row({});
    expect(pickPrimaryRole([r])).toBe(r);
  });

  it("dual-role champ: picks the role with the higher CURRENT-patch games", () => {
    const top = row({ role: 0, curr: wr(3000, 51), prev: wr(3000, 50) });
    const jungle = row({ role: 1, curr: wr(9000, 49), prev: wr(9000, 50) });
    expect(pickPrimaryRole([top, jungle])).toBe(jungle);
  });

  it("ties on games break by role ASC (deterministic)", () => {
    const bot = row({ role: 3, curr: wr(5000, 51) });
    const support = row({ role: 4, curr: wr(5000, 51) });
    expect(pickPrimaryRole([support, bot])).toBe(bot);
  });
});

describe("computeMoverForChamp", () => {
  it("computes a positive delta in percentage points", () => {
    const m = computeMoverForChamp(row({ curr: wr(10000, 52.4), prev: wr(10000, 50.6) }), 500);
    expect(m).not.toBeNull();
    expect(m!.wrNow).toBe(52.4);
    expect(m!.wrPrev).toBe(50.6);
    expect(m!.deltaPp).toBeCloseTo(1.8, 5);
    expect(m!.games).toBe(10000);
  });

  it("computes a negative delta", () => {
    const m = computeMoverForChamp(row({ curr: wr(10000, 48.0), prev: wr(10000, 50.0) }), 500);
    expect(m!.deltaPp).toBeCloseTo(-2.0, 5);
  });

  it("null when current win rate is unavailable", () => {
    expect(computeMoverForChamp(row({ curr: wr(10000, null) }), 500)).toBeNull();
  });

  it("null when previous win rate is unavailable", () => {
    expect(computeMoverForChamp(row({ prev: wr(10000, null) }), 500)).toBeNull();
  });

  it("null when current games is below minGames", () => {
    expect(computeMoverForChamp(row({ curr: wr(400, 52) }), 500)).toBeNull();
  });
});

describe("computeRankedMovers", () => {
  it("groups by championId, resolves primary role, ranks by |deltaPp| desc, caps rows", () => {
    const rows: ChampRoleWinrateData[] = [
      row({ championId: 1, curr: wr(100, 52), prev: wr(100, 50) }), // below minGames -> dropped
      row({ championId: 2, curr: wr(50000, 52), prev: wr(50000, 51) }), // delta 1
      row({ championId: 3, curr: wr(30000, 55), prev: wr(30000, 45) }), // delta 10 (biggest)
    ];
    const ranked = computeRankedMovers(rows, { minGames: 1000, maxRows: 5 });
    expect(ranked.map((m) => m.championId)).toEqual([3, 2]);
  });

  it("a dual-role champion contributes exactly ONE mover (its primary role)", () => {
    const rows: ChampRoleWinrateData[] = [
      row({ championId: 4, role: 0, curr: wr(2000, 51), prev: wr(2000, 50) }),
      row({ championId: 4, role: 3, curr: wr(9000, 60), prev: wr(9000, 40) }),
    ];
    const ranked = computeRankedMovers(rows, { minGames: 1000, maxRows: 5 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].role).toBe(3); // higher-games role wins
    expect(ranked[0].deltaPp).toBeCloseTo(20, 5);
  });

  it("respects maxRows", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ championId: i + 1, curr: wr(10000, 50 + i), prev: wr(10000, 50) })
    );
    expect(computeRankedMovers(rows, { minGames: 500, maxRows: 3 })).toHaveLength(3);
  });
});

// ── Orchestrator (injected deps) ─────────────────────────────────────────────

const P = (major: number, patch: number): ResolvedPatch => ({
  major,
  patch,
  patchAdditions: 0,
  label: `${major}.${patch}`,
});

const SMALL_POOL: Record<0 | 1 | 2 | 3 | 4, number[]> = {
  0: [],
  1: [],
  2: [112],
  3: [],
  4: [],
};

function makeDeps(over: Partial<PatchMoversDeps> = {}): PatchMoversDeps {
  return {
    getCurrentPatch: async () => P(16, 13),
    getPrevPatch: async () => P(16, 12),
    fetchWinrate: async (_champId, _role, patch) =>
      patch.patch === 13 ? wr(20000, 52.4) : wr(19000, 50.6),
    championNames: async () => new Map([[112, "Viktor"]]),
    getNote: () => null,
    pool: SMALL_POOL,
    ...over,
  };
}

describe("computePatchMovers orchestrator", () => {
  it("returns { unsupported: true } when there is no previous populated patch", async () => {
    const res = await computePatchMovers(makeDeps({ getPrevPatch: async () => null }));
    expect(res).toEqual({ unsupported: true });
  });

  it("computes enriched movers with resolved names + patch labels + curated note", async () => {
    const res = await computePatchMovers(makeDeps({ getNote: (patch, champ) => (patch === "16.13" && champ === 112 ? "Buffed this patch" : null) }));
    if ("unsupported" in res) throw new Error("should be supported");
    expect(res.patch).toBe("16.13");
    expect(res.prevPatch).toBe("16.12");
    expect(res.movers).toHaveLength(1);
    const m = res.movers[0];
    expect(m.championId).toBe(112);
    expect(m.championName).toBe("Viktor");
    expect(m.wrNow).toBe(52.4);
    expect(m.wrPrev).toBe(50.6);
    expect(m.deltaPp).toBeCloseTo(1.8, 5);
    expect(m.games).toBe(20000);
    expect(m.note).toBe("Buffed this patch");
  });

  it("swallows a single candidate's fetch failure without sinking the report", async () => {
    const pool: Record<0 | 1 | 2 | 3 | 4, number[]> = { 0: [], 1: [], 2: [112, 999], 3: [], 4: [] };
    const res = await computePatchMovers(
      makeDeps({
        pool,
        fetchWinrate: async (champId, _role, patch) => {
          if (champId === 999) throw new Error("boom");
          return patch.patch === 13 ? wr(20000, 52.4) : wr(19000, 50.6);
        },
      })
    );
    if ("unsupported" in res) throw new Error("should be supported");
    // 999 contributed nothing (null winrate -> dropped by computeMoverForChamp); 112 still produced a mover.
    expect(res.movers.map((m) => m.championId)).toEqual([112]);
  });

  it("a champion pooled under more than one lane still yields exactly one mover", async () => {
    const pool: Record<0 | 1 | 2 | 3 | 4, number[]> = { 0: [112], 1: [], 2: [112], 3: [], 4: [] };
    const res = await computePatchMovers(
      makeDeps({
        pool,
        fetchWinrate: async (_champId, role, patch) => {
          // MID (2) is the higher-games role.
          if (role === 2) return patch.patch === 13 ? wr(20000, 52.4) : wr(19000, 50.6);
          return patch.patch === 13 ? wr(2000, 55) : wr(2000, 45);
        },
      })
    );
    if ("unsupported" in res) throw new Error("should be supported");
    expect(res.movers).toHaveLength(1);
    expect(res.movers[0].role).toBe(2);
  });
});
