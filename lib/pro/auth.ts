// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/auth.ts — shared bearer-token guard for /api/ingest/* routes.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

/** Constant-time string comparison — hashes both sides to a fixed-length
 *  digest first (crypto.timingSafeEqual itself throws on unequal-length
 *  buffers, which a raw length mismatch between the provided header and the
 *  real secret would trigger almost every time, defeating the point) then
 *  compares the digests. P3(c) fix (2026-07-17 Fable review): the previous
 *  `===` comparison short-circuits on the first mismatched byte, which is a
 *  textbook timing side-channel for a bearer-token guard — mirrors the
 *  pattern in AI/gymming/api/rest-timer-push.js's isTimerPushAuthorized. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Returns true when the request carries `Authorization: Bearer <CRON_SECRET>`
 *  and CRON_SECRET is actually configured (an unset secret never authorizes). */
export function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  return timingSafeStringEqual(header, `Bearer ${secret}`);
}
