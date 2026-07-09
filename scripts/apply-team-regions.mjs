#!/usr/bin/env node
// One-off backfill pass: applies the team-region activation rule (Directive
// 1, 2026-07-09) to EVERY pro currently on file, not just ones touched by a
// fresh roster ingest. Reuses lib/pro/ingestRoster.ts's applyRegionRuleToPro
// so this is the EXACT same logic the roster-ingest hook now runs per-pro —
// no separate/divergent implementation. Never deletes rows, only flips
// pro_accounts.active (reversible). Run via tsx:
//   npx tsx scripts/apply-team-regions.mjs
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { applyRegionRuleToPro } = await import("../lib/pro/ingestRoster.ts");
const { getSql } = await import("../lib/pro/db.ts");

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");

  const pros = await sql`SELECT id, slug, team FROM coachbuild.pros`;
  console.log(`applying team-region rule to ${pros.length} pros...`);

  const result = {
    prosChecked: 0,
    accountsActivated: 0,
    accountsDeactivated: 0,
    unmappedTeams: [],
    errors: [],
  };

  for (const pro of pros) {
    try {
      const before = { accountsRegionActivated: 0, accountsRegionDeactivated: 0, unmappedTeams: result.unmappedTeams };
      await applyRegionRuleToPro(sql, pro.id, pro.team, before, (m) => console.log(`  ${m}`));
      result.prosChecked += 1;
      result.accountsActivated += before.accountsRegionActivated;
      result.accountsDeactivated += before.accountsRegionDeactivated;
    } catch (err) {
      result.errors.push(`pro ${pro.slug}: ${err.message}`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("apply-team-regions failed:", err.message);
  process.exit(1);
});
