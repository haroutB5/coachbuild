#!/usr/bin/env node
// One-off: upsert ONE pro by lolpros slug (Directive 2, 2026-07-09 — Bwipo,
// ex-pro). Reuses lib/pro/ingestRoster.ts's ingestOnePro (same account-
// resolution + team-region-rule path as the full roster sweep) rather than
// duplicating that logic. If the pro already exists, reuses their real id
// (never generates a new one / never risks a duplicate row); otherwise uses
// the lolpros-profile-confirmed uuid.
// Run via tsx: npx tsx scripts/upsert-pro.mjs <lolpros-slug>
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { ingestOnePro } = await import("../lib/pro/ingestRoster.ts");
const { getProfile } = await import("../lib/pro/lolpros.ts");
const { getSql } = await import("../lib/pro/db.ts");

const slug = process.argv[2];
if (!slug) {
  console.error("usage: npx tsx scripts/upsert-pro.mjs <lolpros-slug>");
  process.exit(1);
}

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");

  const profile = await getProfile(slug);
  if (!profile) {
    console.error(`no lolpros profile found for slug "${slug}"`);
    process.exit(1);
  }

  const existing = await sql`SELECT id FROM coachbuild.pros WHERE slug = ${slug}`;
  const uuid = existing[0]?.id ?? profile.uuid;

  const entry = {
    uuid,
    slug,
    name: profile.name,
    country: profile.country,
    position: profile.position,
    team: profile.team,
    account: null,
  };

  const result = {
    pagesFetched: 0,
    prosSeen: 0,
    prosUpserted: 0,
    accountsUpserted: 0,
    accountsUnresolved: 0,
    errors: [],
    accountsRegionActivated: 0,
    accountsRegionDeactivated: 0,
    unmappedTeams: [],
  };

  await ingestOnePro(sql, entry, result, (m) => console.log(`  ${m}`));
  console.log(JSON.stringify({ slug, uuid, team: profile.team?.name ?? null, ...result }, null, 2));
}

main().catch((err) => {
  console.error("upsert-pro failed:", err.message);
  process.exit(1);
});
