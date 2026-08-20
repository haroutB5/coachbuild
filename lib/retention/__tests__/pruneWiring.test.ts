/**
 * Where the retention prune actually RUNS.
 *
 * lib/retention/__tests__/prune.test.ts proves the prune emits the right SQL.
 * This file proves it is reachable from real ingest code at the right moment —
 * a correct prune that never fires is the same as no retention policy, and
 * that is precisely the state these four tables were already in.
 *
 * The design constraint these tests encode: NO NEW SCHEDULED TASK. The incident
 * this retention work cleans up after was caused by an unattended scheduled
 * task with a bad cadence, so the prune is folded into ingests that already
 * run. That makes "does it fire, and does it fire ONCE per sweep rather than
 * once per page" a correctness property, not a detail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface RawSql {
  __raw: string;
}
const isRaw = (v: unknown): v is RawSql =>
  typeof v === "object" && v !== null && "__raw" in (v as Record<string, unknown>);

interface RecordedQuery {
  text: string;
  params: unknown[];
}

const queries: RecordedQuery[] = [];
/** Rows still eligible for deletion, per table. */
let backlog: Record<string, number> = {};
/** When true every query rejects — the live condition as this ships. */
let deadDatabase = false;
/** Rows the pro_accounts selection query returns. Region "ZZ" is unmapped, so
 *  ingestOneAccount takes its cheap "skip and stamp" path and no Riot call is
 *  made — enough to make the walk report a FULL page (mid-sweep) without
 *  simulating a match ingest. */
let proAccounts: Array<{ puuid: string; pro_id: string; region: string; riot_id: string }> = [];

const CUTOFF = "2026-05-15T12:00:00.000Z";

const mockSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((chunk, i) => {
    text += chunk;
    if (i < values.length) {
      const v = values[i];
      if (isRaw(v)) text += v.__raw;
      else {
        params.push(v);
        text += `$${params.length}`;
      }
    }
  });
  const q: RecordedQuery = { text, params };
  queries.push(q);

  if (deadDatabase) return Promise.reject(new Error("402 Payment Required: quota exceeded"));
  if (text.includes("AS cutoff")) return Promise.resolve([{ cutoff: CUTOFF }]);
  if (text.includes("FROM coachbuild.pro_accounts") && /^\s*SELECT puuid, pro_id/.test(text)) {
    return Promise.resolve(proAccounts);
  }
  if (/DELETE FROM/.test(text)) return Promise.resolve([]);
  if (/^\s*SELECT\s/.test(text) && text.includes("<= $1::timestamptz")) {
    const table = /coachbuild\.(\w+)/.exec(text)?.[1] ?? "";
    const limit = params[params.length - 1] as number;
    const n = Math.min(limit, backlog[table] ?? 0);
    backlog[table] = (backlog[table] ?? 0) - n;
    return Promise.resolve(Array.from({ length: n }, (_, i) => ({ k1: `a${i}`, k2: `b${i}` })));
  }
  return Promise.resolve([]);
}) as unknown as { (): unknown; unsafe: (raw: string) => RawSql };
mockSql.unsafe = (raw: string) => ({ __raw: raw });

vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

// Riot is mocked for the whole file: no test here ingests a real match, and
// the rate-limit case needs to drive `isRateLimited` directly. lib/otp/ingest
// .ts imports the same module by relative path, so both call sites are covered.
vi.mock("@/lib/pro/riot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pro/riot")>();
  return {
    ...actual,
    getMatchIdsByPuuid: vi.fn(async () => [] as string[]),
    isRateLimited: vi.fn(() => false),
  };
});

import { getMatchIdsByPuuid, isRateLimited } from "@/lib/pro/riot";
import { runMatchIngest } from "@/lib/pro/ingestMatches";
import { runProstageIngest } from "@/lib/prostage/ingest";
import { runOtpMatchIngest } from "@/lib/otp/ingest";

const retentionQueries = () =>
  queries.filter(
    (q) =>
      q.text.includes("AS cutoff") ||
      q.params.some((p) => typeof p === "string" && p.startsWith("retention:")) ||
      (/DELETE FROM/.test(q.text) && q.text.includes("unnest("))
  );

const prunedTables = () =>
  Array.from(
    new Set(
      queries
        .filter((q) => /DELETE FROM/.test(q.text) && q.text.includes("unnest("))
        .map((q) => /DELETE FROM coachbuild\.(\w+)/.exec(q.text)?.[1] ?? "?")
    )
  );

const healthKeysTouched = () =>
  Array.from(
    new Set(
      queries.flatMap((q) =>
        q.params.filter((p): p is string => typeof p === "string" && p.startsWith("retention:"))
      )
    )
  );

beforeEach(() => {
  queries.length = 0;
  backlog = {};
  deadDatabase = false;
  proAccounts = [];
  vi.mocked(getMatchIdsByPuuid).mockReset().mockResolvedValue([]);
  vi.mocked(isRateLimited).mockReset().mockReturnValue(false);
  process.env.RIOT_API_KEY = "test-key";
});

// ─────────────────────────────────────────────────────────────────────────────
describe("runMatchIngest (pro_matches)", () => {
  it("prunes pro_matches when the sweep DRAINS, and deletes the eligible rows", async () => {
    backlog.pro_matches = 900;
    const result = await runMatchIngest({ batch: 5 });

    expect(result.nextCursor).toBeNull(); // sweep drained
    expect(healthKeysTouched()).toContain("retention:pro_matches");
    expect(prunedTables()).toEqual(["pro_matches"]);
    expect(backlog.pro_matches).toBe(0);
  });

  it("does NOT prune mid-sweep — once per sweep, not once per page", async () => {
    // A full page (accounts.length === batch) means the walk continues, so
    // nextCursor is non-null. Pruning here would fire ~289 times per real
    // 1,445-account sweep instead of once.
    backlog.pro_matches = 900;
    proAccounts = [{ puuid: "p1", pro_id: "x", region: "ZZ", riot_id: "A#EUW" }];
    const result = await runMatchIngest({ batch: 1 }); // page is FULL (1 of 1)

    expect(result.nextCursor).not.toBeNull();
    expect(retentionQueries()).toHaveLength(0);
    expect(backlog.pro_matches).toBe(900);
  });

  it("does NOT prune after a rate-limited abort, even though that also nulls the cursor", async () => {
    // A 429 abort accomplished nothing. Spending metered database time tidying
    // up after a walk that could not run is the wrong instinct — and the
    // cursor being null here is an abort signal, not a drain signal.
    backlog.pro_matches = 900;
    proAccounts = [{ puuid: "p1", pro_id: "x", region: "EUW", riot_id: "A#EUW" }];
    vi.mocked(getMatchIdsByPuuid).mockRejectedValue(new Error("429 rate limited"));
    vi.mocked(isRateLimited).mockReturnValue(true);

    const result = await runMatchIngest({ batch: 5 });

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(retentionQueries()).toHaveLength(0);
    expect(backlog.pro_matches).toBe(900);
  });

  it("prune:false disables it entirely", async () => {
    backlog.pro_matches = 900;
    await runMatchIngest({ batch: 5, prune: false });
    expect(retentionQueries()).toHaveLength(0);
  });

  it("touches ONLY pro_matches — no ingest prunes a table it does not own", async () => {
    backlog.pro_matches = 100;
    backlog.otp_matches = 100;
    backlog.prostage_matches = 100;
    backlog.otp_featured_scanned = 100;
    await runMatchIngest({ batch: 5 });
    expect(prunedTables()).toEqual(["pro_matches"]);
    expect(backlog.otp_matches).toBe(100);
    expect(backlog.prostage_matches).toBe(100);
    expect(backlog.otp_featured_scanned).toBe(100);
  });

  it("a DEAD database does not fail the ingest — the live condition as this ships", async () => {
    // Every Neon query 402s right now. The ingest itself throws before reaching
    // the prune in that case; this asserts the other ordering — the database
    // dying DURING the sweep, after the account query succeeded.
    let firstDone = false;
    const dying = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (firstDone) return Promise.reject(new Error("402 Payment Required"));
      firstDone = true;
      return (mockSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(
        strings,
        ...values
      );
    }) as unknown as typeof mockSql;
    (dying as unknown as { unsafe: (r: string) => RawSql }).unsafe = mockSql.unsafe;

    const { getSql } = await import("@/lib/pro/db");
    vi.mocked(getSql).mockReturnValueOnce(dying as never);

    const result = await runMatchIngest({ batch: 5 });
    expect(result.errors).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("runProstageIngest (prostage_matches)", () => {
  it("prunes prostage_matches on the last tournament of the walk", async () => {
    backlog.prostage_matches = 400;
    const result = await runProstageIngest({
      tournaments: ["LEC/2026 Season/Summer Season"],
      cursor: 0,
      queryFn: async () => [],
    });

    expect(result.nextCursor).toBeNull();
    expect(healthKeysTouched()).toContain("retention:prostage_matches");
    expect(prunedTables()).toEqual(["prostage_matches"]);
    expect(backlog.prostage_matches).toBe(0);
  });

  it("does NOT prune while tournaments remain", async () => {
    backlog.prostage_matches = 400;
    const result = await runProstageIngest({
      tournaments: ["A", "B"],
      cursor: 0,
      queryFn: async () => [],
    });
    expect(result.nextCursor).toBe(1);
    expect(retentionQueries()).toHaveLength(0);
  });

  it("prunes on game_datetime — never game_creation, which this table lacks", async () => {
    backlog.prostage_matches = 10;
    await runProstageIngest({ tournaments: ["A"], cursor: 0, queryFn: async () => [] });
    const select = queries.find(
      (q) => q.text.includes("coachbuild.prostage_matches") && q.text.includes("<= $1::timestamptz")
    );
    expect(select).toBeDefined();
    expect(select!.text).toContain("game_datetime <= $1::timestamptz");
    expect(select!.text).not.toContain("game_creation");
  });

  it("prune:false disables it", async () => {
    backlog.prostage_matches = 400;
    await runProstageIngest({
      tournaments: ["A"],
      cursor: 0,
      queryFn: async () => [],
      prune: false,
    });
    expect(retentionQueries()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("runOtpMatchIngest (otp_featured_scanned)", () => {
  it("prunes the scan ledger on scanned_at", async () => {
    backlog.otp_featured_scanned = 5000;
    await runOtpMatchIngest({ batch: 8 });

    expect(healthKeysTouched()).toContain("retention:otp_featured_scanned");
    expect(prunedTables()).toEqual(["otp_featured_scanned"]);
    const select = queries.find(
      (q) =>
        q.text.includes("coachbuild.otp_featured_scanned") && q.text.includes("<= $1::timestamptz")
    );
    expect(select!.text).toContain("scanned_at <= $1::timestamptz");
  });

  it("NEVER prunes otp_matches — it is still served unbounded by /api/otp/featured", async () => {
    backlog.otp_matches = 5000;
    backlog.otp_featured_scanned = 10;
    await runOtpMatchIngest({ batch: 8 });

    expect(prunedTables()).not.toContain("otp_matches");
    expect(healthKeysTouched()).not.toContain("retention:otp_matches");
    expect(backlog.otp_matches).toBe(5000);
  });

  it("prune:false disables it", async () => {
    backlog.otp_featured_scanned = 5000;
    await runOtpMatchIngest({ batch: 8, prune: false });
    expect(retentionQueries()).toHaveLength(0);
  });

  it("a dead database leaves the ingest result untouched", async () => {
    let firstDone = false;
    const dying = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (firstDone) return Promise.reject(new Error("402 Payment Required"));
      firstDone = true;
      return (mockSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(
        strings,
        ...values
      );
    }) as unknown as typeof mockSql;
    (dying as unknown as { unsafe: (r: string) => RawSql }).unsafe = mockSql.unsafe;

    const { getSql } = await import("@/lib/pro/db");
    vi.mocked(getSql).mockReturnValueOnce(dying as never);

    const result = await runOtpMatchIngest({ batch: 8 });
    expect(result.errors).toEqual([]);
    expect(result.accountsProcessed).toBe(0);
  });
});
