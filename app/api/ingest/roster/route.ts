import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError } from "@/lib/pro/errors";
import { runRosterIngest } from "@/lib/pro/ingestRoster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sizeParam = searchParams.get("size");
  let rosterSize = 100;
  if (sizeParam) {
    if (!/^\d+$/.test(sizeParam)) {
      return NextResponse.json({ error: "Invalid size param" }, { status: 400 });
    }
    rosterSize = Math.min(parseInt(sizeParam, 10), 500);
  }

  try {
    const result = await runRosterIngest({ rosterSize });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/roster] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
