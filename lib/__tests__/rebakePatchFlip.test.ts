/**
 * Tests for the UNATTENDED half of the patch-flip fix: scripts/patch-step.mts
 * and the guards in scripts/rebake-consensus.ps1 that consume it.
 *
 * ── Why a test file reads a .ps1 as text ────────────────────────────────────
 *
 * The re-bake wrapper cannot be imported, and the thing worth protecting is not
 * its behaviour in the abstract — it is that it does NOT carry its own copy of
 * the patch arithmetic. This repo has paid for a duplicated rule twice: the
 * v0.70.0 pro-play starvation fix landed on one copy of the consensus query and
 * not the other, and the "Pro build" line users got in their shop stayed ~96%
 * solo queue for weeks after the card beside it was correct. So the wrapper
 * shells out to `scripts/patch-step.mts`, which wraps the very function
 * `resolveConsensus` uses, and this file fails if someone "simplifies" that
 * into a PowerShell comparison.
 *
 * The same technique already guards the cadence
 * (lib/__tests__/ingestCadence.test.ts), the DB provenance dot-source
 * (scripts/register-rebake-task.ps1), and the retention windows
 * (lib/retention/__tests__/prune.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONSENSUS_MAX_STALE_MINORS,
  isSingleForwardPatchStep,
  patchDriftSteps,
} from "@/components/hextech/consensusArtifact";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
function readRepoFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("scripts/patch-step.mts — one definition, two callers", () => {
  const cli = readRepoFile("scripts/patch-step.mts");

  it("imports the resolver's own arithmetic rather than restating it", () => {
    expect(cli).toContain('from "@/components/hextech/consensusArtifact"');
    expect(cli).toContain("patchDriftSteps");
    expect(cli).toContain("CONSENSUS_MAX_STALE_MINORS");
    // No hand-rolled parsing. A `split(".")` here would be the second copy this
    // file exists to prevent.
    expect(cli).not.toMatch(/parseInt|\.split\("\."\)/);
  });

  it("exits 0 for a single forward step and non-zero for everything else", () => {
    // The CLI's exit code IS its contract — PowerShell reads $LASTEXITCODE, not
    // stdout — so the mapping is asserted against the same helper the wrapper's
    // decision depends on rather than against a transcript.
    expect(cli).toContain("process.exit(steps === null ? 2 : steps === 1 ? 0 : 1)");
    expect(isSingleForwardPatchStep("16.16", "16.17")).toBe(true);
    expect(isSingleForwardPatchStep("16.16", "16.18")).toBe(false);
    expect(isSingleForwardPatchStep("16.17", "16.16")).toBe(false);
  });

  it("publishes `served`, which is a DIFFERENT question from the exit code", () => {
    // 16.16 -> 16.18 is two steps: the re-bake must NOT accept it alone (exit 1)
    // while the export IS still serving the artifact (served=yes). A monitor
    // that read only the exit code would report an outage that is not happening.
    expect(patchDriftSteps("16.16", "16.18")).toBe(2);
    expect(isSingleForwardPatchStep("16.16", "16.18")).toBe(false);
    expect(2).toBeLessThanOrEqual(CONSENSUS_MAX_STALE_MINORS);
    expect(cli).toContain("served=");
    expect(cli).toContain("bound=");
  });
});

describe("scripts/rebake-consensus.ps1 — the flip guards", () => {
  const ps1 = readRepoFile("scripts/rebake-consensus.ps1");

  it("decides a flip by calling patch-step.mts, not by comparing patch strings itself", () => {
    expect(ps1).toContain("npx tsx scripts/patch-step.mts --from");
    // The accept must be gated on that process's exit code. Anything else means
    // the wrapper reached its own conclusion.
    expect(ps1).toMatch(/\$stepCode\s*=\s*\$LASTEXITCODE/);
    expect(ps1).toMatch(/if \(\$stepCode -ne 0 -and -not \$AcceptPatchFlip\)/);
    expect(ps1).toContain("Refuse 77");
  });

  it("emits the ONE line the greeting digest greps for", () => {
    // urgot scripts/check-coachbuild-live.sh matches
    // `PATCH FLIP (AUTO-)?ACCEPTED`. When the automation handles a flip
    // correctly the whole event is otherwise invisible — LastTaskResult is 0,
    // the same as any ordinary day — so this string is the only evidence that a
    // decision was ever made.
    expect(ps1).toContain("PATCH FLIP AUTO-ACCEPTED:");
    expect(ps1).toContain("PATCH FLIP ACCEPTED by operator override:");
  });

  it("still refuses on a coverage collapse, as a RELATIVE floor on a flip", () => {
    // register-rebake-task.ps1 refuses to register a wrapper that has lost this
    // string; the assertion is repeated here so the guard's DISAPPEARANCE fails
    // a test run and not only a re-registration nobody does weekly.
    expect(ps1).toContain("coverage.otp REGRESSED");
    expect(ps1).toMatch(/\$CoverageDropTolerance\s*=\s*0\.02/);
    // The flip path must compute a floor, not skip the comparison. The previous
    // version skipped guard 76 entirely on a flip, on the premise that "a
    // first-bake-of-a-patch is thin by nature" — measured false on the
    // 2026-08-29 16.16 -> 16.17 flip, where coverage went UP on both sides
    // (otp 303 -> 304, pro 449 -> 454) and 638 of 865 entries came out
    // byte-identical to the previous patch's bake.
    expect(ps1).toMatch(/\$otpFloor\s*=\s*if \(\$patchFlipAccepted\)/);
    expect(ps1).toContain("[math]::Floor($served.Otp * (1 - $CoverageDropTolerance))");
    expect(ps1).toContain('if ($new.Otp -lt $otpFloor)');
    // And it must SAY the floor ran. Asserted positively rather than as an
    // absence of the old "coverage not compared" wording, because that string
    // now also appears in the comment explaining why it went away — the same
    // narration collision that got an ordinary `git worktree remove` blocked by
    // the repo safety gate on 2026-08-28.
    expect(ps1).toContain("coverage OK against the RELATIVE floor $otpFloor");
  });

  it("keeps every guard the flip path is not about", () => {
    for (const guard of ["Refuse 70", "Refuse 71", "Refuse 75", "Refuse 78", "Refuse 79", "Refuse 80"]) {
      expect(ps1).toContain(guard);
    }
    // And the push is still the plain fast-forward. Asserted by matching the
    // INVOCATION rather than by searching for the absence of a flag: the
    // script's own log line says "no --force" in prose, and a substring search
    // cannot tell narration from an argument — the exact confusion that got an
    // ordinary `git worktree remove` blocked by the repo safety gate on
    // 2026-08-28.
    expect(ps1).toContain("& git push origin $Branch 2>&1");
  });
});
