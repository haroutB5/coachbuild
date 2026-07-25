#!/usr/bin/env node
// Regenerates public/companion.version from the Version literal inside
// public/companion.ps1, so the two can never drift apart. Runs as `prebuild`.
//
// WHY THIS EXISTS. companion.version is the file a RUNNING companion polls to
// decide whether to show "an update is available". It was hand-maintained and
// silently fell four versions behind (1.4.1 vs a shipped 1.6.4), which INVERTED
// the mechanism in both directions at once:
//   - everyone on the current build got a permanent false "1.4.1 is available"
//     nag on every launch, because Test-AutoUpdate compares with -ne, and
//   - the one population the prompt exists for -- users actually stuck on
//     1.4.1 -- matched the stale file exactly and were never prompted at all.
// A version file that is written by hand is a version file that goes stale, so
// this derives it instead. Failing the build is deliberate: a companion that
// cannot state its own version is worse than a build that stops.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_env.mjs";

const PS1 = path.join(REPO_ROOT, "public", "companion.ps1");
const OUT = path.join(REPO_ROOT, "public", "companion.version");

const source = readFileSync(PS1, "utf8");
// Matches the `Version = '1.6.4'` entry in the $script:Config hashtable.
const version = source.match(/^\s*Version\s*=\s*'([^']+)'/m)?.[1];
if (!version) {
  console.error(`sync-companion-version: no "Version = '...'" literal found in ${PS1}`);
  process.exit(1);
}

const next = `${JSON.stringify({ version })}\n`;
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return null;
  }
})();

if (current === next) {
  console.log(`companion.version already in sync (${version})`);
} else {
  writeFileSync(OUT, next);
  console.log(`companion.version ${current ? "updated" : "written"} -> ${version}`);
}
