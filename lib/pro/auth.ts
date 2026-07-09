// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/auth.ts — shared bearer-token guard for /api/ingest/* routes.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";

/** Returns true when the request carries `Authorization: Bearer <CRON_SECRET>`
 *  and CRON_SECRET is actually configured (an unset secret never authorizes). */
export function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}
