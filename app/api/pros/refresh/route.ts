// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pros/refresh?proId=<uuid> — on-demand solo-queue refresh for ONE pro.
//
// POST, not GET, because this MUTATES (writes pro_matches) and SPENDS a
// third-party budget (the shared Riot key, whose cap suspends the key for every
// surface — see gotcha (d)). As a GET it was fireable cross-origin with no CORS
// involvement at all: any `<img src=".../api/pros/refresh?proId=...">` on any
// page on the internet would trigger a real Riot spend for every visitor who
// loaded it. Safe-method semantics are not decoration; a GET must not do this.
//
// WHY THIS EXISTS (2026-07-25, v0.53.0): the background sweep can never keep
// every pro current. It walks `batch = 5` accounts per invocation and the Vercel
// Hobby cron fires once every 2 days with no external pinger to drain the
// cursor — against 2801 accounts that is a ~3-YEAR full cycle. Measured live:
// 2440 of 2801 accounts had NEVER been fetched, and exactly 1 had been fetched
// in the previous 2 days. Users reported it as "Bwipo's soloQ isn't up to date"
// and "TheShy has no games"; the real answer was that their turn had not come
// up and never realistically would.
//
// So freshness is pulled to the moment of interest instead: opening a player on
// the Pro Players screen refreshes THAT player. Riot's API — unlike Leaguepedia
// (see lib/prostage/cargo.ts + CHANGELOG 0.52.0) — is NOT blocked from Vercel's
// egress, so this can run serverless.
//
// The background sweep still runs (now locally, on a schedule) to build broad
// coverage over time; this route makes the pro you are actually looking at
// current on the spot.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { ingestOneAccount } from "@/lib/pro/ingestMatches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Skip a refresh if this pro's accounts were all fetched within this window.
 *  Opening the same player repeatedly (or a re-render) must not re-hit Riot. */
const COOLDOWN_MINUTES = 10;

/** Matches pulled per account. Deliberately small: this is a "catch me up",
 *  not a backfill, and it shares the 60s budget with every account the pro has. */
const MATCHES_PER_ACCOUNT = 10;

/** Bounds the work for a pro with many smurfs — the walk is ordered
 *  stalest-first so an over-limit pro still converges across repeat opens. */
const MAX_ACCOUNTS = 4;

interface AccountRow {
  puuid: string;
  pro_id: string;
  region: string;
  riot_id: string;
  last_fetched_at: string | null;
}

export async function POST(req: NextRequest) {
  const sql = getSql();
  if (!sql) {
    // Degrade quietly: the caller treats a failed refresh as "show what we have".
    return NextResponse.json({ refreshed: false, reason: "db_unavailable" }, { status: 200 });
  }

  const proId = req.nextUrl.searchParams.get("proId");
  if (!proId) {
    return NextResponse.json({ error: "proId required" }, { status: 400 });
  }
  // Reject anything that isn't a UUID before it reaches the DB or Riot. This is
  // an UNAUTHENTICATED endpoint that spends Riot API budget, so the shape check
  // is the cheap first gate — a malformed id must cost one regex, not a query.
  // (Abuse beyond that is bounded by the per-pro cooldown and MAX_ACCOUNTS
  // below; a public deployment would want a rate limit here too.)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proId)) {
    return NextResponse.json({ error: "invalid proId" }, { status: 400 });
  }

  // `active = false` accounts are dead/renamed smurfs the roster audit retired
  // (scripts/audit-accounts.mjs). The background sweep skips them and so must
  // this — TheShy's only mapped account is inactive, and hammering it would
  // burn Riot budget on a guaranteed-empty result every time he is opened.
  const accounts = (await sql`
    SELECT puuid, pro_id, region, riot_id, last_fetched_at
    FROM coachbuild.pro_accounts
    WHERE pro_id = ${proId} AND active
    ORDER BY last_fetched_at ASC NULLS FIRST
    LIMIT ${MAX_ACCOUNTS}
  `) as unknown as AccountRow[];

  if (accounts.length === 0) {
    // Distinguish "we have no live account mapped for this pro" (a real,
    // stable state — retired/renamed accounts, or never mapped) from "we
    // simply have not got round to fetching them yet". The UI can then be
    // honest rather than implying data is merely pending.
    const [any] = (await sql`
      SELECT count(*)::int AS total FROM coachbuild.pro_accounts WHERE pro_id = ${proId}
    `) as unknown as { total: number }[];
    return NextResponse.json({
      refreshed: false,
      reason: (any?.total ?? 0) > 0 ? "no_active_accounts" : "no_accounts",
      inserted: 0,
    });
  }

  const cutoff = Date.now() - COOLDOWN_MINUTES * 60_000;
  const allFresh = accounts.every(
    (a) => a.last_fetched_at != null && new Date(a.last_fetched_at).getTime() > cutoff,
  );
  if (allFresh) {
    return NextResponse.json({ refreshed: false, reason: "cooldown", inserted: 0 });
  }

  let inserted = 0;
  const errors: string[] = [];
  for (const account of accounts) {
    try {
      inserted += await ingestOneAccount(sql, account, MATCHES_PER_ACCOUNT, () => {});
    } catch (err) {
      // One bad account (rate limit, dead puuid) must not sink the others.
      errors.push(`${account.riot_id}: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({
    refreshed: true,
    accounts: accounts.length,
    inserted,
    errors,
    errorCount: errors.length,
  });
}
