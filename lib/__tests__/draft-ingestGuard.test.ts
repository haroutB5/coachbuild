/**
 * Tests for lib/draft/ingestGuard.ts — the P0 permanent guard added
 * 2026-07-21 after a user-caught u.gg perspective inversion. Two
 * INDEPENDENT mechanisms: the cross-source panel (runIngestGuard, vs
 * coachless ground truth) and the symmetry check (checkSymmetry, purely
 * internal). See ingestGuard.ts's own comments for why neither substitutes
 * for the other — the exhaustive test list below pins that distinction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
vi.mock("@/lib/heroStats", () => ({ getHeroStats: vi.fn() }));

import {
  runIngestGuard,
  checkSymmetry,
  makeRealGuardDeps,
  runDefaultIngestGuard,
  runSymmetryCheck,
  DEFAULT_GUARD_PANEL,
  GUARD_TOLERANCE_PCT,
  GUARD_MIN_CHECKABLE,
  SYMMETRY_TOLERANCE_PCT,
  SYMMETRY_MIN_CHECKABLE,
  type GuardDeps,
  type GuardPanelEntry,
  type SymmetryPairRow,
} from "@/lib/draft/ingestGuard";
import { getHeroStats } from "@/lib/heroStats";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

describe("DEFAULT_GUARD_PANEL", () => {
  it("spans all 5 roles with at least 4 champions each", () => {
    const byRole = new Map<number, number>();
    for (const entry of DEFAULT_GUARD_PANEL) {
      byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + 1);
    }
    for (const role of [0, 1, 2, 3, 4]) {
      expect(byRole.get(role) ?? 0).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("runIngestGuard (cross-source panel)", () => {
  const panel: GuardPanelEntry[] = [
    { champId: 1, role: 0, laneKey: "top", label: "A/top" },
    { champId: 2, role: 1, laneKey: "jungle", label: "B/jungle" },
    { champId: 3, role: 2, laneKey: "mid", label: "C/mid" },
  ];

  it("passes when every entry is within tolerance", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async () => 0.5,
      getGroundTruth: async () => ({ winRatePct: 50 + GUARD_TOLERANCE_PCT - 0.1 }),
    };
    const result = await runIngestGuard(panel, deps, GUARD_TOLERANCE_PCT, 1);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.failures).toEqual([]);
  });

  it("fails when one entry exceeds tolerance", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async (champId) => (champId === 3 ? 0.58 : 0.5), // Viktor-shaped drift
      getGroundTruth: async () => ({ winRatePct: 50 }),
    };
    const result = await runIngestGuard(panel, deps, 4, 1);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C/mid");
  });

  it("skips (doesn't fail on) an entry with no ground truth available", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async () => 0.5,
      getGroundTruth: async (champId) => (champId === 2 ? { winRatePct: null } : { winRatePct: 50 }),
    };
    const result = await runIngestGuard(panel, deps, 4, 1);
    expect(result.checked).toBe(2); // champId 2 skipped, not counted either way
    expect(result.ok).toBe(true);
  });

  it("skips (doesn't fail on) an entry with no draft baseline yet", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async (champId) => (champId === 1 ? null : 0.5),
      getGroundTruth: async () => ({ winRatePct: 50 }),
    };
    const result = await runIngestGuard(panel, deps, 4, 1);
    expect(result.checked).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("fails as INCONCLUSIVE when too few entries could be checked, even with zero explicit mismatches", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async () => null, // nothing checkable at all
      getGroundTruth: async () => ({ winRatePct: 50 }),
    };
    const result = await runIngestGuard(panel, deps, 4, GUARD_MIN_CHECKABLE);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(0);
    expect(result.failures.some((f) => f.includes("inconclusive"))).toBe(true);
  });

  it("details array reports every entry, including skipped ones, for visibility", async () => {
    const deps: GuardDeps = {
      getDraftBaseline: async (champId) => (champId === 2 ? null : 0.5),
      getGroundTruth: async () => ({ winRatePct: 50 }),
    };
    const result = await runIngestGuard(panel, deps, 4, 1);
    expect(result.details).toHaveLength(3);
    const skipped = result.details.find((d) => d.label === "B/jungle")!;
    expect(skipped.draftPct).toBeNull();
    expect(skipped.deltaPct).toBeNull();
  });
});

describe("checkSymmetry (purely internal invariant)", () => {
  function pair(overrides: Partial<SymmetryPairRow> = {}): SymmetryPairRow {
    return { champA: 1, champB: 2, role: 0, winsA: 500, gamesA: 1000, winsB: 500, gamesB: 1000, ...overrides };
  }

  it("passes when wr(A,B) + wr(B,A) is close to 100%", async () => {
    const rows = [pair({ winsA: 550, gamesA: 1000, winsB: 450, gamesB: 1000 })]; // 55% + 45% = 100%
    const result = checkSymmetry(rows, SYMMETRY_TOLERANCE_PCT, 1);
    expect(result.ok).toBe(true);
  });

  it("fails when the pair sum deviates beyond tolerance (decode/keying corruption signature)", async () => {
    const rows = [pair({ winsA: 700, gamesA: 1000, winsB: 700, gamesB: 1000 })]; // 70% + 70% = 140%
    const result = checkSymmetry(rows, SYMMETRY_TOLERANCE_PCT, 1);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("140.0%");
  });

  it("CRITICAL REGRESSION PIN: a uniform inversion (both sides flipped the SAME way) still passes symmetry -- proves this check alone would NOT have caught the P0 bug", async () => {
    // True: A beats B 70% of the time (B beats A 30%). If BOTH files got
    // the exact same perspective bug applied, the STORED rows read as
    // A-wins=30%, B-wins=70% -- the pair sum is STILL ~100%, even though
    // both numbers are individually wrong. This is the whole reason the
    // cross-source panel exists as a SEPARATE mechanism -- see
    // ingestGuard.ts's header comment on the symmetry check.
    const trueRows = [pair({ winsA: 700, gamesA: 1000, winsB: 300, gamesB: 1000 })]; // true: 70%+30%=100%
    const invertedRows = [pair({ winsA: 300, gamesA: 1000, winsB: 700, gamesB: 1000 })]; // both flipped: 30%+70%=100%
    expect(checkSymmetry(trueRows, SYMMETRY_TOLERANCE_PCT, 1).ok).toBe(true);
    expect(checkSymmetry(invertedRows, SYMMETRY_TOLERANCE_PCT, 1).ok).toBe(true); // still "passes" -- expected and documented
  });

  it("fails as inconclusive when too few symmetric pairs are found", () => {
    const result = checkSymmetry([pair()], SYMMETRY_TOLERANCE_PCT, SYMMETRY_MIN_CHECKABLE);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.toLowerCase().includes("inconclusive"))).toBe(true);
  });

  // v0.109.0: "could not check" and "checked and found a problem" both set
  // ok=false (skipping retention on unvouched data is correct in both cases)
  // and were previously indistinguishable — /draft rendered the same "Last
  // data refresh reported an error" for a first-day-of-patch run with nothing
  // whatsoever wrong with it. The flag separates them; `ok` deliberately does
  // not change.
  it("distinguishes INCONCLUSIVE from a detected asymmetry", () => {
    const tooFew = checkSymmetry([pair()], SYMMETRY_TOLERANCE_PCT, SYMMETRY_MIN_CHECKABLE);
    expect(tooFew.inconclusive).toBe(true);
    expect(tooFew.ok).toBe(false); // still blocks retention -- unchanged behaviour
    expect(tooFew.failures.join(" ")).toContain("not a detected asymmetry");

    // A real asymmetry: both directions claim 70%, summing to 140%.
    const broken = checkSymmetry(
      [pair({ winsA: 700, gamesA: 1000, winsB: 700, gamesB: 1000 })],
      SYMMETRY_TOLERANCE_PCT,
      1
    );
    expect(broken.ok).toBe(false);
    expect(broken.inconclusive).toBe(false);
    expect(broken.failures.join(" ")).not.toContain("not a detected asymmetry");
  });

  it("a clean, sufficiently-sampled run is neither failed nor inconclusive", () => {
    const result = checkSymmetry([pair(), pair({ champB: 3 })], SYMMETRY_TOLERANCE_PCT, 2);
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("skips (doesn't count) a pair with a zero-games side", () => {
    const rows = [pair({ gamesA: 0 }), pair({ champB: 3 })];
    const result = checkSymmetry(rows, SYMMETRY_TOLERANCE_PCT, 1);
    expect(result.checked).toBe(1);
  });
});

describe("makeRealGuardDeps SQL wiring", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getHeroStats).mockReset();
  });

  it("getDraftBaseline queries draft_champ_stats scoped to patch/tier/role/champ", async () => {
    mockSql.mockResolvedValueOnce([{ winrate: 0.55 }]);
    const deps = makeRealGuardDeps(mockSql as never, "16.14");
    const result = await deps.getDraftBaseline(112, 2);
    expect(result).toBe(0.55);
    const text = sqlText(mockSql.mock.calls[0][0] as TemplateStringsArray);
    expect(text).toContain("FROM coachbuild.draft_champ_stats");
  });

  it("getDraftBaseline returns null when no row exists", async () => {
    mockSql.mockResolvedValueOnce([]);
    const deps = makeRealGuardDeps(mockSql as never, "16.14");
    expect(await deps.getDraftBaseline(999, 2)).toBeNull();
  });

  it("getGroundTruth delegates to getHeroStats and degrades to null on a thrown error", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: 51.2, gamesCount: 1000 });
    const deps = makeRealGuardDeps(mockSql as never, "16.14");
    expect(await deps.getGroundTruth(112, "mid")).toEqual({ winRatePct: 51.2 });

    vi.mocked(getHeroStats).mockRejectedValueOnce(new Error("coachless down"));
    expect(await deps.getGroundTruth(112, "mid")).toEqual({ winRatePct: null });
  });
});

describe("runDefaultIngestGuard / runSymmetryCheck (end-to-end SQL wiring)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getHeroStats).mockReset();
  });

  it("runDefaultIngestGuard runs the full DEFAULT_GUARD_PANEL against live deps", async () => {
    vi.mocked(getHeroStats).mockResolvedValue({ winRatePct: 50, gamesCount: 1000 });
    mockSql.mockResolvedValue([{ winrate: 0.5 }]);
    const result = await runDefaultIngestGuard(mockSql as never, "16.14");
    expect(result.checked).toBe(DEFAULT_GUARD_PANEL.length);
    expect(result.ok).toBe(true);
  });

  it("runSymmetryCheck queries symmetric matchup pairs and evaluates them", async () => {
    mockSql.mockResolvedValueOnce([
      { champ_a: 1, champ_b: 2, role: 0, wins_a: 550, games_a: 1000, wins_b: 450, games_b: 1000 },
    ]);
    const result = await runSymmetryCheck(mockSql as never, "16.14");
    const text = sqlText(mockSql.mock.calls[0][0] as TemplateStringsArray);
    expect(text).toContain("FROM coachbuild.draft_matchup m1");
    expect(text).toContain("JOIN coachbuild.draft_matchup m2");
    expect(result.checked).toBe(1);
  });
});
