// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/accountAuth.ts — the shared-secret gate on writes to
// POST /api/mystats/accounts.
//
// WHY A SECRET EXISTS HERE AT ALL, when nothing else in this app has auth.
// The identity has to make a round trip the app cannot make for itself: the
// League client is on 127.0.0.1, which a Vercel function cannot reach, so the
// BROWSER reads the identity from the companion and POSTs it up. That makes the
// write endpoint reachable by anyone on the internet who knows the URL, and the
// write is not cosmetic — it repoints which account every My Stats surface
// reports on, and a NEW puuid additionally spends a call against the shared
// Riot key (CLAUDE.md gotcha (d)). Unauthenticated, a stranger could park the
// user's My Stats on an account they don't own, and drain quota by cycling
// puuids.
//
// The READ side (GET /api/mystats/accounts, and the `accounts` field on
// /api/mystats/summary) is deliberately NOT gated: it is the same exposure
// class as /api/mystats/summary itself, which has always served this user's own
// match history openly. Adding a gate to the read while the summary stays open
// would be theatre. Adding one to the WRITE is not, because a write has effects
// a read does not. This asymmetry is intentional -- see HANDOFF-engy.md.
//
// NO SOFT FALLBACK, deliberately. If MYSTATS_ACCOUNT_SECRET is unset the route
// answers "not configured" and writes NOTHING -- it never degrades into an open
// endpoint. A misconfiguration must fail closed: an open write here is
// indistinguishable in effect from no protection ever having been added, and it
// would fail silently, at exactly the moment nobody is looking.
// ─────────────────────────────────────────────────────────────────────────────

import { timingSafeEqual } from "node:crypto";

/** Header the browser sends the secret in. A header rather than a body field so
 *  it never lands in a log line that echoes a request body, and so the same
 *  value works unchanged if a future GET ever needs gating too. */
export const ACCOUNT_SECRET_HEADER = "x-coachbuild-account-secret";

export type AccountAuthResult =
  /** Server has no secret configured — reject, and say so distinctly from a
   *  wrong secret so the user can tell "I typed it wrong" from "the deploy is
   *  missing an env var". */
  | { ok: false; reason: "not-configured" }
  | { ok: false; reason: "unauthorized" }
  | { ok: true };

/** PURE. `configured` is the server-side secret (process.env), `provided` is
 *  whatever arrived on the request.
 *
 *  Constant-time comparison via timingSafeEqual, which throws on a length
 *  mismatch — so lengths are compared first and a mismatch short-circuits. That
 *  does leak the secret's LENGTH through timing, which is not a meaningful
 *  advantage against a value the user generates once and pastes; what matters
 *  is that a same-length near-miss cannot be walked byte by byte.
 *
 *  An empty/whitespace-only configured secret counts as NOT CONFIGURED, so
 *  `MYSTATS_ACCOUNT_SECRET=""` in a Vercel env cannot accidentally authorise
 *  every request that also sends an empty header. */
export function checkAccountSecret(
  configured: string | undefined | null,
  provided: string | undefined | null
): AccountAuthResult {
  const secret = (configured ?? "").trim();
  if (secret.length === 0) return { ok: false, reason: "not-configured" };
  if (!provided) return { ok: false, reason: "unauthorized" };

  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "unauthorized" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "unauthorized" };
}
