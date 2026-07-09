#!/usr/bin/env node
// Applies migrations/*.sql to the live Neon DB, tracked in
// coachbuild._migrations (filename-keyed, idempotent). Plain JS (no TS build
// step needed) — run with: node scripts/db-migrate.mjs
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";
import { loadEnvLocal, REPO_ROOT } from "./_env.mjs";

loadEnvLocal();

const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set (checked process.env and .env.local)");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS coachbuild");
    await client.query(`
      CREATE TABLE IF NOT EXISTS coachbuild._migrations (
        id serial PRIMARY KEY,
        filename text UNIQUE NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("no migration files found in", MIGRATIONS_DIR);
      return;
    }

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM coachbuild._migrations WHERE filename = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`apply ${file} ...`);
      await client.query(sql);
      await client.query(
        "INSERT INTO coachbuild._migrations (filename) VALUES ($1)",
        [file]
      );
      console.log(`done  ${file}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
