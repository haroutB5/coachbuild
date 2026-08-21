import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { linkAccount } from "@/lib/mystats/account";
import { ACCOUNT_SECRET_HEADER, checkAccountSecret } from "@/lib/mystats/accountAuth";
import {
  insertRankSample,
  isRankSampleError,
  parseRankSampleBody,
  type RankSampleWrite,
} from "@/lib/mystats/rankSample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/mystats/rank-sample — records ONE reading of the account's ranked
 * standing (spec §4, migration 0027).
 *
 * Request:  {puuid, tier, division, lp, cumulativeLp?, observedAt, source}
 *       OR: {gameName, tagLine, tier, division, lp, cumulativeLp?, observedAt, source}
 * Response: {ok:true, stored} | {ok:false, reason, detail?}
 *
 * WHY THIS ENDPOINT EXISTS. Riot's match API has never returned per-game LP
 * change, and coachbuild.my_account holds rank as a single value overwritten on
 * every refresh. "LP this session" can therefore only be measured as the
 * difference between two READINGS either side of the sitting, which needs a
 * time series nobody was keeping. The companion reads LP from the LCU — local
 * and free, unlike the shared Riot key this app's scarcest resource (CLAUDE.md
 * gotcha (d)) — and posts it here at app start, champ select and game end.
 *
 * AUTH: the SAME shared secret as POST /api/mystats/accounts
 * (`x-coachbuild-account-secret`), deliberately not a second scheme. Read
 * lib/mystats/accountAuth.ts for the full reasoning; the part specific to this
 * route is that an unauthenticated writer here could insert two readings around
 * a sitting and make a losing night render as a confident +90. There is NO soft
 * fallback: an unset MYSTATS_ACCOUNT_SECRET answers 503 and writes nothing,
 * never degrades into an open endpoint.
 *
 * The gate runs BEFORE the DB is touched and before the body is validated, so
 * an unauthenticated caller learns neither whether the database is up nor
 * whether their payload was well-formed.
 *
 * IDEMPOTENT, AND THAT IS A CONTRACT, NOT A DETAIL. The companion retries, and
 * a retry re-posts the same (puuid, observedAt). The insert is ON CONFLICT DO
 * NOTHING, so a duplicate is 200 `{ok:true, stored:false}` — a SUCCESS, because
 * the reading for that instant is on record. `stored` is reported additively so
 * the desktop half can tell a fresh capture from a replay in its own log; it is
 * not an error signal and must never be treated as one.
 *
 * ONE RESPONSE SHAPE FOR EVERY OUTCOME. Every failure answers
 * `{ok:false, reason}` rather than the `{error}` shape the accounts route uses,
 * because this endpoint's only client is the companion, which fails silently by
 * design (spec §5) and needs exactly one field to branch on. Status codes still
 * carry the usual meaning: 400 the request is wrong and a retry will not help,
 * 401/503 configuration, 500 the server failed and a retry is worth making.
 *
 * `now` COMES FROM THE SERVER. parseRankSampleBody takes the clock as an
 * argument; passing a client-supplied value would let a caller date a reading
 * past the future bound and park a permanent closing bracket in the table (see
 * lib/mystats/rankSample.ts's header).
 */
export async function POST(req: NextRequest) {
  const auth = checkAccountSecret(process.env.MYSTATS_ACCOUNT_SECRET, req.headers.get(ACCOUNT_SECRET_HEADER));
  if (!auth.ok) {
    return auth.reason === "not-configured"
      ? json({ ok: false, reason: "not-configured", detail: "MYSTATS_ACCOUNT_SECRET is not set on the server" }, 503)
      : json({ ok: false, reason: "unauthorized" }, 401);
  }

  const sql = getSql();
  if (!sql) return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);

  const raw = await req.json().catch(() => null);
  const parsed = parseRankSampleBody(raw, Date.now());
  if (isRankSampleError(parsed)) return json({ ok: false, reason: "invalid-body", detail: parsed.error }, 400);

  try {
    let sample: RankSampleWrite;
    if ("puuid" in parsed) {
      // Cron/page sources already hold Riot's encrypted puuid and stay on the
      // existing zero-resolution path.
      sample = parsed;
    } else {
      // The desktop can only name the logged-in account by Riot ID. Reuse the
      // accounts detect path wholesale: its stored riot_id fast path costs no
      // Riot call, and its miss path owns the paced account-v1/region lookup
      // discipline. Never substitute the LCU's 36-character local UUID.
      const resolved = await linkAccount(sql, { gameName: parsed.gameName, tagLine: parsed.tagLine });
      if (!resolved.ok) {
        const status = resolved.reason === "account-not-found" ? 404 : 502;
        return json({ ok: false, reason: resolved.reason }, status);
      }
      sample = {
        puuid: resolved.account.puuid,
        observedAt: parsed.observedAt,
        tier: parsed.tier,
        division: parsed.division,
        lp: parsed.lp,
        cumulativeLp: parsed.cumulativeLp,
        source: parsed.source,
      };
    }

    const { stored } = await insertRankSample(sql, sample);
    return json({ ok: true, stored }, 200);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return json({ ok: false, reason: "db-unavailable", detail: "DATABASE_URL not configured" }, 503);
    }
    // 500 with ok:false, so a retry is honest — unlike the duplicate path, this
    // one really did not store anything.
    console.error("[/api/mystats/rank-sample POST] Unexpected error:", err);
    return json({ ok: false, reason: "server-error" }, 500);
  }
}
