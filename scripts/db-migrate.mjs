#!/usr/bin/env node
// Applies migrations/*.sql to the live Neon DB, tracked in
// coachbuild._migrations (filename-keyed, idempotent). Plain JS (no TS build
// step needed) — run with: node scripts/db-migrate.mjs
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { loadEnvLocal, REPO_ROOT } from "./_env.mjs";

loadEnvLocal();

// Pool defaults to a WebSocket transport, which needs a global `WebSocket`
// (Node 22+) or the `ws` package as a polyfill — neither is available here
// (Node 20, and `ws` isn't a project dependency). poolQueryViaFetch routes
// Pool.query() over plain HTTP fetch instead, which this environment already
// proved works (lib/pro/db.ts's neon() client is fetch-based and runs fine).
// No new dependency, no WebSocket needed.
neonConfig.poolQueryViaFetch = true;

const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

/** The fetch-transport Pool executes each query as a single prepared
 *  statement — Postgres rejects a semicolon-separated batch ("cannot insert
 *  multiple commands into a prepared statement"), unlike the WebSocket
 *  transport's simple-query protocol. Strip `--` line comments FIRST (a
 *  semicolon inside a comment, e.g. "...pro_matches.runes; empty arrays..."
 *  in 0002_prostage.sql, would otherwise split a statement in half), then
 *  split on statement-terminating `;` — safe for this project's plain DDL
 *  migrations, which contain no semicolons inside string/dollar-quoted
 *  literals or block comments. */
function splitStatements(sql) {
  const withoutComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set (checked process.env and .env.local)");
    process.exit(1);
  }

  // Deliberately NOT using pool.connect() — a checked-out session client
  // still negotiates a WebSocket even with poolQueryViaFetch set (that flag
  // only covers the query-without-a-checked-out-client shortcut). Plain
  // pool.query() per statement stays on the fetch transport throughout, and
  // this script has no multi-statement transaction requiring session
  // affinity (each CREATE/SELECT/INSERT below is independent), so there's no
  // behavioral loss.
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("CREATE SCHEMA IF NOT EXISTS coachbuild");
    await pool.query(`
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
      const { rows } = await pool.query(
        "SELECT 1 FROM coachbuild._migrations WHERE filename = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`apply ${file} ...`);
      for (const statement of splitStatements(sql)) {
        await pool.query(statement);
      }
      await pool.query(
        "INSERT INTO coachbuild._migrations (filename) VALUES ($1)",
        [file]
      );
      console.log(`done  ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
