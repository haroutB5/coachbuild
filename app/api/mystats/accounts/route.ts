import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getActiveAccount, linkAccount, listAccounts, setActiveAccount } from "@/lib/mystats/account";
import { ACCOUNT_SECRET_HEADER, checkAccountSecret } from "@/lib/mystats/accountAuth";
import { isAccountsRequestError, parseAccountsBody } from "@/lib/mystats/accountRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * GET /api/mystats/accounts
 * The linked-account list plus which one is active. Per-user private data ->
 * always `no-store` (CLAUDE.md gotcha (b)), same posture as every other
 * /api/mystats/* route.
 *
 * NOT secret-gated, deliberately — see lib/mystats/accountAuth.ts's header for
 * the read/write asymmetry. Never returns a puuid.
 *
 * Response: {accounts: MyAccountSummary[], activeId: number|null}
 */
export async function GET() {
  const sql = getSql();
  if (!sql) return json({ error: "DATABASE_URL not configured" }, 503);

  try {
    const accounts = await listAccounts(sql);
    const active = accounts.find((a) => a.active) ?? null;
    return json({ accounts, activeId: active?.id ?? null }, 200);
  } catch (err) {
    if (err instanceof DbUnavailableError) return json({ error: "DATABASE_URL not configured" }, 503);
    console.error("[/api/mystats/accounts GET] Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/mystats/accounts — the only WRITE path for the linked-account list.
 *
 * AUTH: `x-coachbuild-account-secret` must equal MYSTATS_ACCOUNT_SECRET. There
 * is NO unauthenticated fallback: a missing server-side secret answers 503
 * `{error:"not-configured"}` and writes nothing, rather than degrading into an
 * open endpoint. See lib/mystats/accountAuth.ts for the full reasoning; the
 * short version is that this write repoints every My Stats surface at a
 * different account and can spend the shared Riot key.
 *
 * Two modes (lib/mystats/accountRequest.ts validates the body):
 *
 *  {mode:"detect", gameName, tagLine, puuid}
 *    The identity the League client reported, via companion 1.10.0's GET /me.
 *    Links the account if new (resolving its region from the puuid — one Riot
 *    call, ONLY for a puuid never seen before) and makes it active. Idempotent
 *    and free for an already-linked account, which is what makes it safe to
 *    call on every page view. `riot_id` is refreshed each time, so a Riot name
 *    change follows the account instead of leaving a stale tag.
 *
 *  {mode:"select", id}
 *    Switch to an already-linked account by its local id. No Riot call ever.
 *    404 when the id matches no row (never a silent no-op that looks like it
 *    worked).
 *
 * Response (200): {accounts, activeId, riotId, created, switched}
 *  - `created`  — a new account row was inserted (detect only, else false)
 *  - `switched` — the active account actually CHANGED as a result of this call
 * A caller that gets `switched:true` should re-fetch /api/mystats/summary: every
 * number on it is scoped to the active account and has just changed meaning.
 */
export async function POST(req: NextRequest) {
  const auth = checkAccountSecret(process.env.MYSTATS_ACCOUNT_SECRET, req.headers.get(ACCOUNT_SECRET_HEADER));
  if (!auth.ok) {
    // Checked BEFORE the DB and before the body is even read: an unauthenticated
    // caller must not be able to learn whether the DB is up, nor get its input
    // validated for free.
    return auth.reason === "not-configured"
      ? json({ error: "not-configured", detail: "MYSTATS_ACCOUNT_SECRET is not set on the server" }, 503)
      : json({ error: "unauthorized" }, 401);
  }

  const sql = getSql();
  if (!sql) return json({ error: "DATABASE_URL not configured" }, 503);

  const raw = await req.json().catch(() => null);
  const parsed = parseAccountsBody(raw);
  if (isAccountsRequestError(parsed)) return json({ error: "invalid-body", detail: parsed.error }, 400);

  try {
    const before = await getActiveAccount(sql);

    if (parsed.mode === "select") {
      const account = await setActiveAccount(sql, parsed.id);
      if (!account) return json({ error: "no-such-account" }, 404);
      return json(
        {
          accounts: await listAccounts(sql),
          activeId: account.id,
          riotId: account.riotId,
          created: false,
          switched: before?.id !== account.id,
        },
        200
      );
    }

    const result = await linkAccount(sql, {
      gameName: parsed.gameName,
      tagLine: parsed.tagLine,
    });
    if (!result.ok) {
      // 404 for "this Riot ID does not exist" — a final answer about the
      // REQUEST, which the caller fixes by sending a different name. 502 for
      // everything else: nothing is wrong with this app or the request, the
      // upstream just did not answer, and a retry is worth making. Returning
      // 502 for a genuinely absent account would invite a client to retry
      // forever; returning 404 for a rate-limited key would tell someone their
      // real account does not exist. Nothing is written in either case.
      const status = result.reason === "account-not-found" ? 404 : 502;
      return json({ error: result.reason }, status);
    }
    return json(
      {
        accounts: await listAccounts(sql),
        activeId: result.account.id,
        riotId: result.account.riotId,
        created: result.created,
        switched: before?.id !== result.account.id,
      },
      200
    );
  } catch (err) {
    if (err instanceof DbUnavailableError) return json({ error: "DATABASE_URL not configured" }, 503);
    console.error("[/api/mystats/accounts POST] Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
