// ---------------------------------------------------------------------------
// patch-step.mts - "how far apart are these two patch labels?", answered by the
// SAME arithmetic the shop export uses, for a caller that cannot import
// TypeScript.
//
// -- WHY THIS FILE EXISTS -----------------------------------------------------
// scripts/rebake-consensus.ps1 has to decide, unattended, whether a patch flip
// is a single forward step it may accept on its own (16.16 -> 16.17) or
// something that still needs a human (backwards, two steps, garbage). That is
// exactly the question `patchDriftSteps` in
// components/hextech/consensusArtifact.ts already answers for the resolver.
//
// A PowerShell reimplementation would be a SECOND copy of one rule, and this
// repo has paid for that mistake twice already: the v0.70.0 pro-play
// starvation fix landed on one copy of the consensus query and not the other,
// and the "Pro build" line users got in their shop stayed ~96% solo queue for
// weeks after the card beside it was correct (see PRO_CONSENSUS_LIMIT's comment
// in itemSetsApply.ts). One body, two call sites, no drift - so the PowerShell
// shells out to this, which the script can afford because it already runs
// `npx tsx` for the generator itself.
//
// -- CONTRACT -----------------------------------------------------------------
//   node/tsx scripts/patch-step.mts --from 16.16 --to 16.17
//
//   stdout   one line:
//              `steps=<n|none> verdict=<single-forward|no-flip|multi-step|uncountable>`
//              `bound=<max stale minors> served=<yes|no>`
//            `served` is the MONITOR question (is the export still off the CDN,
//            or back on the database), which is NOT the same as the verdict.
//   exit 0   the drift is exactly ONE forward step
//   exit 1   a countable drift that is NOT one step (0, or 2+)
//   exit 2   uncountable: unparseable label, or the `from` patch is NEWER
//   exit 3   the arguments themselves were wrong
//
// Every non-zero exit means "do not auto-accept". The caller treats ANY of them
// - including a crash, a missing tsx, or a node that will not start - as a
// refusal, which is the fail-closed direction: the cost of refusing a real
// single step is one alert and a day of a labelled stale artifact, and the cost
// of accepting something else is a bake nobody reviewed.
// ---------------------------------------------------------------------------
import { CONSENSUS_MAX_STALE_MINORS, patchDriftSteps } from "@/components/hextech/consensusArtifact";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const from = arg("from");
const to = arg("to");
if (!from || !to) {
  console.error("usage: tsx scripts/patch-step.mts --from <patch> --to <patch>");
  process.exit(3);
}

const steps = patchDriftSteps(from, to);
const verdict =
  steps === null ? "uncountable" : steps === 0 ? "no-flip" : steps === 1 ? "single-forward" : "multi-step";
// `served` answers a DIFFERENT question from `verdict`, and the monitor needs
// this one: not "may the re-bake accept this alone" but "is the export still
// serving the artifact, or has it reverted to the database". The bound is
// printed rather than left for the caller to know, so urgot's
// check-coachbuild-live.sh cannot drift from CONSENSUS_MAX_STALE_MINORS.
const served = steps !== null && steps <= CONSENSUS_MAX_STALE_MINORS;
console.log(
  `steps=${steps === null ? "none" : steps} verdict=${verdict} ` +
    `bound=${CONSENSUS_MAX_STALE_MINORS} served=${served ? "yes" : "no"}`
);
process.exit(steps === null ? 2 : steps === 1 ? 0 : 1);
