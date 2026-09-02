/**
 * lib/status/verdicts.ts — the thresholds behind /status, asserted as
 * thresholds. Every case hands the function a value, never a table.
 */
import { describe, it, expect } from "vitest";
import {
  ARTIFACT_FAIL_HOURS,
  ARTIFACT_WARN_HOURS,
  DRAFT_WARN_HOURS,
  MATCHES_FAIL_HOURS,
  MATCHES_WARN_HOURS,
  ageHours,
  judgeArtifactAge,
  judgeArtifactPatch,
  judgeCoverage,
  judgeDb,
  judgeDraft,
  judgeLivePatch,
  judgeMatchesIngest,
  overallVerdict,
  type StatusCheck,
} from "@/lib/status/verdicts";
import { CONSENSUS_MAX_STALE_MINORS } from "@/components/hextech/consensusArtifact";
import { SERVING_PATCH_MIN_CHAMPS } from "@/lib/draft/servingPatch";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe("judgeLivePatch", () => {
  it("confirmed resolution passes, fallback warns, a throw fails", () => {
    expect(judgeLivePatch({ label: "16.17", ok: true }).verdict).toBe("pass");
    const fb = judgeLivePatch({ label: "16.17", ok: false });
    expect(fb.verdict).toBe("warn");
    expect(fb.detail).toMatch(/FALLBACK/);
    expect(judgeLivePatch(null).verdict).toBe("fail");
  });
});

describe("judgeArtifactPatch: drift 1 with a healthy rebake is EXPECTED, not a failure", () => {
  it("same patch passes", () => {
    expect(judgeArtifactPatch("16.17", "16.17").verdict).toBe("pass");
  });

  it("one step behind is a PASS with the reason in the detail", () => {
    // HANDOFF 2026-08-29 §1: the export serves a stale artifact, labelled, and
    // the daily re-bake accepts a single forward step unattended. Paging for
    // this trains the reader to skip the page.
    const c = judgeArtifactPatch("16.16", "16.17");
    expect(c.verdict).toBe("pass");
    expect(c.detail).toMatch(/EXPECTED/);
    expect(c.detail).toMatch(/drift 1/);
  });

  it("at the served bound still passes; one past it fails", () => {
    expect(judgeArtifactPatch(`16.${17 - CONSENSUS_MAX_STALE_MINORS}`, "16.17").verdict).toBe("pass");
    expect(judgeArtifactPatch(`16.${17 - CONSENSUS_MAX_STALE_MINORS - 1}`, "16.17").verdict).toBe("fail");
  });

  it("artifact NEWER than live, or unparseable, fails (the export has reverted to Neon)", () => {
    expect(judgeArtifactPatch("16.18", "16.17").verdict).toBe("fail");
    expect(judgeArtifactPatch("garbage", "16.17").verdict).toBe("fail");
  });

  it("no artifact fails; no live patch warns (drift not measurable)", () => {
    expect(judgeArtifactPatch(null, "16.17").verdict).toBe("fail");
    expect(judgeArtifactPatch("16.17", null).verdict).toBe("warn");
  });
});

describe("judgeArtifactAge", () => {
  it("passes inside the warn window, warns past it, fails past the fail window", () => {
    expect(judgeArtifactAge(hoursAgo(20), NOW).verdict).toBe("pass");
    expect(judgeArtifactAge(hoursAgo(ARTIFACT_WARN_HOURS + 1), NOW).verdict).toBe("warn");
    expect(judgeArtifactAge(hoursAgo(ARTIFACT_FAIL_HOURS + 1), NOW).verdict).toBe("fail");
  });

  it("carries the bake time as `at`, and fails on a missing timestamp", () => {
    const at = hoursAgo(5);
    expect(judgeArtifactAge(at, NOW).at).toBe(at);
    expect(judgeArtifactAge(null, NOW).verdict).toBe("fail");
    expect(judgeArtifactAge("not a date", NOW).verdict).toBe("fail");
  });
});

describe("judgeDb / judgeMatchesIngest", () => {
  it("reports latency on success and the error on failure", () => {
    expect(judgeDb({ ok: true, latencyMs: 93 })).toMatchObject({ verdict: "pass", detail: "SELECT 1 in 93 ms" });
    expect(judgeDb({ ok: false, error: "DATABASE_URL not configured" })).toMatchObject({
      verdict: "fail",
      detail: "DATABASE_URL not configured",
    });
  });

  it("matches ingest: fresh passes, quiet warns, dead fails, empty fails, unchecked fails", () => {
    expect(judgeMatchesIngest(hoursAgo(10), NOW, true).verdict).toBe("pass");
    expect(judgeMatchesIngest(hoursAgo(MATCHES_WARN_HOURS + 1), NOW, true).verdict).toBe("warn");
    expect(judgeMatchesIngest(hoursAgo(MATCHES_FAIL_HOURS + 1), NOW, true).verdict).toBe("fail");
    expect(judgeMatchesIngest(null, NOW, true)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/EMPTY/) });
    expect(judgeMatchesIngest(hoursAgo(1), NOW, false).verdict).toBe("fail");
  });
});

describe("judgeDraft: the 2026-08-23 blank-counters incident must be a FAIL in one read", () => {
  const healthy = {
    servingPatch: "16.17",
    champs: 172,
    latestIngestedAt: hoursAgo(30),
    ingestOk: true,
    ingestLastError: null,
  };

  it("serving patch null (the `patch:null` tell) fails and names the fix", () => {
    const c = judgeDraft({ ...healthy, servingPatch: null, champs: 0 }, NOW, true);
    expect(c.verdict).toBe("fail");
    expect(c.detail).toMatch(/patch:null/);
    expect(c.detail).toMatch(/CoachBuildDraftIngest/);
  });

  it("a patch with zero champions in the served tier also fails", () => {
    expect(judgeDraft({ ...healthy, champs: 0 }, NOW, true).verdict).toBe("fail");
  });

  it("healthy data passes and carries the ingest time", () => {
    const c = judgeDraft(healthy, NOW, true);
    expect(c.verdict).toBe("pass");
    expect(c.at).toBe(healthy.latestIngestedAt);
    expect(c.detail).toMatch(/172 champions/);
  });

  it("below the serving bar warns (mid-ingest or a killed walk)", () => {
    expect(judgeDraft({ ...healthy, champs: SERVING_PATCH_MIN_CHAMPS - 1 }, NOW, true).verdict).toBe("warn");
  });

  it("a stale ingest warns; a failed last run with data still served warns and quotes the error", () => {
    expect(judgeDraft({ ...healthy, latestIngestedAt: hoursAgo(DRAFT_WARN_HOURS + 1) }, NOW, true).verdict).toBe("warn");
    const c = judgeDraft({ ...healthy, ingestOk: false, ingestLastError: "champ 141: u.gg Cloudflare challenge" }, NOW, true);
    expect(c.verdict).toBe("warn");
    expect(c.detail).toMatch(/Cloudflare challenge/);
    expect(c.detail).toMatch(/being served/);
  });

  it("database down means not checked, which is a fail, never a pass", () => {
    expect(judgeDraft(healthy, NOW, false).verdict).toBe("fail");
    expect(judgeDraft(null, NOW, true).verdict).toBe("fail");
  });
});

describe("judgeCoverage", () => {
  it("reports both counts; a zero on either side fails", () => {
    expect(judgeCoverage({ combos: 865, pro: 461, otp: 320 })).toMatchObject({
      verdict: "pass",
      detail: expect.stringMatching(/pro 461, otp 320 of 865/),
    });
    expect(judgeCoverage({ combos: 865, pro: 0, otp: 320 }).verdict).toBe("fail");
    expect(judgeCoverage(null).verdict).toBe("fail");
  });
});

describe("overallVerdict is the worst check", () => {
  const mk = (verdict: StatusCheck["verdict"]): StatusCheck => ({ id: "x", label: "x", verdict, detail: "", at: null });
  it("pass < warn < fail", () => {
    expect(overallVerdict([])).toBe("pass");
    expect(overallVerdict([mk("pass"), mk("pass")])).toBe("pass");
    expect(overallVerdict([mk("pass"), mk("warn")])).toBe("warn");
    expect(overallVerdict([mk("warn"), mk("fail"), mk("pass")])).toBe("fail");
  });
});

describe("ageHours", () => {
  it("null/garbage -> null, otherwise hours since", () => {
    expect(ageHours(null, NOW)).toBeNull();
    expect(ageHours("nope", NOW)).toBeNull();
    expect(ageHours(hoursAgo(36), NOW)).toBeCloseTo(36, 6);
  });
});
