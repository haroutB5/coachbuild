import { NextResponse } from "next/server";
import { getAllChampions, MAX_REAL_CHAMPION_ID } from "@/lib/staticData";

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

/** Skin/alternate-art entries the upstream champion data carries alongside the
 *  real roster — `Jade_Ahri` at id 60103, `Jade_Alistar` at 60012, and 58 more.
 *  They share the DISPLAY NAME of the champion they re-skin, so every consumer
 *  that lists champions by name rendered the roster with 60 duplicate entries
 *  ("Ahri, Ahri, Alistar, Alistar…" in /draft's team pickers, 2026-08-01).
 *
 *  Worse than cosmetic: these ids exist in no gameplay table, so selecting the
 *  second "Ahri" set an enemy to 60103, which `draft_matchup` has never heard
 *  of — the pick appeared to register and then silently changed nothing.
 *
 *  Real champion ids are all below 10000 (the roster tops out in the 900s);
 *  every alternate is 60000+. Filtered HERE for the public roster and again in
 *  the draft ingest's own champion walk, since that worker does not consume
 *  this endpoint. Nothing in the app referenced an id in that range — checked
 *  before cutting them. 233 entries in, 173 out, zero duplicate names. */
export async function GET() {
  try {
    const champions = (await getAllChampions()).filter((c) => c.id < MAX_REAL_CHAMPION_ID);
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
