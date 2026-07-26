// ─────────────────────────────────────────────────────────────────────────────
// lib/patchMoversCache.ts — amplification bound for GET /api/patch-movers
// (2026-07-26 audit P2 security: "/api/patch-movers amplification").
//
// Split out of the route module because Next.js's generated route-type
// checker (.next/types/app/**/route.ts) rejects any export from a route file
// other than the small whitelisted set (GET/POST/config/runtime/dynamic/...)
// — a test-only export like a cache-reset helper fails `tsc --noEmit` there,
// so this lives in `lib/` like every other piece of route logic and the
// route just imports it.
//
// Two independent problems, one instance-scoped guard:
//  1. Cache-key bypass — the route's own Cache-Control is keyed by the CDN on
//     the full request URL, so `?<anything>=1` was a free ticket past the 24h
//     edge cache straight to computePatchMovers() (~400 coachless calls at
//     concurrency 10). That half of the fix lives in the route itself (a
//     redirect to the canonical bare path before this module is even
//     touched) — see app/api/patch-movers/route.ts.
//  2. Outage amplification — a degraded (empty movers) result is correctly
//     served `no-store` so a real outage never gets pinned at the CDN edge,
//     but that also meant every single page view during the outage re-ran
//     the full ~400-call sweep. `computePatchMoversBounded` below adds a
//     SHORT module-level cache + single-flight guard (same pattern as
//     staticData.ts's patch-resolution cache) so a burst of requests on one
//     warm instance collapses to one compute, and a sustained outage is
//     re-probed at most once every DEGRADED_TTL_MS instead of once per view.
//     Scoped to a single warm serverless instance (resets on cold start) —
//     the CDN's own 24h cache remains the cross-instance defense for the
//     healthy case; this only bounds the degraded/bypassed case.
// ─────────────────────────────────────────────────────────────────────────────

import { computePatchMovers, type PatchMoversResponse, type PatchMoversUnsupported } from "./patchMovers";

export type PatchMoversResult = PatchMoversResponse | PatchMoversUnsupported;

export function isDegraded(result: PatchMoversResult): boolean {
  return "unsupported" in result || result.movers.length === 0;
}

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well under the CDN's 24h SWR.
const DEGRADED_TTL_MS = 2 * 60 * 1000; // 2m — bounds outage amplification, recovers fast.

let cached: { result: PatchMoversResult; computedAt: number } | null = null;
let inFlight: Promise<PatchMoversResult> | null = null;

export function __resetPatchMoversCacheForTests(): void {
  cached = null;
  inFlight = null;
}

export async function computePatchMoversBounded(): Promise<PatchMoversResult> {
  const now = Date.now();
  if (cached) {
    const ttl = isDegraded(cached.result) ? DEGRADED_TTL_MS : SUCCESS_TTL_MS;
    if (now - cached.computedAt < ttl) return cached.result;
  }
  if (inFlight) return inFlight;
  inFlight = computePatchMovers().finally(() => {
    inFlight = null;
  });
  try {
    const result = await inFlight;
    cached = { result, computedAt: Date.now() };
    return result;
  } catch (err) {
    // Don't poison the module-level cache with a rejected compute — let the
    // next request retry immediately rather than serving a stale/empty entry.
    cached = null;
    throw err;
  }
}
