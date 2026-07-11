// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/db.ts — Neon serverless client, memoized per process. HTTP-based
// driver (works in Vercel serverless + plain Node scripts alike). Every table
// lives under the dedicated `coachbuild` schema — never touch `public` (this
// instance is shared with another app).
// ─────────────────────────────────────────────────────────────────────────────

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cached: NeonQueryFunction<false, false> | null = null;
let cachedUrl: string | null = null;

/** Returns null when DATABASE_URL is absent — callers must degrade gracefully
 *  (empty results / 503, never throw an unhandled error to the client). */
export function getSql(): NeonQueryFunction<false, false> | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!cached || cachedUrl !== url) {
    // cache:'no-store' is LOAD-BEARING (prod incident 2026-07-11): on Vercel,
    // Next.js patches fetch with its persistent Data-Cache-aware version and
    // the driver's POSTs to the Neon HTTP endpoint were being CACHED — a
    // {rows:[]} response recorded while a table was still empty kept being
    // replayed for the exact (query bytes + params) cache key, across
    // deployments, while byte-different variants of the same query returned
    // live rows. Symptom: /api/pros prostage empty for some (champion, limit)
    // combos while soloq worked in the same response. no-store opts every
    // driver call out of the fetch data cache.
    cached = neon(url, { fetchOptions: { cache: "no-store" } });
    cachedUrl = url;
  }
  return cached;
}
