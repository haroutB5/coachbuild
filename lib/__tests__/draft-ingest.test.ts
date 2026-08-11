/**
 * Tests for lib/draft/ingest.ts's orchestration: cursor/batch advance,
 * baselineWr derivation from matchup rows (not the rankings fetch),
 * retention (last-2-patches, final cursor only), fastFailOnRatelimit.
 * DB + u.gg network are both mocked — this is composition coverage, not
 * decode-logic coverage (see draft-ugg-decode.test.ts for that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

vi.mock("@/lib/draft/patch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/draft/patch")>();
  return { ...actual, resolveDraftPatchLabel: vi.fn() };
});

vi.mock("@/lib/draft/ugg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/draft/ugg")>();
  return {
    ...actual,
    resolveUggSchema: vi.fn(async () => ({ schema: "1.5", version: "1.5.0" })),
    makeSchemaProbe: vi.fn(() => async () => true),
    fetchMatchups: vi.fn(),
    fetchRankings: vi.fn(),
  };
});

// P0 guard (2026-07-21): mocked to a passing default here -- this file
// covers ORCHESTRATION (cursor/batch/retention wiring), not guard logic
// itself (see draft-ingestGuard.test.ts for that). A dedicated test below
// flips these to failing to prove retention actually gets gated on them.
vi.mock("@/lib/draft/ingestGuard", () => ({
  runDefaultIngestGuard: vi.fn(async () => ({ ok: true, checked: 20, failures: [], details: [] })),
  runSymmetryCheck: vi.fn(async () => ({ ok: true, checked: 100, failures: [], inconclusive: false })),
}));

// EXTERNAL matchup-direction tripwire (2026-07-21): mocked to a passing
// default here -- this file covers ORCHESTRATION (cursor/batch/retention
// wiring), not the check's own logic (see draft-lolalyticsCheck.test.ts for
// that). Dedicated tests below flip this to fail/indeterminate to prove the
// retention gate reacts correctly to each verdict.
vi.mock("@/lib/draft/lolalyticsCheck", () => ({
  runDefaultLolalyticsCheck: vi.fn(async () => ({ verdict: "pass", reason: "", pages: [], comparisons: [], disagreements: [] })),
  // v0.109.0: the real key must be re-exported by the mock. Omitting it made
  // the health write run with `undefined` as its pipeline name — silently, in
  // a passing suite, which is precisely the failure shape this whole release
  // is about.
  DIRECTION_CHECK_INGEST_KEY: "draft-direction-check",
}));

import { getSql } from "@/lib/pro/db";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import { fetchMatchups, fetchRankings } from "@/lib/draft/ugg";
import { runDefaultIngestGuard, runSymmetryCheck } from "@/lib/draft/ingestGuard";
import { runDefaultLolalyticsCheck } from "@/lib/draft/lolalyticsCheck";
import {
  runDraftIngest,
  BATCH_SIZE,
  __resetDraftPacerForTests,
  __setDraftPaceMsForTests,
  getPersistedCursor,
  setPersistedCursor,
} from "@/lib/draft/ingest";

function recentPatchesRows(patches: string[]) {
  return patches.map((patch) => ({ patch }));
}

describe("runDraftIngest", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    vi.mocked(resolveDraftPatchLabel).mockReset().mockResolvedValue("16.14");
    vi.mocked(fetchMatchups).mockReset();
    vi.mocked(fetchRankings).mockReset().mockResolvedValue({ byRole: {} });
    vi.mocked(runDefaultIngestGuard).mockReset().mockResolvedValue({ ok: true, checked: 20, failures: [], details: [] });
    vi.mocked(runSymmetryCheck).mockReset().mockResolvedValue({ ok: true, checked: 100, failures: [], inconclusive: false });
    vi.mocked(runDefaultLolalyticsCheck).mockReset().mockResolvedValue({
      verdict: "pass",
      reason: "",
      pages: [],
      comparisons: [],
      disagreements: [],
    });
    __resetDraftPacerForTests();
    __setDraftPaceMsForTests(0); // no real wall-clock pacing needed against a mocked transport

    // Content-based stub: every INSERT/DELETE resolves to [] by default;
    // the retention "recent patches" SELECT is stubbed per-test.
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join("");
      if (text.includes("GROUP BY patch")) {
        return Promise.resolve(recentPatchesRows(["16.14"]));
      }
      return Promise.resolve([]);
    });
  });

  it("advances the cursor by BATCH_SIZE and reports champCount", async () => {
    const champions = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });

    const first = await runDraftIngest({ cursor: 0, champions });
    expect(first.champStart).toBe(1);
    expect(first.champCount).toBe(BATCH_SIZE);
    expect(first.nextCursor).toBe(BATCH_SIZE);

    const last = await runDraftIngest({ cursor: 18, champions });
    expect(last.champCount).toBe(2); // 20 champions, cursor=18 -> champs 19,20
    expect(last.nextCursor).toBeNull();
  });

  it("does not request upstream data for skin/alternate-art champion IDs", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });

    const result = await runDraftIngest({
      cursor: 0,
      champions: [{ id: 1 }, { id: 60001 }, { id: 60002 }, { id: 60004 }],
    });

    expect(result.champStart).toBe(1);
    expect(result.champCount).toBe(1);
    expect(result.nextCursor).toBeNull();
    expect(fetchMatchups).toHaveBeenCalledTimes(1);
    expect(fetchMatchups).toHaveBeenCalledWith(1, expect.any(String), expect.anything(), expect.anything());
    expect(fetchRankings).toHaveBeenCalledTimes(1);
  });

  it("cursor past the end of the list -> no-op result, nextCursor stays null", async () => {
    const champions = [{ id: 1 }, { id: 2 }];
    const result = await runDraftIngest({ cursor: 99, champions });
    expect(result.champCount).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(fetchMatchups).not.toHaveBeenCalled();
  });

  it("derives champ_stats.winrate from the matchup rows themselves, not the rankings fetch", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({
      byRole: { 0: [{ oppId: 99, wins: 60, games: 100 }] },
      skippedRows: 0,
      tierMissing: false,
    });
    // rankings deliberately returns a DIFFERENT (wrong, if trusted) winrate-
    // shaped value to prove ingest never reads it for winrate.
    vi.mocked(fetchRankings).mockResolvedValue({ byRole: { 0: { pickrate: 0.05, banrate: 0.02 } } });

    await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });

    const statsCall = mockSql.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join("").includes("INSERT INTO coachbuild.draft_champ_stats")
    );
    expect(statsCall).toBeDefined();
    const values = statsCall!.slice(1); // interpolated template values in order
    // patch, tier, role, champ_id, winrate, pickrate, banrate, total_games
    expect(values).toContain(0.6); // 60/100 derived winrate
    expect(values).toContain(0.05); // pickrate passed through from rankings
    expect(values).toContain(0.02);
    expect(values).toContain(100); // audit P1-1: total_games (sum of `games` across all opponent rows)
  });

  it("champion with zero total games in a role contributes no champ_stats row for that role", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: { 0: [] }, skippedRows: 0, tierMissing: false });
    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.statsUpserted).toBe(0);
  });

  it("sums skippedRows across the batch", async () => {
    vi.mocked(fetchMatchups)
      .mockResolvedValueOnce({ byRole: {}, skippedRows: 2, tierMissing: false })
      .mockResolvedValueOnce({ byRole: {}, skippedRows: 3, tierMissing: false });
    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }, { id: 2 }] });
    expect(result.skippedRows).toBe(5);
  });

  it("retention prunes only on the FINAL batch (nextCursor === null), gated on a passing guard", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    const champions = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));

    const mid = await runDraftIngest({ cursor: 0, champions }); // not final (12 champs, batch 9 -> nextCursor=9)
    expect(mid.nextCursor).not.toBeNull();
    expect(mid.retentionRan).toBe(false);
    expect(mid.guardOk).toBeNull(); // guard never runs on a non-final batch
    expect(mid.lolalyticsVerdict).toBeNull(); // neither does the lolalytics tripwire
    expect(runDefaultIngestGuard).not.toHaveBeenCalled();
    expect(runDefaultLolalyticsCheck).not.toHaveBeenCalled();
    const pruneCallsMid = mockSql.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes("GROUP BY patch")
    );
    expect(pruneCallsMid).toHaveLength(0);

    mockSql.mockClear();
    const final = await runDraftIngest({ cursor: 9, champions }); // final batch
    expect(final.nextCursor).toBeNull();
    expect(final.guardOk).toBe(true);
    expect(final.lolalyticsVerdict).toBe("pass");
    expect(final.retentionRan).toBe(true);
    expect(runDefaultIngestGuard).toHaveBeenCalledWith(mockSql, "16.14");
    expect(runSymmetryCheck).toHaveBeenCalledWith(mockSql, "16.14");
    expect(runDefaultLolalyticsCheck).toHaveBeenCalledWith(mockSql, "16.14", expect.any(Array), undefined);
    const pruneCallsFinal = mockSql.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes("GROUP BY patch")
    );
    expect(pruneCallsFinal).toHaveLength(1);
    const deleteCalls = mockSql.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").startsWith("DELETE FROM coachbuild.draft_")
    );
    expect(deleteCalls).toHaveLength(2); // draft_matchup + draft_champ_stats
  });

  it("EXTERNAL tripwire: a FAILING lolalytics verdict skips retention even when the other two guards pass", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    vi.mocked(runDefaultLolalyticsCheck).mockResolvedValue({
      verdict: "fail",
      reason: "2 high-sample matchups disagree",
      pages: [],
      comparisons: [],
      disagreements: ["Viktor/mid vs Gragas: lolalytics 44.3% vs ours 55.7% (delta 11.4 > tolerance 4, n=5000)"],
    });

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.nextCursor).toBeNull();
    expect(result.guardOk).toBe(true); // the OTHER two guards still passed
    expect(result.lolalyticsVerdict).toBe("fail");
    expect(result.retentionRan).toBe(false);
    expect(result.errors.some((e) => e.includes("lolalytics matchup-direction tripwire FAILED"))).toBe(true);
    const pruneCalls = mockSql.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes("GROUP BY patch")
    );
    expect(pruneCalls).toHaveLength(0);
  });

  it("EXTERNAL tripwire: an INDETERMINATE lolalytics verdict does NOT block retention (scrape break, not an ingest failure)", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    vi.mocked(runDefaultLolalyticsCheck).mockResolvedValue({
      verdict: "indeterminate",
      reason: "only 2/5 high-sample matchups were comparable",
      pages: [],
      comparisons: [],
      disagreements: [],
    });

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.lolalyticsVerdict).toBe("indeterminate");
    expect(result.guardOk).toBe(true);
    expect(result.retentionRan).toBe(true);
  });

  it("EXTERNAL tripwire: a thrown lolalytics check is treated as indeterminate (non-blocking), never an uncaught failure", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    vi.mocked(runDefaultLolalyticsCheck).mockRejectedValue(new Error("lolalytics HTTP 500"));

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.lolalyticsVerdict).toBe("indeterminate");
    expect(result.retentionRan).toBe(true);
  });

  it("P0 guard: a FAILING cross-source panel skips retention and surfaces the failure (never silently trusted)", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    vi.mocked(runDefaultIngestGuard).mockResolvedValue({
      ok: false,
      checked: 15,
      failures: ["Viktor/mid: draft baseline 58.0% vs ground truth 50.5% (delta 7.5 > tolerance 4)"],
      details: [],
    });

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.nextCursor).toBeNull();
    expect(result.guardOk).toBe(false);
    expect(result.retentionRan).toBe(false);
    expect(result.errors.some((e) => e.includes("cross-source panel"))).toBe(true);
    const pruneCalls = mockSql.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join("").includes("GROUP BY patch")
    );
    expect(pruneCalls).toHaveLength(0); // pruneOldPatches never even attempted
  });

  it("P0 guard: a FAILING symmetry check also skips retention, independent of the panel result", async () => {
    vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
    vi.mocked(runSymmetryCheck).mockResolvedValue({
      ok: false,
      checked: 50,
      inconclusive: false, // a REAL detected asymmetry, not "too few pairs to judge"
      failures: ["champ 1 vs 2 (role 0): wr(A,B)=70.0% + wr(B,A)=70.0% = 140.0% (expected ~100%, delta 40.0 > tolerance 4)"],
    });

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
    expect(result.guardOk).toBe(false);
    expect(result.retentionRan).toBe(false);
    expect(result.errors.some((e) => e.includes("symmetry check"))).toBe(true);
  });

  // ── v0.109.0: the direction tripwire cannot retire silently ──────────────
  //
  // "indeterminate" means the ONLY external check on our matchup direction did
  // not run. It correctly does not block retention, and it correctly does not
  // fail the ingest — so before this it left no trace anywhere: the run
  // recorded a clean bill of health and the check could stop guarding forever
  // with nothing to show for it. Every verdict now writes a health row under
  // the check's OWN pipeline key, which /draft reads.
  describe("direction-tripwire health is recorded on every verdict", () => {
    function healthWrite(key: string) {
      const call = mockSql.mock.calls.find(
        ([strings, ...values]) =>
          (strings as TemplateStringsArray).join("|").includes("INSERT INTO coachbuild.ingest_health") && values[0] === key
      );
      // Tagged-template call shape: (strings, ingest, lastSuccessAt, ok, error, ...)
      return call ? { key: call[1], ok: call[3], error: call[4] } : null;
    }

    it("a PASS stamps the check as vouching", async () => {
      vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
      const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
      expect(result.lolalyticsVerdict).toBe("pass");
      const row = healthWrite("draft-direction-check");
      expect(row).not.toBeNull();
      expect(row!.ok).toBe(true);
      expect(row!.error).toBeNull();
    });

    it("an INDETERMINATE verdict is recorded as NOT vouching, with its reason -- while still not failing the ingest", async () => {
      vi.mocked(fetchMatchups).mockResolvedValue({ byRole: {}, skippedRows: 0, tierMissing: false });
      vi.mocked(runDefaultLolalyticsCheck).mockResolvedValueOnce({
        verdict: "indeterminate",
        reason: "only 2/5 high-sample matchups were comparable",
        pages: [],
        comparisons: [],
        disagreements: [],
      });
      const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }] });
      expect(result.lolalyticsVerdict).toBe("indeterminate");
      expect(result.retentionRan).toBe(true); // unchanged: indeterminate never blocks
      expect(result.errors).toEqual([]); // unchanged: indeterminate is not an ingest failure
      const row = healthWrite("draft-direction-check");
      expect(row!.ok).toBe(false); // ...but the CHECK is on record as not vouching
      expect(String(row!.error)).toContain("indeterminate");
      expect(String(row!.error)).toContain("only 2/5 high-sample matchups");
    });
  });

  it("fastFailOnRatelimit aborts the rest of the batch on a 403/429-shaped error", async () => {
    class FakeUggError extends Error {
      status: number;
      constructor(status: number) {
        super("blocked");
        this.status = status;
      }
    }
    vi.mocked(fetchMatchups)
      .mockRejectedValueOnce(new FakeUggError(403))
      .mockResolvedValueOnce({ byRole: {}, skippedRows: 0, tierMissing: false });

    const result = await runDraftIngest({
      cursor: 0,
      champions: [{ id: 1 }, { id: 2 }],
      fastFailOnRatelimit: true,
    });
    expect(fetchMatchups).toHaveBeenCalledTimes(1); // second champ never attempted
    expect(result.errors.length).toBe(1);
  });

  it("without fastFailOnRatelimit, a per-champion failure is logged and the batch continues", async () => {
    vi.mocked(fetchMatchups)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ byRole: {}, skippedRows: 0, tierMissing: false });

    const result = await runDraftIngest({ cursor: 0, champions: [{ id: 1 }, { id: 2 }] });
    expect(fetchMatchups).toHaveBeenCalledTimes(2); // both champs attempted
    expect(result.errors.length).toBe(1);
  });

  it("throws DbUnavailableError when getSql() returns null", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    await expect(runDraftIngest({ cursor: 0, champions: [{ id: 1 }] })).rejects.toThrow();
  });
});

describe("getPersistedCursor / setPersistedCursor (audit P1-2)", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("getPersistedCursor returns the stored value", async () => {
    mockSql.mockResolvedValueOnce([{ cursor: 63 }]);
    const cursor = await getPersistedCursor(mockSql as never);
    expect(cursor).toBe(63);
    expect((mockSql.mock.calls[0][0] as TemplateStringsArray).join("")).toContain(
      "SELECT cursor FROM coachbuild.draft_ingest_cursor"
    );
  });

  it("getPersistedCursor defaults to 0 when the row is somehow missing", async () => {
    mockSql.mockResolvedValueOnce([]);
    const cursor = await getPersistedCursor(mockSql as never);
    expect(cursor).toBe(0);
  });

  it("setPersistedCursor upserts the given value", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setPersistedCursor(mockSql as never, 27);
    const [strings, ...values] = mockSql.mock.calls[0];
    expect((strings as TemplateStringsArray).join("")).toContain("INSERT INTO coachbuild.draft_ingest_cursor");
    expect((strings as TemplateStringsArray).join("")).toContain("ON CONFLICT (id) DO UPDATE");
    expect(values).toContain(27);
  });
});
