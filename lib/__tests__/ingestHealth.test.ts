/**
 * lib/ingestHealth.ts — durable last-run status for the ingest pipelines that
 * run outside Vercel (2026-07-31 audit P2, #2). sql mocked content-based,
 * same pattern as draft-ingest.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { recordIngestRun, getIngestHealth } from "@/lib/ingestHealth";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

describe("recordIngestRun", () => {
  it("a successful run's INSERT values carry ok=true and no error", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: sqlText(strings), values });
      return Promise.resolve([]);
    });
    await recordIngestRun(mockSql as never, "draft", { ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO coachbuild.ingest_health");
    expect(calls[0].values).toContain("draft");
    // ok flag appears twice (INSERT values + the ON CONFLICT SET clause) —
    // both must be true.
    expect(calls[0].values.filter((v) => v === true).length).toBeGreaterThanOrEqual(2);
    // error values (both the INSERT slot and the CASE branch) must be null.
    expect(calls[0].values).not.toContain("boom");
  });

  it("a failed run's INSERT values carry ok=false and the truncated error", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: sqlText(strings), values });
      return Promise.resolve([]);
    });
    await recordIngestRun(mockSql as never, "prostage", { ok: false, error: "Cloudflare 403 on 6 tournaments" });
    expect(calls[0].values).toContain("prostage");
    expect(calls[0].values).toContain("Cloudflare 403 on 6 tournaments");
    expect(calls[0].values.filter((v) => v === false).length).toBeGreaterThanOrEqual(2);
  });

  it("truncates an oversized error rather than storing it unbounded", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: sqlText(strings), values });
      return Promise.resolve([]);
    });
    const hugeError = "x".repeat(5000);
    await recordIngestRun(mockSql as never, "draft", { ok: false, error: hugeError });
    const storedError = calls[0].values.find((v) => typeof v === "string" && v.startsWith("xxx"));
    expect(storedError).toBeDefined();
    expect((storedError as string).length).toBeLessThanOrEqual(2000);
  });

  it("no error string on a failure -> stores null, never a fabricated message", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: sqlText(strings), values });
      return Promise.resolve([]);
    });
    await recordIngestRun(mockSql as never, "draft", { ok: false });
    expect(calls[0].values).toContain(null);
  });
});

describe("prostage-live is a DISTINCT key from prostage (2026-07-31 re-score follow-up)", () => {
  it("recordIngestRun writes 'prostage-live' independently -- the two legs must never share a row", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: sqlText(strings), values });
      return Promise.resolve([]);
    });
    await recordIngestRun(mockSql as never, "prostage-live", { ok: false, error: "lolesports feed timeout" });
    expect(calls[0].values).toContain("prostage-live");
    expect(calls[0].values).not.toContain("prostage");
    expect(calls[0].values).toContain("lolesports feed timeout");
  });

  it("getIngestHealth reads 'prostage-live' and 'prostage' as independent rows", async () => {
    const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const ingest = values[0];
      if (ingest === "prostage-live") {
        return Promise.resolve([
          { ingest: "prostage-live", last_run_at: "x", last_success_at: null, ok: false, last_error: "lolesports feed timeout", last_error_at: "x" },
        ]);
      }
      if (ingest === "prostage") {
        return Promise.resolve([
          { ingest: "prostage", last_run_at: "y", last_success_at: "y", ok: true, last_error: null, last_error_at: null },
        ]);
      }
      return Promise.resolve([]);
    });
    const live = await getIngestHealth(mockSql as never, "prostage-live");
    const leaguepedia = await getIngestHealth(mockSql as never, "prostage");
    expect(live).toMatchObject({ ok: false, lastError: "lolesports feed timeout" });
    expect(leaguepedia).toMatchObject({ ok: true, lastError: null });
  });
});

describe("getIngestHealth", () => {
  it("maps the row's snake_case columns to the camelCase IngestHealth shape", async () => {
    const mockSql = vi.fn(() =>
      Promise.resolve([
        {
          ingest: "draft",
          last_run_at: "2026-07-31T09:00:00.000Z",
          last_success_at: "2026-07-30T09:00:00.000Z",
          ok: false,
          last_error: "6xxxx champion ids 403",
          last_error_at: "2026-07-31T09:00:00.000Z",
        },
      ])
    );
    const result = await getIngestHealth(mockSql as never, "draft");
    expect(result).toEqual({
      ingest: "draft",
      lastRunAt: "2026-07-31T09:00:00.000Z",
      lastSuccessAt: "2026-07-30T09:00:00.000Z",
      ok: false,
      lastError: "6xxxx champion ids 403",
      lastErrorAt: "2026-07-31T09:00:00.000Z",
    });
  });

  it("null when no row exists for this ingest -- 'unknown health', never a fabricated healthy default", async () => {
    const mockSql = vi.fn(() => Promise.resolve([]));
    expect(await getIngestHealth(mockSql as never, "draft")).toBeNull();
  });
});
