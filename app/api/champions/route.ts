import { NextResponse } from "next/server";
import { getAllChampions } from "@/lib/staticData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only, unauthenticated data -- safe to expose to any origin.
// Added 2026-07-27 (audit fix #8) for the Overwolf overlay's
// `overwolf-extension://<id>` origin: the manifest's `externally_connectable`
// field does NOT grant this -- that field controls which origins may
// postMessage INTO the app (mirrors Chrome's field of the same name), it
// grants no outbound-fetch CORS relief. Without this header, a bare
// cross-origin `fetch()` from the overlay is rejected by the BROWSER before
// the response body is ever read, which looks identical to a real network
// failure client-side -- see overwolf/js/skillOrderData.js's "unavailable"
// handling, which now depends on this actually being present.
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export async function GET() {
  try {
    const champions = await getAllChampions();
    return NextResponse.json(champions, {
      headers: {
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    console.error("[/api/champions] Error:", err);
    return NextResponse.json(
      { error: "Failed to load champion list" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
