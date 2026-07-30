/**
 * Tests for lib/mystats/ingest.ts's persisted BACKFILL cursor (mirrors
 * lib/draft/ingest.ts's getPersistedCursor/setPersistedCursor pattern —
 * see draft-ingest.test.ts for the analogous coverage on that file) and the
 * incremental-mode "always start=0" contract. sql + riot client + account
 * resolution are all mocked — no network/DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetMatchIdsByPuuid = vi.fn();
const mockGetMatch = vi.fn();
vi.mock("@/lib/pro/riot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pro/riot")>("@/lib/pro/riot");
  return {
    ...actual,
    getMatchIdsByPuuid: (...args: unknown[]) => mockGetMatchIdsByPuuid(...args),
    getMatch: (...args: unknown[]) => mockGetMatch(...args),
  };
});

const mockEnsureMyAccount = vi.fn();
// Migration 0020 renamed this to ensureActiveAccount ("the ACTIVE account",
// which is a different question from "the one account" the moment a second one
// is linked). Both names are provided: the module under test imports the new
// one, and the alias keeps this mock honest about what still exists on the real
// module's surface.
vi.mock("@/lib/mystats/account", () => ({
  ensureActiveAccount: (...args: unknown[]) => mockEnsureMyAccount(...args),
  ensureMyAccount: (...args: unknown[]) => mockEnsureMyAccount(...args),
}));

// v0.51 additions: ingest.ts now resolves a build-adherence recommendation
// (lib/recommend.ts) gated on the CURRENT live patch (lib/staticData.ts's
// getLatestPatch) -- mocked here so these tests never make a real network
// call. Every existing fixture below plays out on patch "16.13" or an
// explicitly pre-season/older patch, so defaulting getLatestPatch to "16.13"
// keeps every pre-existing assertion (none of which check on_wpa_build)
// unaffected -- see mystats-adherence.test.ts / lib/__tests__/patchMovers.test.ts
// for dedicated coverage of the adherence/recommend-resolution logic itself.
vi.mock("@/lib/staticData", () => ({
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 13, patchAdditions: 0, label: "16.13" })),
}));
vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return { buildRecommendations: vi.fn(async () => []), NotPlayedInRoleError };
});

import { getSql } from "@/lib/pro/db";
import {
  runMyStatsIngest,
  PAGE_SIZE,
  INCREMENTAL_PAGE_SIZE,
  INCREMENTAL_CATCHUP_PAGE_SIZE,
  INCREMENTAL_DEPTH_CAP,
  INCREMENTAL_MAX_PAGES,
} from "@/lib/mystats/ingest";
import { seasonStartEpochSec } from "@/lib/mystats/season";

const ACCOUNT = {
  id: 1,
  puuid: "my-puuid",
  riotId: "MunsterHunter#EUW",
  gameName: "MunsterHunter",
  tagLine: "EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

describe("runMyStatsIngest", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetMatchIdsByPuuid.mockReset();
    mockGetMatch.mockReset();
    mockEnsureMyAccount.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    process.env.RIOT_API_KEY = "test-key";
    process.env.DATABASE_URL = "postgres://test";
  });

  it("accountUnresolved short-circuits before any Riot call", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(null);
    const result = await runMyStatsIngest({ mode: "incremental" });
    expect(result.accountUnresolved).toBe(true);
    expect(mockGetMatchIdsByPuuid).not.toHaveBeenCalled();
  });

  it("incremental mode always fetches start=0 and never persists an offset", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) {
        return Promise.resolve([{ next_start: 0, backfill_done: true }]); // steady state
      }
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([{ match_id: "M1" }]); // M1 already known
      return Promise.resolve([]);
    });
    mockGetMatch.mockResolvedValueOnce({
      metadata: { matchId: "M2" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1), // in-season (2026-02-01)
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "incremental" });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 0,
      count: expect.any(Number),
      startTime: seasonStartEpochSec(),
    });
    expect(result.matchesSeen).toBe(2);
    expect(result.matchesUpserted).toBe(1); // M1 skipped (already known), M2 new
    expect(result.nextStart).toBeNull();
    // `next_start` is backfill mode's resume offset and incremental must never
    // write it -- two writers to one column with different meanings is the thing
    // the 2026-07-30 reconciliation exists to avoid.
    const offsetWrite = mockSql.mock.calls.find(([s]) =>
      sqlText(s as TemplateStringsArray).includes("my_ingest_cursor (puuid, next_start")
    );
    expect(offsetWrite).toBeUndefined();
  });

  it("backfill mode reads the persisted cursor when no explicit start is given", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) {
        return Promise.resolve([{ next_start: 200, backfill_done: false }]);
      }
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce([]); // empty page -> exhausted history

    await runMyStatsIngest({ mode: "backfill" });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 200,
      count: PAGE_SIZE,
      startTime: seasonStartEpochSec(),
    });
  });

  it("an explicit start overrides the persisted cursor AND is never persisted back", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    let cursorTableTouched = false;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("my_ingest_cursor")) cursorTableTouched = true;
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce([]); // empty page -> exhausted

    const result = await runMyStatsIngest({ mode: "backfill", start: 999 });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 999,
      count: PAGE_SIZE,
      startTime: seasonStartEpochSec(),
    });
    expect(cursorTableTouched).toBe(false); // manual/debug driving never reads OR writes persisted state
    expect(result.nextStart).toBeNull();
  });

  it("a short page (fewer than pageSize) ends the backfill walk and persists next_start=0, backfill_done=true", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    let persisted: { puuid: string; next_start: number; backfill_done: boolean } | null = null;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: false }]);
      if (text.includes("INSERT INTO coachbuild.my_ingest_cursor")) {
        // Migration 0020: the cursor is keyed by puuid, so it is now the FIRST
        // bound value -- asserted here rather than skipped, because a cursor
        // written without the right puuid is the exact silent cross-account
        // write that migration set out to make impossible.
        persisted = {
          puuid: values[0] as string,
          next_start: values[1] as number,
          backfill_done: values[2] as boolean,
        };
        return Promise.resolve([]);
      }
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]); // short page (< pageSize)
    mockGetMatch.mockResolvedValue({
      metadata: { matchId: "X" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1),
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "backfill", pageSize: 50 });

    expect(result.nextStart).toBeNull();
    expect(persisted).toEqual({ puuid: "my-puuid", next_start: 0, backfill_done: true });
  });

  it("hitting BACKFILL_CAP ends the walk even if more history remains (full pages every time)", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: false }]);
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    // Every page comes back FULL (100 ids) -- would never naturally stop.
    mockGetMatchIdsByPuuid.mockImplementation((_r: string, _p: string, opts: { count: number }) =>
      Promise.resolve(Array.from({ length: opts.count }, (_, i) => `M${i}`))
    );
    mockGetMatch.mockResolvedValue({
      metadata: { matchId: "X" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1),
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "backfill" });

    expect(result.matchesSeen).toBe(400); // BACKFILL_CAP
    expect(result.nextStart).toBeNull();
  });

  it("does nothing (fast no-op) when backfill_done is already true and no explicit start is given", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: true }]);
      return Promise.resolve([]);
    });

    const result = await runMyStatsIngest({ mode: "backfill" });

    expect(mockGetMatchIdsByPuuid).not.toHaveBeenCalled();
    expect(result.matchesSeen).toBe(0);
    expect(result.nextStart).toBeNull();
  });

  it("a match already in coachbuild.my_matches is never re-fetched from Riot (ON CONFLICT idempotency at the id-check level)", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([{ match_id: "M1" }, { match_id: "M2" }]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]);

    const result = await runMyStatsIngest({ mode: "incremental" });

    expect(mockGetMatch).not.toHaveBeenCalled();
    expect(result.matchesUpserted).toBe(0);
    expect(result.matchesSeen).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // INCREMENTAL PAGES UNTIL OVERLAP (2026-07-30, P1). Before this, incremental
  // fetched ONE page of 30 and stopped, and nothing anywhere schedules backfill
  // -- so a newly linked account got its newest 30 games and nothing older,
  // ever, under a "Season 2026" label, and an account switched away from for
  // more than 30 games lost the ones that fell off the back of that page.
  //
  // Three properties are pinned below and a wrong loop breaks each differently:
  //  (1) TERMINATION -- stop on overlap, but ONLY when the history is already
  //      known complete. Get this wrong in one direction and games are missed;
  //      in the other, every page view re-walks a whole season of the shared
  //      Riot key.
  //  (2) THE WINDOW -- every id page carries startTime = season start, and the
  //      walk ends when Riot runs out of ids inside it. It must never reach
  //      further back.
  //  (3) THE CAP IS RECORDED -- a run stopped by a per-run limit must report
  //      truncatedBy, report historyComplete:false, and CLEAR the persisted
  //      flag. A silent truncation reads as "fully synced", which is the same
  //      defect one level up.
  // ───────────────────────────────────────────────────────────────────────────
  describe("incremental pages until overlap (2026-07-30)", () => {
    interface CursorRow {
      next_start: number;
      backfill_done: boolean;
    }
    interface Harness {
      /** Every id page requested, in order: { start, count, startTime }. */
      idPages: { start: number; count: number; startTime: number }[];
      /** Match ids stored for this account. GROWS as the walk inserts, which is
       *  what makes the overlap condition observable at all. */
      stored: Set<string>;
      /** backfill_done values written via persistHistoryComplete, in order. */
      flagWrites: boolean[];
      /** The cursor row as the DB now holds it — MUTATED by a flag write, so a
       *  test can run the ingest twice and have the second run see what the first
       *  one persisted. Convergence across runs is a real property here (the
       *  default call budget is sized for a 60s serverless invocation, not for a
       *  whole season), so it has to be testable. */
      cursor: CursorRow | null;
      /** next_start values written via persistCursor (backfill mode's writer) --
       *  must stay EMPTY for every incremental run. */
      offsetWrites: number[];
      logs: string[];
    }

    /** Wires the mocks to a fake newest-first Riot history plus a fake cursor
     *  row, and returns the observable state. `history` is the whole season
     *  window; a page request past its end comes back short, which is exactly how
     *  the real endpoint signals the window is exhausted. */
    function harness(opts: { history: string[]; stored?: string[]; cursor?: CursorRow | null }): Harness {
      const h: Harness = {
        idPages: [],
        stored: new Set(opts.stored ?? []),
        flagWrites: [],
        cursor: opts.cursor ?? null,
        offsetWrites: [],
        logs: [],
      };
      mockEnsureMyAccount.mockResolvedValue(ACCOUNT);

      mockGetMatchIdsByPuuid.mockImplementation(
        (_r: string, _p: string, o: { start: number; count: number; startTime: number }) => {
          h.idPages.push({ start: o.start, count: o.count, startTime: o.startTime });
          return Promise.resolve(opts.history.slice(o.start, o.start + o.count));
        }
      );

      mockGetMatch.mockImplementation((_r: string, matchId: string) =>
        Promise.resolve({
          metadata: { matchId },
          info: {
            gameCreation: Date.UTC(2026, 3, 1), // in-season
            gameVersion: "16.13.1.1",
            queueId: 420,
            participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
          },
        })
      );

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = sqlText(strings);
        if (text.includes("SELECT next_start, backfill_done")) {
          return Promise.resolve(h.cursor === null ? [] : [h.cursor]);
        }
        if (text.includes("SELECT match_id FROM coachbuild.my_matches")) {
          const ids = values[1] as string[];
          return Promise.resolve(ids.filter((id) => h.stored.has(id)).map((id) => ({ match_id: id })));
        }
        if (text.includes("INSERT INTO coachbuild.my_matches")) {
          h.stored.add(values[1] as string);
          return Promise.resolve([]);
        }
        if (text.includes("my_ingest_cursor (puuid, backfill_done")) {
          const done = values[1] as boolean;
          h.flagWrites.push(done);
          h.cursor = { next_start: h.cursor?.next_start ?? 0, backfill_done: done };
          return Promise.resolve([]);
        }
        if (text.includes("my_ingest_cursor (puuid, next_start")) {
          h.offsetWrites.push(values[1] as number);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      return h;
    }

    const onProgress = (h: Harness) => (msg: string) => h.logs.push(msg);

    it("(1) STEADY STATE: a known-complete history stops at the first page containing a stored game", async () => {
      // 200 games in the window, the newest 199 already stored, 1 new. One id
      // page is the whole cost -- this is the case that runs on every page view,
      // so it has to stay cheap.
      const history = Array.from({ length: 200 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history.slice(1),
        cursor: { next_start: 0, backfill_done: true },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(h.idPages).toEqual([
        { start: 0, count: INCREMENTAL_PAGE_SIZE, startTime: seasonStartEpochSec() },
      ]);
      expect(result.matchesUpserted).toBe(1);
      expect(result.historyComplete).toBe(true);
      expect(result.truncatedBy).toBeNull();
      expect(result.pagesWalked).toBe(1);
      // Already true, still true -> nothing to write. A page view must not cost a
      // cursor UPDATE.
      expect(h.flagWrites).toEqual([]);
    });

    it("(1) CAUGHT-UP-FROM-BEHIND: more new games than one page, pages forward and stops on the page that overlaps", async () => {
      // The "switched away, played 70 games, switched back" case. The old
      // one-page-and-stop behaviour lost games 31..70 permanently.
      const history = Array.from({ length: 200 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history.slice(70), // newest 70 unseen
        cursor: { next_start: 0, backfill_done: true },
      });

      // callBudget raised so this test measures the LOOP, not the budget --
      // convergence under the real (serverless-sized) default has its own test
      // below.
      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 500 });

      // Pages 0/30/60 -- the third contains G70, which is stored -> overlap.
      expect(h.idPages.map((p) => p.start)).toEqual([0, 30, 60]);
      expect(result.matchesUpserted).toBe(70);
      expect(result.historyComplete).toBe(true);
      expect(result.truncatedBy).toBeNull();
      expect(h.flagWrites).toEqual([]); // was complete, still complete
    });

    it("(3) CONVERGES ACROSS RUNS: the default budget truncates a big catch-up, and the NEXT run finishes it", async () => {
      // THE property that makes a serverless-sized budget acceptable. The default
      // INCREMENTAL_CALL_BUDGET cannot fetch 70 matches in one 60s invocation, so
      // run 1 must stop, say so, and clear the flag; run 2 must then decline to
      // stop at the false overlap run 1 created and finish the job. If either
      // half is wrong, games are lost silently -- which is the original bug.
      const history = Array.from({ length: 200 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history.slice(70),
        cursor: { next_start: 0, backfill_done: true },
      });

      const first = await runMyStatsIngest({ mode: "incremental", onProgress: onProgress(h) });
      expect(first.truncatedBy).not.toBeNull();
      expect(first.historyComplete).toBe(false);
      expect(h.cursor?.backfill_done).toBe(false);
      expect(h.stored.size).toBeLessThan(200); // did NOT get everything

      // Run 2 sees backfill_done = false, so overlap on page 0 is not a licence
      // to stop.
      const second = await runMyStatsIngest({ mode: "incremental", callBudget: 500, onProgress: onProgress(h) });
      expect(second.truncatedBy).toBeNull();
      expect(second.historyComplete).toBe(true);
      expect(h.stored.size).toBe(200); // every game, eventually, with none skipped
      expect(h.flagWrites).toEqual([false, true]);
    });

    it("(1) SOUNDNESS: a history NOT known complete does NOT stop at the first overlap -- it walks the window", async () => {
      // THE trap this design exists to avoid. A run that stopped part-way leaves
      // a fresh block stored at the FRONT; if overlap alone ended the next walk,
      // it would stop on page 0 and declare itself synced over the hole. With
      // backfill_done false, overlap is not a licence to stop.
      const history = Array.from({ length: 150 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history.slice(0, 40), // the FRONT is stored, everything older is not
        cursor: { next_start: 0, backfill_done: false },
      });

      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 500 });

      // Page 0 overlaps immediately and the walk keeps going anyway.
      expect(h.idPages.length).toBeGreaterThan(1);
      expect(h.stored.size).toBe(150); // the hole is filled, not skipped over
      expect(result.historyComplete).toBe(true);
      expect(result.truncatedBy).toBeNull();
      expect(h.flagWrites).toEqual([true]); // false -> true, earned by reaching the end
    });

    it("(1) FRESH ACCOUNT: nothing stored, no cursor row -- 'until overlap' becomes the backfill, with no separate trigger", async () => {
      const history = Array.from({ length: 120 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: [], cursor: null });

      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 500 });

      expect(h.stored.size).toBe(120);
      expect(result.matchesUpserted).toBe(120);
      expect(result.historyComplete).toBe(true);
      expect(h.flagWrites).toEqual([true]);
      // A catch-up uses the LARGER page: one Riot call per 100 ids instead of per
      // 30, which is what keeps re-scanning stored territory cheap.
      expect(h.idPages[0].count).toBe(INCREMENTAL_CATCHUP_PAGE_SIZE);
    });

    it("(2) WINDOW: every id page carries the season startTime, and a short page ends the walk", async () => {
      const history = Array.from({ length: 250 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: [], cursor: null });

      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 500 });

      expect(h.idPages.every((p) => p.startTime === seasonStartEpochSec())).toBe(true);
      // 100 + 100 + 50: the third page is short, which IS the window boundary.
      expect(h.idPages.map((p) => p.start)).toEqual([0, 100, 200]);
      // And it stops there -- it never asks for a page past the end of the window.
      expect(h.idPages.some((p) => p.start >= 250)).toBe(false);
      expect(result.historyComplete).toBe(true);
    });

    it("(2) WINDOW: the depth cap is CLAMPED, never overshot, even with an awkward caller pageSize", async () => {
      // 150 does not divide INCREMENTAL_DEPTH_CAP. Unclamped, the third page would
      // ask for ids 300..449 -- 50 past the depth this feature walks, i.e. Riot
      // calls spent on games it has already decided to ignore.
      const history = Array.from({ length: 1000 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: history, cursor: null });

      const result = await runMyStatsIngest({ mode: "incremental", pageSize: 150 });

      const reach = h.idPages.reduce((max, p) => Math.max(max, p.start + p.count), 0);
      expect(reach).toBe(INCREMENTAL_DEPTH_CAP);
      expect(result.historyComplete).toBe(true);
      expect(result.truncatedBy).toBeNull();
    });

    it("(2) WINDOW: the depth cap ends a bottomless history as complete-to-policy-depth, matching BACKFILL_CAP", async () => {
      // A history longer than this feature walks. Ends at INCREMENTAL_DEPTH_CAP,
      // which is BACKFILL_CAP by construction so the two paths cannot disagree
      // about where "as deep as we go" is.
      const history = Array.from({ length: INCREMENTAL_DEPTH_CAP + 500 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: history, cursor: null }); // all stored -> zero getMatch calls

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(mockGetMatch).not.toHaveBeenCalled();
      const lastPage = h.idPages[h.idPages.length - 1];
      expect(lastPage.start + lastPage.count).toBe(INCREMENTAL_DEPTH_CAP);
      expect(result.historyComplete).toBe(true);
      expect(result.truncatedBy).toBeNull();
      expect(h.idPages.length).toBeLessThanOrEqual(INCREMENTAL_MAX_PAGES);
    });

    it("(3) CAP IS RECORDED: the call budget stopping a walk reports truncatedBy, refuses to claim completeness, and logs it", async () => {
      const history = Array.from({ length: 500 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: [], cursor: null });

      // 1 id page + 4 match fetches, then the budget is gone -- deep in the
      // middle of the window, nowhere near overlap or exhaustion.
      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 5, onProgress: onProgress(h) });

      expect(result.truncatedBy).toContain("Riot call budget");
      expect(result.historyComplete).toBe(false);
      expect(result.matchesUpserted).toBe(4);
      // The DURABLE half of the record: false, so the next run resumes the
      // catch-up instead of stopping at the overlap it just created.
      expect(h.flagWrites).toEqual([false]);
      expect(h.logs.some((l) => l.includes("INCOMPLETE SYNC"))).toBe(true);
    });

    it("(3) CAP IS RECORDED: a truncated front-fill CLEARS a previously-true flag -- the false-overlap trap", async () => {
      // The nastiest case. The account WAS complete; the user then played more
      // games than one run can fetch. Storing a fresh front block and leaving
      // backfill_done = true would make the next run find overlap on page 0 and
      // report "synced" over the gap in between.
      const history = Array.from({ length: 300 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history.slice(200), // 200 new games at the front
        cursor: { next_start: 0, backfill_done: true },
      });

      const result = await runMyStatsIngest({ mode: "incremental", callBudget: 6, onProgress: onProgress(h) });

      expect(result.truncatedBy).not.toBeNull();
      expect(result.historyComplete).toBe(false);
      expect(h.flagWrites).toEqual([false]); // true -> false. This is the fix.
      expect(h.logs.some((l) => l.includes("INCOMPLETE SYNC"))).toBe(true);
    });

    it("(3) CAP IS RECORDED: the wall-clock deadline is recorded the same way as the call budget", async () => {
      // The deadline exists because resolveRecommendedBuild's coachless lookups
      // are not paced and not individually bounded, so call count alone cannot
      // honour the callers' maxDuration = 60.
      const history = Array.from({ length: 500 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: history, cursor: null }); // all stored: no match fetches, so only the clock can stop it
      let t = 0;
      const now = () => {
        t += 5_000; // 5s of wall clock per consultation
        return t;
      };

      const result = await runMyStatsIngest({
        mode: "incremental",
        callBudget: 500,
        deadlineMs: 20_000,
        now,
        onProgress: onProgress(h),
      });

      expect(result.truncatedBy).toContain("deadline");
      expect(result.historyComplete).toBe(false);
      expect(h.flagWrites).toEqual([false]);
    });

    it("(3) `deadlineMs: null` opts a long-running script out of the clock, and nothing else changes", async () => {
      const history = Array.from({ length: 120 }, (_, i) => `G${i}`);
      const h = harness({ history, stored: [], cursor: null });

      const result = await runMyStatsIngest({
        mode: "incremental",
        callBudget: 500,
        deadlineMs: null,
        now: () => Number.MAX_SAFE_INTEGER, // would trip any finite deadline instantly
      });

      expect(result.truncatedBy).toBeNull();
      expect(result.historyComplete).toBe(true);
      expect(h.stored.size).toBe(120);
    });

    it("IDEMPOTENT: re-running a complete walk stores nothing new and makes no match fetches", async () => {
      const history = Array.from({ length: 40 }, (_, i) => `G${i}`);
      const h = harness({
        history,
        stored: history,
        cursor: { next_start: 0, backfill_done: true },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(mockGetMatch).not.toHaveBeenCalled();
      expect(result.matchesUpserted).toBe(0);
      expect(result.historyComplete).toBe(true);
      expect(h.stored.size).toBe(40);
      expect(h.offsetWrites).toEqual([]);
    });
  });

  describe("season row-level guard (belt-and-braces, 2026-07-21)", () => {
    it("a pre-season match that slips through the startTime list filter is fetched but NEVER inserted", async () => {
      mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
      let insertCalled = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
        if (text.includes("INSERT INTO coachbuild.my_matches")) {
          insertCalled = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockGetMatchIdsByPuuid.mockResolvedValueOnce(["PRESEASON1"]);
      mockGetMatch.mockResolvedValueOnce({
        metadata: { matchId: "PRESEASON1" },
        info: {
          gameCreation: Date.UTC(2025, 11, 1), // 2025-12-01 -- before the season boundary
          gameVersion: "15.24.1.1",
          queueId: 420,
          participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
        },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(insertCalled).toBe(false);
      expect(result.matchesUpserted).toBe(0);
      expect(result.matchesSeen).toBe(1); // still counted as "seen" -- only the insert is skipped
    });

    it("an in-season match (just after the boundary) IS inserted", async () => {
      mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
      let insertCalled = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("SELECT match_id FROM coachbuild.my_matches")) return Promise.resolve([]);
        if (text.includes("INSERT INTO coachbuild.my_matches")) {
          insertCalled = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockGetMatchIdsByPuuid.mockResolvedValueOnce(["INSEASON1"]);
      mockGetMatch.mockResolvedValueOnce({
        metadata: { matchId: "INSEASON1" },
        info: {
          gameCreation: Date.UTC(2026, 0, 8, 0, 0, 1), // 1s after the season boundary
          gameVersion: "16.1.1.1",
          queueId: 420,
          participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
        },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(insertCalled).toBe(true);
      expect(result.matchesUpserted).toBe(1);
    });
  });
});
