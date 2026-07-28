import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError, RiotUnavailableError } from "@/lib/pro/errors";
import { runOtpMatchIngest } from "@/lib/otp/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Background OTP match sweep. DELIBERATELY MATCH-INGEST ONLY — discovery (the
// op.gg leaderboard lookup) is NOT run here.
//
// Why: op.gg's reachability from Vercel egress is unverified, and this repo
// has already been burned once by assuming an external feed works from
// serverless — Leaguepedia's ingest silently returned HTTP 200 with zero rows
// for WEEKS because api.php rate-limits shared datacenter IPs and CargoExport
// Cloudflare-403s them (gotcha (o)). Riot's API, by contrast, is confirmed
// reachable from Vercel (gotcha (u)). So the half that is known to work runs
// here, and discovery runs from this machine via scripts/ingest-otp.mjs,
// exactly the same split the prostage pipeline settled on.
//
// 60s budget math: each account costs 1 paced ids call plus 1 paced match call
// per NEW match — HALF the pro-account cost, because this pipeline skips the
// match-v5 timeline (see migration 0017). Worst case for a never-fetched
// account is 1 + 20 = 21 calls * 1.3s ≈ 27s, so batch=2 fits with headroom.
// Like the pro sweep this is idempotent and resumable at the MATCH level
// (ON CONFLICT DO NOTHING + an `existing` pre-query), so a mid-batch timeout
// costs nothing but the in-flight account's stamp bump.
const DEFAULT_BATCH = 2;
const MAX_BATCH = 8;

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const batchParam = searchParams.get("batch");
  const champParam = searchParams.get("championId");

  if (batchParam && !/^\d+$/.test(batchParam)) {
    return NextResponse.json({ error: "Invalid batch param" }, { status: 400 });
  }
  if (champParam && !/^\d+$/.test(champParam)) {
    return NextResponse.json({ error: "Invalid championId param" }, { status: 400 });
  }
  const batch = batchParam ? Math.min(parseInt(batchParam, 10), MAX_BATCH) : DEFAULT_BATCH;

  try {
    const result = await runOtpMatchIngest({
      batch,
      championId: champParam ? parseInt(champParam, 10) : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    if (err instanceof RiotUnavailableError) {
      return NextResponse.json({ error: "RIOT_API_KEY not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/otp] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
