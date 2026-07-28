// ─────────────────────────────────────────────────────────────────────────────
// POST /api/otp/refresh?championId=<n>&championKey=<RiotKey>
//
// On-demand OTP fill for the champion the user is actually looking at, in the
// same spirit as (and modelled on) POST /api/pros/refresh: a background sweep
// can never keep 170 champions current, so freshness is pulled to the moment
// of interest.
//
// POST, not GET, for the same non-negotiable reason as /api/pros/refresh: this
// MUTATES and SPENDS the shared Riot key, whose cap suspends every surface in
// the app when exceeded (repo gotcha (d)). A GET would be fireable
// cross-origin by a bare <img> tag on any page on the internet.
//
// BUDGETED, NOT COMPLETE. One invocation does at most a discovery pass plus
// ONE account's matches, because every Riot call is serialised at 1.3s through
// the shared pacer and Vercel gives us 60s. A champion converges across
// repeated views rather than in one call — the walk is stalest-first, so each
// visit advances a different account.
//
// op.gg REACHABILITY FROM VERCEL IS UNVERIFIED. Leaguepedia is Cloudflare-
// blocked from Vercel egress (gotcha (o)) and op.gg is an undocumented
// endpoint with no stated policy, so it may behave the same way. That is why
// discovery FAILS SOFT here (fetchOtpCandidates returns [] on anything that
// isn't a clean parse) and why scripts/ingest-otp.mjs exists as the primary,
// known-good path from this machine. Do not assume this route is doing the
// work until its own response says it did.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { discoverOtpAccounts, runOtpMatchIngest } from "@/lib/otp/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Re-run the op.gg leaderboard lookup at most this often per champion. The
 *  one-trick roster churns on a weekly scale, so anything shorter spends
 *  calls to re-learn the same 8 names. */
const DISCOVERY_COOLDOWN_HOURS = 72;

/** Guards the shared Riot budget against a page that re-renders, a user
 *  flipping lanes, or two devices on the same champion. */
const REFRESH_COOLDOWN_MINUTES = 5;

/** One account per invocation: 1 ids call + up to 20 match calls = 21 calls
 *  * 1.3s ≈ 27s, comfortably inside maxDuration=60 with room for the
 *  discovery pass that may precede it. */
const ACCOUNTS_PER_CALL = 1;
const MATCHES_PER_ACCOUNT = 20;

/** Riot champion keys are alphanumeric ("Viktor", "MonkeyKing", "KogMaw") —
 *  validated because this value reaches an outbound URL path segment. */
const CHAMPION_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const champParam = searchParams.get("championId");
  const keyParam = searchParams.get("championKey");

  if (!champParam || !/^\d+$/.test(champParam)) {
    return NextResponse.json({ error: "Invalid or missing championId" }, { status: 400 });
  }
  if (!keyParam || !CHAMPION_KEY_RE.test(keyParam)) {
    return NextResponse.json({ error: "Invalid or missing championKey" }, { status: 400 });
  }
  const championId = parseInt(champParam, 10);

  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ refreshed: false, reason: "no-db" });
  }
  if (!process.env.RIOT_API_KEY) {
    return NextResponse.json({ refreshed: false, reason: "no-riot-key" });
  }

  try {
    // ATOMIC CLAIM — one statement, not read-then-write. This is the same
    // discipline gotcha (w) pins for the prostage timeline route, and for the
    // same reason: a SELECT-then-check-then-UPDATE lets two concurrent views
    // of the same champion (two devices, a re-render, a lane flip) both read
    // the stale stamp, both pass the cooldown, and both spend the shared Riot
    // budget. The cooldown predicate lives INSIDE the write, so exactly one
    // caller gets rows back and every loser returns having made zero outbound
    // calls.
    //
    // The RETURNING value is the row's post-write state; last_discovered_at is
    // untouched by this statement, so it is the real prior discovery stamp
    // (and NULL on the first-ever insert, which correctly forces discovery).
    const claimed = (await sql`
      INSERT INTO coachbuild.otp_champion_cursor (champion_id, last_attempted_at)
      VALUES (${championId}, now())
      ON CONFLICT (champion_id) DO UPDATE
        SET last_attempted_at = now()
        WHERE coachbuild.otp_champion_cursor.last_attempted_at IS NULL
           OR coachbuild.otp_champion_cursor.last_attempted_at
              < now() - make_interval(mins => ${REFRESH_COOLDOWN_MINUTES})
      RETURNING last_discovered_at
    `) as unknown as { last_discovered_at: string | null }[];

    if (!Array.isArray(claimed) || claimed.length === 0) {
      return NextResponse.json({ refreshed: false, reason: "cooldown" });
    }

    const now = Date.now();
    const discoveredAt = claimed[0]?.last_discovered_at
      ? new Date(claimed[0].last_discovered_at).getTime()
      : 0;
    let accountsUpserted = 0;
    if (now - discoveredAt > DISCOVERY_COOLDOWN_HOURS * 3_600_000) {
      const discovery = await discoverOtpAccounts(championId, keyParam);
      accountsUpserted = discovery.accountsUpserted;
    }

    const ingest = await runOtpMatchIngest({
      championId,
      batch: ACCOUNTS_PER_CALL,
      matchesPerAccount: MATCHES_PER_ACCOUNT,
    });

    return NextResponse.json({
      refreshed: true,
      accountsUpserted,
      accountsProcessed: ingest.accountsProcessed,
      matchesUpserted: ingest.matchesUpserted,
    });
  } catch (err) {
    console.error("[/api/otp/refresh] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
