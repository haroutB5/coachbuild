import { NextRequest, NextResponse } from "next/server";
import { linkAccount, type LinkAccountResult } from "@/lib/mystats/account";
import { ACCOUNT_SECRET_HEADER, checkAccountSecret } from "@/lib/mystats/accountAuth";
import {
  getDiagnostics,
  insertDiagnostics,
  isDiagnosticsError,
  parseDiagnosticsBody,
  parseDiagnosticsIdentity,
  parseDiagnosticsOrdinal,
} from "@/lib/mystats/diagnostics";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function authFailure(req: NextRequest): NextResponse | null {
  const auth = checkAccountSecret(process.env.MYSTATS_ACCOUNT_SECRET, req.headers.get(ACCOUNT_SECRET_HEADER));
  if (auth.ok) return null;
  return auth.reason === "not-configured"
    ? json({ ok: false, reason: "not-configured", detail: "MYSTATS_ACCOUNT_SECRET is not set on the server" }, 503)
    : json({ ok: false, reason: "unauthorized" }, 401);
}

function unresolved(result: Exclude<LinkAccountResult, { ok: true }>) {
  const status = result.reason === "account-not-found" ? 404 : 502;
  return json({ ok: false, reason: result.reason }, status);
}

/** POST {gameName, tagLine, body, source}; identity is always resolved server-side. */
export async function POST(req: NextRequest) {
  const denied = authFailure(req);
  if (denied) return denied;

  const sql = getSql();
  if (!sql) return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);

  const raw = await req.json().catch(() => null);
  const parsed = parseDiagnosticsBody(raw);
  if (isDiagnosticsError(parsed)) {
    return json({ ok: false, reason: "invalid-body", detail: parsed.error }, 400);
  }

  try {
    // Same resolver used by rank-sample's companion path. Never accept or infer
    // a puuid from the request: the LCU's UUID joins to no Riot-backed rows.
    const resolved = await linkAccount(sql, { gameName: parsed.gameName, tagLine: parsed.tagLine });
    if (!resolved.ok) return unresolved(resolved);

    await insertDiagnostics(sql, {
      puuid: resolved.account.puuid,
      body: parsed.body,
      source: parsed.source,
    });
    return json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);
    }
    console.error("[/api/mystats/diagnostics POST] Unexpected error:", err);
    return json({ ok: false, reason: "server-error" }, 500);
  }
}

/** GET ?gameName=...&tagLine=...&n=1; successful responses are exact plain text. */
export async function GET(req: NextRequest) {
  const denied = authFailure(req);
  if (denied) return denied;

  const sql = getSql();
  if (!sql) return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);

  const params = new URL(req.url).searchParams;
  const identity = parseDiagnosticsIdentity(params.get("gameName"), params.get("tagLine"));
  if (isDiagnosticsError(identity)) {
    return json({ ok: false, reason: "invalid-identity", detail: identity.error }, 400);
  }
  const ordinal = parseDiagnosticsOrdinal(params.get("n"));
  if (isDiagnosticsError(ordinal)) {
    return json({ ok: false, reason: "invalid-n", detail: ordinal.error }, 400);
  }

  try {
    const resolved = await linkAccount(sql, identity);
    if (!resolved.ok) return unresolved(resolved);

    const upload = await getDiagnostics(sql, resolved.account.puuid, ordinal);
    if (!upload) return json({ ok: false, reason: "not-found" }, 404);

    return new NextResponse(upload.body, {
      status: 200,
      headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);
    }
    console.error("[/api/mystats/diagnostics GET] Unexpected error:", err);
    return json({ ok: false, reason: "server-error" }, 500);
  }
}
