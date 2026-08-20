/**
 * Tests for lib/retention/prune.ts.
 *
 * The database is unreachable while this ships (every query 402s on an
 * exhausted Neon quota), so NOTHING here has been executed against real
 * Postgres. That makes the tests below the only evidence the delete is
 * correct, and it shapes what they assert: not just "the function returns the
 * right number", but the exact SQL each table emits — column, cutoff
 * expression, parameter value, batch bounding, and the absence of any
 * unbounded DELETE. A prune is irreversible; the query text is the artifact
 * that has to be right.
 *
 * Two guards here are tripwires rather than ordinary assertions, and both are
 * meant to FAIL when someone changes the surrounding code:
 *
 *   * "every read path still carries the fresh-window bound" reads the route
 *     source and asserts the bound is present. The prune is safe ONLY because
 *     those bounds exist; deleting one silently widens what the app serves and
 *     turns this prune into data loss. That must break the build, not a user.
 *
 *   * "the otp_matches block is still necessary" asserts that
 *     app/api/otp/featured/route.ts is STILL unbounded. When someone bounds it,
 *     this test fails on purpose, and the failure message says to flip
 *     autoPrune. Asserting the presence of a known defect is deliberate: it is
 *     the only way to couple the fix to the decision it unblocks.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/ingestHealth", () => ({
  recordIngestRun: vi.fn(async () => {}),
}));

import { recordIngestRun } from "@/lib/ingestHealth";
import { FRESH_WINDOW_DAYS } from "@/lib/pro/fresh";
import {
  RETENTION_DAYS,
  RETENTION_GRACE_DAYS,
  RETENTION_TABLES,
  PRUNE_BLOCKED_REASON,
  autoPruneTables,
  pruneTable,
  pruneTableSafely,
  retentionHealthKey,
  retentionSpec,
  runRetentionPruneSafely,
  type RetentionTableName,
} from "@/lib/retention/prune";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const readRepoFile = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

// ── A tagged-template `sql` mock that can rebuild the query text ────────────
// `sql.unsafe(x)` interpolates raw, everything else becomes a $n parameter —
// the same split the real driver makes, so a test assertion about "$1" is an
// assertion about a real bound parameter and an assertion about a table name
// is an assertion about raw SQL.

interface RawSql {
  __raw: string;
}
const isRaw = (v: unknown): v is RawSql =>
  typeof v === "object" && v !== null && "__raw" in (v as Record<string, unknown>);

interface RecordedQuery {
  text: string;
  params: unknown[];
}

type Responder = (q: RecordedQuery) => unknown;

function makeSql(responder: Responder) {
  const queries: RecordedQuery[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    const params: unknown[] = [];
    strings.forEach((chunk, i) => {
      text += chunk;
      if (i < values.length) {
        const v = values[i];
        if (isRaw(v)) {
          text += v.__raw;
        } else {
          params.push(v);
          text += `$${params.length}`;
        }
      }
    });
    const q: RecordedQuery = { text, params };
    queries.push(q);
    try {
      return Promise.resolve(responder(q));
    } catch (err) {
      return Promise.reject(err);
    }
  }) as unknown as Parameters<typeof pruneTable>[0];
  (sql as unknown as { unsafe: (raw: string) => RawSql }).unsafe = (raw: string) => ({ __raw: raw });
  return { sql, queries };
}

const CUTOFF = "2026-05-15T12:00:00.000Z";

/** Classifies the three query shapes the prune emits. */
const isThrottleQuery = (q: RecordedQuery) => q.text.includes("coachbuild.ingest_health");
const isCutoffQuery = (q: RecordedQuery) => q.text.includes("AS cutoff");
const isSelectQuery = (q: RecordedQuery) => /^\s*SELECT\s/.test(q.text) && q.text.includes("LIMIT");
const isDeleteQuery = (q: RecordedQuery) => /DELETE FROM/.test(q.text);

/**
 * Standard responder: never throttled, fixed cutoff, and `eligible` rows
 * remaining, handed out in pages and decremented as they are deleted.
 */
function responderWithBacklog(eligible: number, opts: { throttled?: boolean } = {}): Responder {
  let remaining = eligible;
  return (q) => {
    if (isThrottleQuery(q)) return opts.throttled ? [{ throttled: true }] : [];
    if (isCutoffQuery(q)) return [{ cutoff: CUTOFF }];
    if (isDeleteQuery(q)) return [];
    if (isSelectQuery(q)) {
      const limit = q.params[q.params.length - 1] as number;
      const n = Math.min(limit, remaining);
      remaining -= n;
      return Array.from({ length: n }, (_, i) => ({ k1: `m${i}`, k2: `p${i}` }));
    }
    return [];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("retention window derivation", () => {
  it("RETENTION_DAYS is derived from FRESH_WINDOW_DAYS, not written down twice", () => {
    expect(RETENTION_DAYS).toBe(FRESH_WINDOW_DAYS + RETENTION_GRACE_DAYS);
  });

  it("the prune window is strictly OUTSIDE the window the app serves", () => {
    // The whole safety argument is that a pruned row cannot be returned to a
    // user. If this ever inverts, the prune deletes live data.
    expect(RETENTION_DAYS).toBeGreaterThan(FRESH_WINDOW_DAYS);
    expect(RETENTION_GRACE_DAYS).toBeGreaterThan(0);
  });

  it("refuses a retentionDays inside the served window, at the boundary and below", async () => {
    const { sql } = makeSql(responderWithBacklog(0));
    await expect(
      pruneTable(sql, "pro_matches", { retentionDays: FRESH_WINDOW_DAYS, respectInterval: false })
    ).rejects.toThrow(/must exceed FRESH_WINDOW_DAYS/);
    await expect(
      pruneTable(sql, "pro_matches", { retentionDays: 1, respectInterval: false })
    ).rejects.toThrow(/must exceed FRESH_WINDOW_DAYS/);
  });

  it("refuses BEFORE issuing any query — a rejected window deletes nothing", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(1000));
    await expect(
      pruneTable(sql, "pro_matches", { retentionDays: 10, respectInterval: false })
    ).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the cutoff", () => {
  it("comes from the DATABASE clock in the read path's own now() - make_interval form", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(0));
    await pruneTable(sql, "pro_matches", { respectInterval: false });
    const cutoffQ = queries.find(isCutoffQuery);
    expect(cutoffQ).toBeDefined();
    expect(cutoffQ!.text).toContain("now() - make_interval(days => $1)");
    expect(cutoffQ!.params[0]).toBe(RETENTION_DAYS);
  });

  it("is resolved exactly ONCE and reused for every batch, so a long run cannot creep", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(1200));
    const result = await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      respectInterval: false,
    });
    expect(queries.filter(isCutoffQuery)).toHaveLength(1);

    const selects = queries.filter(isSelectQuery);
    expect(selects.length).toBeGreaterThan(1);
    for (const s of selects) {
      expect(s.params[0]).toBe(CUTOFF);
    }
    expect(result.cutoff).toBe(CUTOFF);
  });

  it("uses <= so the predicate is the exact complement of the read path's >", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(0));
    await pruneTable(sql, "pro_matches", { respectInterval: false });
    const select = queries.find(isSelectQuery)!;
    expect(select.text).toMatch(/game_creation\s*<=\s*\$1::timestamptz/);
  });

  it("throws rather than guessing when the database returns no cutoff", async () => {
    const { sql } = makeSql((q) => {
      if (isThrottleQuery(q)) return [];
      if (isCutoffQuery(q)) return [];
      return [];
    });
    await expect(pruneTable(sql, "pro_matches", { respectInterval: false })).rejects.toThrow(
      /could not resolve retention cutoff/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("per-table SQL — the registry is not a blanket rule", () => {
  const expected: Record<RetentionTableName, { column: string; key: [string, string] }> = {
    pro_matches: { column: "game_creation", key: ["match_id", "puuid"] },
    otp_matches: { column: "game_creation", key: ["match_id", "puuid"] },
    prostage_matches: { column: "game_datetime", key: ["game_id", "player_link"] },
    otp_featured_scanned: { column: "scanned_at", key: ["puuid", "match_id"] },
  };

  // Asserting the day parameter at ONE table would say nothing about the
  // others — a hardcoded 90 in a second query is exactly the kind of copy a
  // single-call-site assertion cannot see.
  for (const table of Object.keys(expected) as RetentionTableName[]) {
    it(`${table}: prunes on ${expected[table].column} with the shared RETENTION_DAYS`, async () => {
      const { sql, queries } = makeSql(responderWithBacklog(3));
      await pruneTable(sql, table, { batchSize: 500, respectInterval: false });

      const cutoffQ = queries.find(isCutoffQuery)!;
      expect(cutoffQ.params[0]).toBe(RETENTION_DAYS);
      // No literal window anywhere in the emitted SQL: the number must arrive
      // as a bound parameter derived from FRESH_WINDOW_DAYS.
      for (const q of queries) {
        expect(q.text).not.toMatch(/make_interval\(days => \d/);
      }

      const select = queries.find(isSelectQuery)!;
      expect(select.text).toContain(`coachbuild.${table}`);
      expect(select.text).toMatch(
        new RegExp(`${expected[table].column}\\s*<=\\s*\\$1::timestamptz`)
      );

      const del = queries.find(isDeleteQuery)!;
      expect(del.text).toContain(`DELETE FROM coachbuild.${table}`);
      expect(del.text).toContain(`t.${expected[table].key[0]} = k.a`);
      expect(del.text).toContain(`t.${expected[table].key[1]} = k.b`);
    });
  }

  it("prostage_matches does NOT prune on game_creation — that column does not exist there", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(3));
    await pruneTable(sql, "prostage_matches", { respectInterval: false });
    for (const q of queries.filter((x) => !isThrottleQuery(x))) {
      expect(q.text).not.toContain("game_creation");
    }
  });

  it("every registry column actually exists in that table's CREATE TABLE", () => {
    // Proves the retention key against the real schema with no database. This
    // is the check that catches a blanket "prune on game_creation" rule: the
    // prostage CREATE TABLE has no such column.
    const migrations = [
      "migrations/0001_init.sql",
      "migrations/0002_prostage.sql",
      "migrations/0017_otp.sql",
      "migrations/0019_otp_featured_deep.sql",
    ]
      .map(readRepoFile)
      .join("\n");

    for (const spec of RETENTION_TABLES) {
      const re = new RegExp(
        `CREATE TABLE IF NOT EXISTS coachbuild\\.${spec.table}\\s*\\(([\\s\\S]*?)\\n\\);`
      );
      const block = migrations.match(re);
      expect(block, `no CREATE TABLE found for ${spec.table}`).not.toBeNull();
      const body = block![1];
      expect(body, `${spec.table} has no ${spec.column} column`).toMatch(
        new RegExp(`(^|\\n)\\s*${spec.column}\\s`)
      );
      for (const k of spec.key) {
        expect(body, `${spec.table} has no ${k} column`).toMatch(new RegExp(`(^|\\n)\\s*${k}\\s`));
      }
      // The declared key must be the table's actual PRIMARY KEY, or the
      // batched delete is not the indexed lookup it claims to be.
      expect(body.replace(/\s+/g, " ")).toContain(
        `PRIMARY KEY (${spec.key[0]}, ${spec.key[1]})`
      );
    }
  });

  it("every registry identifier is a plain lowercase SQL identifier", () => {
    // These reach sql.unsafe(); they come only from the frozen literal
    // registry, and this asserts that stays true.
    for (const spec of RETENTION_TABLES) {
      for (const ident of [spec.table, spec.column, spec.key[0], spec.key[1]]) {
        expect(ident).toMatch(/^[a-z_][a-z0-9_]*$/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("bounded batches", () => {
  it("deletes in pages and never issues an unbounded predicate DELETE", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(1200));
    const result = await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      respectInterval: false,
    });

    expect(result.rowsDeleted).toBe(1200);
    expect(result.batches).toBe(3);
    expect(result.capped).toBe(false);

    const deletes = queries.filter(isDeleteQuery);
    expect(deletes).toHaveLength(3);
    for (const d of deletes) {
      // Every DELETE is a primary-key lookup over an explicit key list. If a
      // DELETE ever carries the cutoff predicate itself, it is unbounded.
      expect(d.text).toContain("unnest(");
      expect(d.text).not.toContain("make_interval");
      expect(d.text).not.toContain("timestamptz");
    }
    // Each batch is its own statement, i.e. its own implicit transaction —
    // nothing spans them.
    expect(queries.some((q) => /BEGIN|COMMIT/i.test(q.text))).toBe(false);
  });

  it("stops on maxRowsPerRun with the backlog undrained, and says so", async () => {
    const { sql } = makeSql(responderWithBacklog(50_000));
    const result = await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      maxRowsPerRun: 1000,
      respectInterval: false,
    });
    expect(result.rowsDeleted).toBe(1000);
    expect(result.capped).toBe(true);
  });

  it("stops on the wall-clock budget even when rows remain well under the row cap", async () => {
    let t = 0;
    const { sql } = makeSql(responderWithBacklog(50_000));
    const result = await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      maxRowsPerRun: 1_000_000,
      budgetMs: 1000,
      respectInterval: false,
      nowMs: () => (t += 400), // ~3 reads of the clock per batch
    });
    expect(result.capped).toBe(true);
    expect(result.rowsDeleted).toBeGreaterThan(0);
    expect(result.rowsDeleted).toBeLessThan(50_000);
  });

  it("a short page ends the run without paying for one more empty SELECT", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(300));
    const result = await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      respectInterval: false,
    });
    expect(result.rowsDeleted).toBe(300);
    expect(result.batches).toBe(1);
    expect(queries.filter(isSelectQuery)).toHaveLength(1);
  });

  it("an empty table issues one SELECT, zero DELETEs", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(0));
    const result = await pruneTable(sql, "pro_matches", { respectInterval: false });
    expect(result.rowsDeleted).toBe(0);
    expect(result.batches).toBe(0);
    expect(queries.filter(isDeleteQuery)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("throttling", () => {
  it("skips entirely when the table was pruned inside the interval", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(5000, { throttled: true }));
    const result = await pruneTable(sql, "pro_matches", { minIntervalHours: 20 });
    expect(result.skipped).toBe("throttled");
    expect(result.rowsDeleted).toBe(0);
    expect(queries.filter(isCutoffQuery)).toHaveLength(0);
    expect(queries.filter(isDeleteQuery)).toHaveLength(0);
  });

  it("asks about THIS table's own health key", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(0, { throttled: true }));
    await pruneTable(sql, "prostage_matches", {});
    const q = queries.find(isThrottleQuery)!;
    expect(q.params).toContain(retentionHealthKey("prostage_matches"));
    expect(retentionHealthKey("prostage_matches")).toBe("retention:prostage_matches");
  });

  it("a missing health row (never pruned) is a GO, not a block", async () => {
    const { sql } = makeSql(responderWithBacklog(10));
    const result = await pruneTable(sql, "pro_matches", { minIntervalHours: 20 });
    expect(result.skipped).toBeNull();
    expect(result.rowsDeleted).toBe(10);
  });

  it("FAILS CLOSED: a throttle query that throws deletes nothing", async () => {
    // Erring toward "delete anyway" on a query we could not run is the wrong
    // side of an irreversible operation.
    const { sql, queries } = makeSql((q) => {
      if (isThrottleQuery(q)) throw new Error("relation does not exist");
      return [];
    });
    const result = await pruneTableSafely(sql, "pro_matches", { minIntervalHours: 20 });
    expect(result.skipped).toBe("error");
    expect(result.rowsDeleted).toBe(0);
    expect(queries.filter(isDeleteQuery)).toHaveLength(0);
  });

  it("respectInterval:false issues no throttle query at all", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(0));
    await pruneTable(sql, "pro_matches", { respectInterval: false });
    expect(queries.filter(isThrottleQuery)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("never breaks the caller", () => {
  it("a completely dead database returns an error result instead of throwing", async () => {
    // This is the live condition as this ships: every Neon query 402s.
    const { sql } = makeSql(() => {
      throw new Error("402 Payment Required: quota exceeded");
    });
    const result = await pruneTableSafely(sql, "pro_matches", {});
    expect(result.skipped).toBe("error");
    expect(result.error).toContain("402");
    expect(result.rowsDeleted).toBe(0);
  });

  it("mid-run failure after some batches still resolves, reporting the error", async () => {
    let deletes = 0;
    const { sql } = makeSql((q) => {
      if (isThrottleQuery(q)) return [];
      if (isCutoffQuery(q)) return [{ cutoff: CUTOFF }];
      if (isDeleteQuery(q)) {
        deletes += 1;
        if (deletes > 1) throw new Error("connection reset");
        return [];
      }
      const limit = q.params[q.params.length - 1] as number;
      return Array.from({ length: limit }, (_, i) => ({ k1: `m${i}`, k2: `p${i}` }));
    });
    const result = await pruneTableSafely(sql, "pro_matches", { batchSize: 10 });
    expect(result.skipped).toBe("error");
    expect(result.error).toContain("connection reset");
  });

  it("runRetentionPruneSafely surveys every table against a dead database without throwing", async () => {
    const { sql } = makeSql(() => {
      throw new Error("402 Payment Required");
    });
    const results = await runRetentionPruneSafely(sql, autoPruneTables(), {});
    expect(results).toHaveLength(autoPruneTables().length);
    expect(results.every((r) => r.skipped === "error")).toBe(true);
  });

  it("a driver returning a non-array does not crash the caller", async () => {
    const { sql } = makeSql(() => undefined);
    const result = await pruneTableSafely(sql, "pro_matches", {});
    expect(result.skipped).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility", () => {
  it("logs table, rows, cutoff and duration for a real run", async () => {
    const lines: string[] = [];
    const { sql } = makeSql(responderWithBacklog(300));
    await pruneTable(sql, "pro_matches", {
      batchSize: 500,
      respectInterval: false,
      log: (m) => lines.push(m),
    });
    const line = lines.join("\n");
    expect(line).toContain("pro_matches");
    expect(line).toContain("300");
    expect(line).toContain(CUTOFF);
    expect(line).toMatch(/\d+ms/);
  });

  it("records a durable ingest_health row keyed retention:<table>, ok on a clean drain", async () => {
    vi.mocked(recordIngestRun).mockClear();
    const { sql } = makeSql(responderWithBacklog(20));
    await pruneTableSafely(sql, "pro_matches", { respectInterval: false });
    expect(recordIngestRun).toHaveBeenCalledTimes(1);
    const [, key, payload] = vi.mocked(recordIngestRun).mock.calls[0];
    expect(key).toBe("retention:pro_matches");
    expect(payload).toMatchObject({ ok: true });
  });

  it("records ok:false when the backlog was NOT drained — 'still behind' is the signal", async () => {
    vi.mocked(recordIngestRun).mockClear();
    const { sql } = makeSql(responderWithBacklog(50_000));
    await pruneTableSafely(sql, "pro_matches", {
      batchSize: 500,
      maxRowsPerRun: 1000,
      respectInterval: false,
    });
    const [, , payload] = vi.mocked(recordIngestRun).mock.calls[0];
    expect(payload).toMatchObject({ ok: false });
    expect((payload as { error: string }).error).toContain("backlog not drained");
  });

  it("does NOT record on a throttled run — recording would refresh last_run_at and throttle forever", async () => {
    vi.mocked(recordIngestRun).mockClear();
    const { sql } = makeSql(responderWithBacklog(0, { throttled: true }));
    await pruneTableSafely(sql, "pro_matches", { minIntervalHours: 20 });
    expect(recordIngestRun).not.toHaveBeenCalled();
  });

  it("a failed health write does not turn a successful prune into a failure", async () => {
    vi.mocked(recordIngestRun).mockClear();
    vi.mocked(recordIngestRun).mockRejectedValueOnce(new Error("health write failed"));
    const { sql } = makeSql(responderWithBacklog(20));
    const result = await pruneTableSafely(sql, "pro_matches", { respectInterval: false });
    expect(result.skipped).toBeNull();
    expect(result.rowsDeleted).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("otp_matches is registered but BLOCKED", () => {
  it("is excluded from the tables an ingest may prune", () => {
    expect(retentionSpec("otp_matches").autoPrune).toBe(false);
    expect(autoPruneTables()).not.toContain("otp_matches");
    expect(autoPruneTables().sort()).toEqual(
      ["otp_featured_scanned", "pro_matches", "prostage_matches"].sort()
    );
  });

  it("issues ZERO queries — a blocked table is not touched, not merely counted", async () => {
    const { sql, queries } = makeSql(responderWithBacklog(50_000));
    const result = await pruneTableSafely(sql, "otp_matches", { respectInterval: false });
    expect(result.skipped).toBe("blocked");
    expect(result.rowsDeleted).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("names the specific route that blocks it", () => {
    expect(PRUNE_BLOCKED_REASON.otp_matches).toContain("app/api/otp/featured/route.ts");
  });

  it("TRIPWIRE: the block is still necessary — /api/otp/featured is still unbounded", () => {
    // When someone bounds that query, THIS TEST FAILS ON PURPOSE. That is the
    // point: the fix and the decision to start pruning otp_matches belong in
    // the same change, and a green suite must not let them drift apart.
    const src = readRepoFile("app/api/otp/featured/route.ts");
    const otpMatchesQuery = src.slice(src.indexOf("FROM coachbuild.otp_matches"));
    const stillUnbounded = !otpMatchesQuery.slice(0, 400).includes("make_interval");
    expect(
      stillUnbounded,
      "app/api/otp/featured/route.ts now bounds its coachbuild.otp_matches read. " +
        "That was the ONLY blocker on pruning otp_matches: set autoPrune:true for " +
        "otp_matches in lib/retention/prune.ts, drop PRUNE_BLOCKED_REASON.otp_matches, " +
        "add the otp_matches retention index to migrations/, and delete this tripwire."
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the safety premise: every read path is still fresh-window bounded", () => {
  // The prune is safe ONLY because a row outside the fresh window cannot be
  // returned to a user. These assertions are that premise, checked against the
  // real source. Removing a bound from a route would make this prune delete
  // data the app serves — that has to break the build.
  const BOUND = /> now\(\) - make_interval\(days => \$\{FRESH_WINDOW_DAYS\}\)/;

  it("app/api/pros/route.ts bounds every pro_matches and prostage_matches read", () => {
    const src = readRepoFile("app/api/pros/route.ts");
    const proReads = src.split("FROM coachbuild.pro_matches").slice(1);
    expect(proReads.length).toBeGreaterThan(0);
    for (const after of proReads) {
      expect(after.slice(0, 600)).toMatch(BOUND);
    }
    const prostageReads = src
      .split("FROM coachbuild.prostage_matches pm")
      .slice(1)
      // The last one is the comps enrichment, keyed on game_ids already
      // derived from the bounded queries above — reachability-bounded, not
      // predicate-bounded, and it is checked separately below.
      .filter((after) => !after.slice(0, 400).includes("game_id = ANY("));
    expect(prostageReads.length).toBeGreaterThan(0);
    for (const after of prostageReads) {
      expect(after.slice(0, 900)).toMatch(
        /game_datetime > now\(\) - make_interval\(days => \$\{FRESH_WINDOW_DAYS\}\)/
      );
    }
  });

  it("app/api/players/route.ts bounds its pro_matches join", () => {
    const src = readRepoFile("app/api/players/route.ts");
    const after = src.slice(src.indexOf("coachbuild.pro_matches"));
    expect(after.slice(0, 300)).toMatch(BOUND);
  });

  it("app/api/otp/route.ts bounds its otp_matches read", () => {
    const src = readRepoFile("app/api/otp/route.ts");
    const after = src.slice(src.indexOf("FROM coachbuild.otp_matches"));
    expect(after.slice(0, 600)).toMatch(BOUND);
  });

  it("FRESH_WINDOW_DAYS is the single source of the served window", () => {
    expect(readRepoFile("lib/pro/fresh.ts")).toContain("FRESH_WINDOW_DAYS = 90");
    expect(FRESH_WINDOW_DAYS).toBe(90);
  });
});
