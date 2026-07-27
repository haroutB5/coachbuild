// ─────────────────────────────────────────────────────────────────────────────
// GET /api/skill-order?champ=<championId>&role=<roleId>
//
// The recommended ability-levelling order for a champion + role.
//
// Payload is `SkillOrderModel | null`, served bare (no wrapper object) — the
// same envelope convention as /api/build, which returns its top-3 variants as
// a bare array rather than `{ data: [...] }`.
//
// ── null is a NORMAL, SUCCESSFUL answer ────────────────────────────────────
// Every "we don't have this" case — unsupported role, unknown champion,
// upstream down/timed out/reshaped — returns HTTP 200 with a `null` body, so
// the UI simply omits the skill-order card. It is deliberately NOT an error
// status: an absent optional card is not a failed request, and making the
// client branch on status codes to decide whether to render an optional card
// is how optional cards turn into broken pages.
//
// Malformed QUERY PARAMS still 400 (mirroring /api/build) — that is a client
// bug, not a data-availability outcome, and silently 200-nulling it would
// hide a real integration mistake from whoever is calling us.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId, SkillOrderModel } from "@/lib/types";
import { getChampionById } from "@/lib/staticData";
import { fetchSkillOrder, CACHE_TTL_SECONDS } from "@/lib/opgg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only, unauthenticated data — safe to expose to any origin.
// Added 2026-07-27 (audit fix #8) for the Overwolf overlay's
// `overwolf-extension://<id>` origin: the manifest's `externally_connectable`
// field does NOT grant this — that field controls which origins may
// postMessage INTO the app, it grants no outbound-fetch CORS relief. Applied
// to EVERY response this route returns (payload, empty, AND the 400s below)
// so a CORS rejection can never masquerade as a data/validation failure to
// the client. Does not touch the Cache-Control logic below (repo gotcha (b)
// stays exactly as it was).
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/** Repo gotcha (b): never let the CDN cache an empty/degraded response —
 *  only a real payload earns a long s-maxage. */
const EMPTY_HEADERS = { "Cache-Control": "no-store", ...CORS_HEADERS };
const PAYLOAD_HEADERS = {
  "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`,
  ...CORS_HEADERS,
};

function empty() {
  return NextResponse.json<SkillOrderModel | null>(null, { headers: EMPTY_HEADERS });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const champParam = searchParams.get("champ");
  const roleParam = searchParams.get("role");

  if (!champParam || !roleParam) {
    const body: ApiError = { error: "Missing required query params: champ, role" };
    return NextResponse.json(body, { status: 400, headers: CORS_HEADERS });
  }

  // Strict integer params (reject "2x", "86.5", etc.) — same guard as /api/build.
  if (!/^\d+$/.test(champParam) || !/^\d+$/.test(roleParam)) {
    const body: ApiError = { error: "Invalid champ or role param" };
    return NextResponse.json(body, { status: 400, headers: CORS_HEADERS });
  }

  const championId = parseInt(champParam, 10);
  const roleId = parseInt(roleParam, 10) as RoleId;

  if (roleId < 0 || roleId > 5) {
    const body: ApiError = { error: "Invalid role (must be 0-5)" };
    return NextResponse.json(body, { status: 400, headers: CORS_HEADERS });
  }

  try {
    // Reuse the app's existing champion metadata rather than a second
    // champion table — we need the Riot key to derive op.gg's champion name.
    const champion = await getChampionById(championId);
    if (!champion?.key) return empty();

    const model = await fetchSkillOrder(champion.key, roleId);
    if (!model) return empty();

    return NextResponse.json<SkillOrderModel>(model, { headers: PAYLOAD_HEADERS });
  } catch (err) {
    // A genuine internal failure still degrades to "no card" rather than a
    // 500 the client would have to special-case. Logged server-side in full.
    console.error("[/api/skill-order] Unexpected error:", err);
    return empty();
  }
}
