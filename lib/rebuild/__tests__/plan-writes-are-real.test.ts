// Does the plan's `writes:` list describe the code, or just assert itself?
//
// plan.test.ts's "phase 1 writes every table /api/pros and /api/otp read" is
// the scope assertion, and on 2026-08-21 it PASSED against a plan that could
// never produce a shippable artifact. It compared a hand-maintained string list
// against a hand-maintained string list: `otp-featured` declared
// `writes: [..., "otp_accounts", ...]`, nothing in its script ever wrote that
// table, and both sides of the assertion agreed with each other while
// disagreeing with the repo. The rebuild ran to completion, otp_accounts stayed
// at 0 rows, all 5,109 ingested otp_matches sat unreachable behind
// /api/otp's INNER JOIN, and the artifact gate refused with `otp 0`.
//
// So these tests do not read `writes` and compare it to another list. They
// resolve each stage's script through its real import graph and look for the
// actual write statement in the source. A `writes:` entry that no reachable
// module backs is a false claim, and a false claim here is what bought a
// full unattended rebuild that could not ship.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_CRITICAL_TABLES, REBUILD_STAGES } from "@/lib/rebuild/plan";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXTENSIONS = [".ts", ".mts", ".mjs", ".tsx", ".js"];

function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package, not our source

  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, "index" + e))];
  // A ".ts" specifier that is really the source file, and the ".js"-style
  // specifier TS emits, both land here.
  for (const suffix of [".js", ".mjs"]) {
    if (base.endsWith(suffix)) {
      const stripped = base.slice(0, -suffix.length);
      candidates.push(...EXTENSIONS.map((e) => stripped + e));
    }
  }
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith(path.sep)) {
      try {
        if (readFileSync(c).length >= 0) return c;
      } catch {
        /* a directory — keep looking */
      }
    }
  }
  return null;
}

/** Every first-party source file reachable from `entry` by static import,
 *  including dynamic `await import("...")` — which is exactly how
 *  scripts/ingest-otp.mjs loads the module holding the INSERT, so a resolver
 *  that only understood static imports would miss the real writer. */
function reachableSources(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const specs = [
      ...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
      ...src.matchAll(/import\s*\(\s*\n?\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const resolved = resolveModule(spec, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

function writesTable(files: string[], table: string): boolean {
  // INSERT and UPDATE both count as writing the table; a stage that only
  // stamps last_fetched_at genuinely does write it.
  const re = new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+coachbuild\\.${table}\\b`, "i");
  return files.some((f) => {
    try {
      return re.test(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

// THE LIMIT OF THE CHECK BELOW, stated so nobody trusts it past its power:
// this is MODULE reachability, not CALL reachability. `writesTable` proves the
// statement exists somewhere in the import graph, not that the stage's code
// path ever executes it — and that distinction is precisely the bug. Measured:
// with the defect restored, the per-table cases below all PASSED, because
// scripts/ingest-otp-featured.mjs imports lib/otp/ingest.ts for
// `runOtpMatchIngest` and that module also holds the otp_accounts INSERT it
// never calls. So this suite keeps the per-table sweep as a cheap floor (it
// catches a table with no producer anywhere) and puts the teeth in the two
// call-site assertions after it, which were the ones that actually failed.
describe("rebuild plan — `writes:` is backed by real SQL, not by itself", () => {
  it.each(ARTIFACT_CRITICAL_TABLES.map((t) => [t]))(
    "some phase-1 stage actually writes coachbuild.%s",
    (table) => {
      const claimants = REBUILD_STAGES.filter((s) => s.phase === 1 && s.writes.includes(table));
      expect(claimants.length, `no phase-1 stage claims ${table}`).toBeGreaterThan(0);

      const backed = claimants.filter((stage) => {
        const entry = path.join(REPO_ROOT, stage.script);
        return existsSync(entry) && writesTable(reachableSources(entry), table);
      });

      expect(
        backed.length,
        `Stage(s) [${claimants.map((c) => c.id).join(", ")}] claim writes:["${table}"], but no ` +
          `INSERT/UPDATE against coachbuild.${table} is reachable from their scripts. ` +
          `Either the claim is false (delete it) or the stage that really writes it is missing.`
      ).toBeGreaterThan(0);
    }
  );

  it("does not let a stage claim a table it never touches", () => {
    // The specific false claim that cost the 2026-08-21 rebuild. Kept as its
    // own case so a regression names itself.
    const featured = REBUILD_STAGES.find((s) => s.id === "otp-featured");
    expect(featured).toBeDefined();
    expect(
      featured!.writes,
      "otp-featured does not call discoverOtpAccounts and never inserts otp_accounts"
    ).not.toContain("otp_accounts");
  });

  it("keeps a stage on the plan whose script CALLS the otp_accounts producer", () => {
    // Call-site, not import-site. `discoverOtpAccounts` is the only function in
    // the repo that reaches the INSERT INTO coachbuild.otp_accounts, so a
    // phase-1 plan in which no stage script invokes it cannot populate the
    // table no matter how long it runs — which is exactly the state that
    // produced `gate REFUSED: otp coverage 0`.
    const claimants = REBUILD_STAGES.filter((s) => s.phase === 1 && s.writes.includes("otp_accounts"));
    expect(
      claimants.length,
      "phase 1 has no otp_accounts producer — /api/otp's INNER JOIN will serve empty 200s forever"
    ).toBeGreaterThan(0);

    const callers = claimants.filter((stage) => {
      const entry = path.join(REPO_ROOT, stage.script);
      if (!existsSync(entry)) return false;
      const src = readFileSync(entry, "utf8");
      // An invocation, not merely the identifier appearing in an import list.
      return /discoverOtpAccounts\s*\(/.test(src);
    });

    expect(
      callers.map((c) => c.id),
      "a stage may import lib/otp/ingest.ts for runOtpMatchIngest and still never call " +
        "discoverOtpAccounts — importing the module is not running the INSERT"
    ).not.toHaveLength(0);
    for (const stage of callers) {
      expect(stage.usesRiot, `${stage.id}: account-v1 resolution spends the shared Riot key`).toBe(true);
    }
  });
});
