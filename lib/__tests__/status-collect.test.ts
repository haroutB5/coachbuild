/**
 * lib/status/collect.ts — the facts are gathered fail-soft, the artifact is
 * read from the build, and a burst of callers costs one collection.
 * Patch resolution and Neon are mocked; the artifact import is the real
 * committed file, which is the point (the page reports what THIS build serves).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/staticData", () => ({ getLatestPatchStatus: vi.fn() }));
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn() }));
vi.mock("@/lib/lastGood", () => ({ lastGoodBackend: vi.fn(() => "runtime-cache") }));

import { getLatestPatchStatus } from "@/lib/staticData";
import { getSql } from "@/lib/pro/db";
import { parseConsensusArtifact } from "@/components/hextech/consensusArtifact";
import artifactJson from "@/public/consensus/item-set-consensus.json";
import { collectStatus, collectStatusUncached, STATUS_TTL_MS, __resetStatusCacheForTests } from "@/lib/status/collect";

const ARTIFACT = parseConsensusArtifact(artifactJson)!;
const NOW = Date.parse(ARTIFACT.generatedAt) + 3600_000; // an hour after the bake

/** A fake neon tag function keyed on the SQL text. */
function fakeSql(handlers: Array<[RegExp, unknown[] | Error]>) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    for (const [re, out] of handlers) {
      if (re.test(text)) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unexpected query: ${text.slice(0, 60)}`);
  });
}

const healthySql = () =>
  fakeSql([
    [/SELECT 1/, [{ "?column?": 1 }]],
    [/max\(created_at\)[\s\S]*pro_matches/, [{ latest: new Date(NOW - 5 * 3600_000).toISOString() }]],
    [/GROUP BY patch/, [{ patch: ARTIFACT.patch, champs: 172, latest: "x" }]],
    [/count\(DISTINCT champ_id\)::int AS champs,/, [{ champs: 172, latest: new Date(NOW - 30 * 3600_000).toISOString() }]],
    [/ingest_health/, [{ ingest: "draft", last_run_at: "x", last_success_at: "x", ok: true, last_error: null, last_error_at: null }]],
  ]);

beforeEach(() => {
  __resetStatusCacheForTests();
  vi.mocked(getLatestPatchStatus).mockReset();
  vi.mocked(getSql).mockReset();
});

describe("collectStatusUncached", () => {
  it("all green: every check passes, artifact facts come from the committed file", async () => {
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: true,
      resolvedAt: NOW,
    });
    vi.mocked(getSql).mockReturnValue(healthySql() as never);

    const r = await collectStatusUncached(() => NOW);
    expect(r.overall).toBe("pass");
    expect(r.checks.map((c) => [c.id, c.verdict])).toEqual([
      ["build-patch", "pass"],
      ["artifact-patch", "pass"],
      ["artifact-age", "pass"],
      ["neon", "pass"],
      ["matches-ingest", "pass"],
      ["draft-tables", "pass"],
      ["consensus-coverage", "pass"],
      ["runtime-cache", "pass"],
    ]);
    const cov = r.checks.find((c) => c.id === "consensus-coverage")!;
    expect(cov.detail).toContain(`pro ${ARTIFACT.coverage.pro}, otp ${ARTIFACT.coverage.otp} of ${ARTIFACT.coverage.combos}`);
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("no DATABASE_URL: the page still renders, every DB-backed check fails, nothing throws", async () => {
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: true,
      resolvedAt: NOW,
    });
    vi.mocked(getSql).mockReturnValue(null);

    const r = await collectStatusUncached(() => NOW);
    expect(r.overall).toBe("fail");
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.neon.detail).toBe("DATABASE_URL not configured");
    expect(byId["matches-ingest"].verdict).toBe("fail");
    expect(byId["draft-tables"].verdict).toBe("fail");
    // The non-DB checks are unaffected.
    expect(byId["build-patch"].verdict).toBe("pass");
    expect(byId["artifact-patch"].verdict).toBe("pass");
  });

  it("the 2026-08-23 shape: SELECT 1 fine, draft tables empty -> draft-tables FAIL naming patch:null", async () => {
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: true,
      resolvedAt: NOW,
    });
    vi.mocked(getSql).mockReturnValue(
      fakeSql([
        [/SELECT 1/, [{ "?column?": 1 }]],
        [/max\(created_at\)[\s\S]*pro_matches/, [{ latest: new Date(NOW - 5 * 3600_000).toISOString() }]],
        [/GROUP BY patch/, []],
        [/ingest_health/, []],
      ]) as never
    );
    const r = await collectStatusUncached(() => NOW);
    const draft = r.checks.find((c) => c.id === "draft-tables")!;
    expect(draft.verdict).toBe("fail");
    expect(draft.detail).toMatch(/patch:null/);
    expect(r.overall).toBe("fail");
  });

  it("a query that throws after SELECT 1 succeeded is its own fail line and does not sink the others", async () => {
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: true,
      resolvedAt: NOW,
    });
    vi.mocked(getSql).mockReturnValue(
      fakeSql([
        [/SELECT 1/, [{ "?column?": 1 }]],
        [/max\(created_at\)[\s\S]*pro_matches/, new Error("relation does not exist")],
        [/GROUP BY patch/, [{ patch: ARTIFACT.patch, champs: 172, latest: "x" }]],
        [/count\(DISTINCT champ_id\)::int AS champs,/, [{ champs: 172, latest: new Date(NOW - 30 * 3600_000).toISOString() }]],
        [/ingest_health/, []],
      ]) as never
    );
    const r = await collectStatusUncached(() => NOW);
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId["matches-ingest"].verdict).toBe("fail");
    expect(byId["draft-tables"].verdict).toBe("pass");
    expect(byId["neon-query"]).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/pro_matches: relation/) });
  });

  it("patch resolution from fallback is a warn, and a throwing resolver is a fail, never an exception", async () => {
    vi.mocked(getSql).mockReturnValue(healthySql() as never);
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: false,
      resolvedAt: NOW,
    });
    expect((await collectStatusUncached(() => NOW)).checks[0].verdict).toBe("warn");

    vi.mocked(getLatestPatchStatus).mockRejectedValue(new Error("boom"));
    const r = await collectStatusUncached(() => NOW);
    expect(r.checks[0].verdict).toBe("fail");
  });
});

describe("collectStatus is bounded", () => {
  it("a burst of concurrent callers shares ONE collection, and the TTL re-collects", async () => {
    vi.mocked(getLatestPatchStatus).mockResolvedValue({
      patch: { major: 16, patch: 17, patchAdditions: 0, label: ARTIFACT.patch },
      ok: true,
      resolvedAt: NOW,
    });
    const sql = healthySql();
    vi.mocked(getSql).mockReturnValue(sql as never);

    let t = NOW;
    const clock = () => t;
    const burst = await Promise.all([collectStatus(clock), collectStatus(clock), collectStatus(clock)]);
    expect(burst[0]).toBe(burst[1]);
    expect(burst[1]).toBe(burst[2]);
    const callsAfterBurst = sql.mock.calls.length;
    expect(callsAfterBurst).toBeGreaterThan(0);

    t += STATUS_TTL_MS - 1;
    await collectStatus(clock);
    expect(sql.mock.calls.length).toBe(callsAfterBurst);

    t += 2;
    await collectStatus(clock);
    expect(sql.mock.calls.length).toBeGreaterThan(callsAfterBurst);
  });
});
