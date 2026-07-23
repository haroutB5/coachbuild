import { NextResponse } from "next/server";
import { getLatestPatch } from "@/lib/staticData";

// GET /api/patch — feeds the global rail's footer (plan Decision 6/R7).
// getLatestPatch() always resolves to SOMETHING (STATIC_FALLBACK_PATCH is
// the ultimate fallback if ddragon AND every coachless probe fail — see
// lib/staticData.ts), so `patch` here is never empty. CDN-cacheable: the
// resolved patch label only changes on a real League patch release.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const resolved = await getLatestPatch();
  return NextResponse.json(
    { patch: resolved.label },
    { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=3600" } }
  );
}
