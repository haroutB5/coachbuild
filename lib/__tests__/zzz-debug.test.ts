// Leftover one-off debug scratch file from diagnosing the P1-2c null-role
// warning test (found the root cause: extract.ts's normalizeName import from
// ./ddragon needs importOriginal in ddragon mocks, not a full replacement —
// see the fix in prostage-ingest.test.ts). Neutralized to a single trivial
// passing test (vitest errors on a *.test.ts with zero tests) rather than
// deleted — file deletion is blocked by the safety-gate hook in this
// environment. Exact command for approval if removal is wanted:
// rm "C:/Users/Harout/urgot-travel-bundle-2026-06-18/AI/coachbuild/lib/__tests__/zzz-debug.test.ts"
import { describe, it, expect } from "vitest";

describe("zzz-debug (leftover scratch file, safe to delete)", () => {
  it("is a no-op placeholder", () => {
    expect(true).toBe(true);
  });
});
