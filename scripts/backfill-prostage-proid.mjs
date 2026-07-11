#!/usr/bin/env node
// Backfills coachbuild.prostage_matches.pro_id for historical rows that
// ingested BEFORE lib/prostage/ingest.ts's pro_id name-match tried the
// CLEANED form of player_link (fix landed 2026-07-11, alongside this
// script). Root cause: Leaguepedia's player_link carries a real-name
// disambiguator for some players (e.g. "Zeka (Kim Geon-woo)") that
// coachbuild.pros.name never does ("Zeka") — the original exact-match-only
// lookup silently left pro_id NULL for every such row, INCLUDING already-
// tracked pros. Audited live 2026-07-11: 400/1870 prostage_matches rows carry
// a trailing parenthetical in player_link, and 0 of those 400 had pro_id set.
//
// This is a pure local-DB operation (no Leaguepedia/Cargo/Riot call — the
// data needed, prostage_matches + pros, is already in Postgres), so it's a
// single idempotent UPDATE rather than a paced/resumable-with-cursor script:
// re-running is always safe (the WHERE pro_id IS NULL guard means an
// already-fixed row simply drops out and is never re-touched).
//
// Matches the SAME conservative rule as the ingest-time fix and the
// app/api/pros/route.ts comps fallback (see lib/prostage/displayName.ts's
// cleanLeaguepediaName doc comment): exact, case-insensitive match on
// pros.name against EITHER the raw player_link OR its cleaned (single
// trailing "(...)" group stripped) form. Never fuzzy.
import { loadEnvLocal } from "./_env.mjs";
import { neon } from "@neondatabase/serverless";

loadEnvLocal();

if (!process.env.DATABASE_URL) {
  console.error("backfill-prostage-proid: DATABASE_URL not set");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });

async function main() {
  const before = await sql`
    SELECT count(*)::int AS n FROM coachbuild.prostage_matches WHERE pro_id IS NULL
  `;
  console.log(`prostage_matches rows with pro_id IS NULL before backfill: ${before[0].n}`);

  // regexp_replace mirrors lib/prostage/displayName.ts's cleanLeaguepediaName
  // regex (\s*\([^()]*\)\s*$) exactly — Postgres ARE syntax, same semantics:
  // strip ONE trailing "(...)" group, never recurse, leave untouched if the
  // strip would produce an empty string. NOTE: backslashes are DOUBLED in
  // this JS source ('\\s*\\(...') — a single backslash here would be
  // silently swallowed by JS string-escape parsing before the query text
  // ever reaches Postgres (verified live 2026-07-11 while writing this
  // script — `'\s'` in a JS string literal becomes the two characters `s`,
  // not backslash-s, which would produce a subtly wrong regex).
  const result = await sql`
    UPDATE coachbuild.prostage_matches pm
    SET pro_id = p.id
    FROM coachbuild.pros p
    WHERE pm.pro_id IS NULL
      AND (
        lower(p.name) = lower(pm.player_link)
        OR lower(p.name) = lower(
          NULLIF(trim(regexp_replace(pm.player_link, '\\s*\\([^()]*\\)\\s*$', '')), '')
        )
      )
    RETURNING pm.game_id, pm.player_link, p.name AS matched_pro_name
  `;

  console.log(`matched + updated ${result.length} row(s):`);
  for (const row of result) {
    console.log(`  ${row.game_id} | player_link="${row.player_link}" -> pro "${row.matched_pro_name}"`);
  }

  const after = await sql`
    SELECT count(*)::int AS n FROM coachbuild.prostage_matches WHERE pro_id IS NULL
  `;
  console.log(`prostage_matches rows with pro_id IS NULL after backfill: ${after[0].n}`);
}

main().catch((err) => {
  console.error("backfill-prostage-proid failed:", err);
  process.exit(1);
});
