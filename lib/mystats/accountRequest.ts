// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/accountRequest.ts — PURE request-body validation for
// POST /api/mystats/accounts. No DB, no network, no env: the route parses JSON
// and hands the value here, same "validation is a pure function, orchestration
// is the route's job" split lib/mystats/aggregate.ts uses for arithmetic.
//
// The body is attacker-controlled (see lib/mystats/accountAuth.ts for why the
// endpoint is exposed at all), so every field is checked for TYPE and SHAPE
// before it reaches a SQL parameter or a Riot URL. Note the `puuid` charset
// check in particular: that value is interpolated into an account-v1 request
// path by getRegionByPuuid, so it must not be able to carry a `/` or `?`.
// ─────────────────────────────────────────────────────────────────────────────

export type AccountsRequest =
  /** "The League client reports this identity" — link it and make it active. */
  /** No `puuid`: the League client's is not the one Riot accepts, so the
   *  server re-resolves it from gameName + tagLine. See DetectedIdentity in
   *  lib/mystats/account.ts for the measurement behind that. */
  | { mode: "detect"; gameName: string; tagLine: string }
  /** "Switch to this already-linked account" — by local id, never by puuid, so
   *  a client can only ever name an account the table already holds. */
  | { mode: "select"; id: number };

/** Riot puuids are 78-character URL-safe-base64-ish strings today. The bound is
 *  deliberately loose on LENGTH (a format change should not break the feature)
 *  and strict on CHARSET (this value ends up in a URL path). */
const PUUID_RE = /^[A-Za-z0-9_-]{20,128}$/;
/** Riot game names allow spaces and a wide unicode range, so this checks only
 *  that something non-blank of a sane length arrived — never a character
 *  allowlist, which would reject legitimate non-Latin names. */
const NAME_MAX = 64;
const TAG_MAX = 16;

function nonBlankString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return null;
  return s;
}

/** Returns the parsed request, or a `reason` string naming the FIRST problem
 *  found (the route turns it into a 400 body). Never throws — a null/garbage/
 *  non-object input is just an invalid body. */
export function parseAccountsBody(body: unknown): AccountsRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (b.mode === "select") {
    const id = b.id;
    // Integer-only: a float or numeric string would reach a smallint column and
    // either error or silently round to a DIFFERENT account's id.
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      return { error: "select requires an integer id >= 1" };
    }
    return { mode: "select", id };
  }

  if (b.mode === "detect") {
    const gameName = nonBlankString(b.gameName, NAME_MAX);
    if (!gameName) return { error: `gameName must be a non-blank string <= ${NAME_MAX} chars` };
    const tagLine = nonBlankString(b.tagLine, TAG_MAX);
    if (!tagLine) return { error: `tagLine must be a non-blank string <= ${TAG_MAX} chars` };
    // `puuid` is ACCEPTED AND IGNORED if present, never validated and never
    // read. v0.83.0 took it and used it; the LCU's value is a 36-char local
    // UUID that Riot rejects, so linkAccount now re-resolves from the Riot ID
    // (see DetectedIdentity). Rejecting the field outright would 400 every
    // client still sending it — including a cached bundle mid-deploy — for a
    // value we no longer care about, so it is simply dropped here.
    return { mode: "detect", gameName, tagLine };
  }

  return { error: 'mode must be "detect" or "select"' };
}

export function isAccountsRequestError(v: AccountsRequest | { error: string }): v is { error: string } {
  return typeof (v as { error?: unknown }).error === "string";
}
