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
    cached = neon(url);
    cachedUrl = url;
  }
  return cached;
}
