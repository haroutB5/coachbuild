import { NextResponse } from "next/server";
import { collectStatus } from "@/lib/status/collect";

// GET /api/status — the JSON behind /status. See lib/status/verdicts.ts for
// what each check means and lib/status/collect.ts for how the facts are read.
//
// 200 for pass/warn, 503 for fail, so an uptime monitor keying on the status
// code sees the incident without parsing the body. `s-maxage=60` on BOTH
// branches: a failing status page that is re-collected on every poll would be
// the load source this route exists not to be, and 60 s of staleness on an
// incident that has already lasted minutes costs nothing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await collectStatus();
  return NextResponse.json(report, {
    status: report.overall === "fail" ? 503 : 200,
    headers: {
      "Cache-Control": "s-maxage=60, stale-while-revalidate=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
