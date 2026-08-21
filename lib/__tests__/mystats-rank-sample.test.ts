/**
 * POST /api/mystats/rank-sample — the LP capture write path (spec §4,
 * migration 0027).
 *
 * ── WHY THIS FILE IS MOSTLY ABOUT REFUSING THINGS ───────────────────────────
 *
 * This endpoint is publicly reachable — the app has no user auth, and the
 * companion posts from the user's own machine over the open internet (see
 * lib/mystats/accountAuth.ts's header for why that is unavoidable). It writes
 * to the ONLY table that decides whether an LP figure is `exact` or a dash, so
 * every accepted row is a claim about the user's rank at an instant. A stranger
 * who can insert two readings can make a losing session render as +90.
 *
 * So the gate is asserted the same way its sibling is: no secret configured
 * must FAIL CLOSED, never degrade into an open endpoint.
 *
 * ── IDEMPOTENCY IS A REQUIREMENT, NOT A NICETY ──────────────────────────────
 *
 * The companion captures at app start, champ select and game end, and it
 * retries. A retry re-posts the SAME (puuid, observed_at). Spec §4: "Idempotent
 * on (puuid, observed_at). Never 500s on a duplicate." A 500 there would make
 * the companion's silent-failure discipline look like a broken server in the
 * Vercel runtime log, and — worse — a companion that treats 5xx as "retry
 * harder" would hammer the endpoint forever.
 *
 * ── AND ONE THING THAT IS EASY TO GET WRONG ─────────────────────────────────
 *
 * The prune ships in the SAME STATEMENT as the insert (migration 0027's
 * retention note). A test below asserts the driver is called EXACTLY ONCE per
 * write — a prune moved into a second round trip would still pass every
 * behavioural assertion while doubling this endpoint's Neon compute, which is
 * the exact cost that exhausted the quota on 2026-08-20.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

import { POST as rankSamplePOST } from "@/app/api/mystats/rank-sample/route";
import { ACCOUNT_SECRET_HEADER } from "@/lib/mystats/accountAuth";
import {
  RANK_SAMPLE_SOURCES,
  RANK_SAMPLE_FUTURE_SKEW_MS,
  RANK_SAMPLE_PRUNE_LIMIT,
  parseRankSampleBody,
  isRankSampleError,
  insertRankSample,
} from "@/lib/mystats/rankSample";
import { RETENTION_DAYS } from "@/lib/retention/prune";
import { ladderPoints } from "@/lib/mystats/ladder";

const SECRET = "correct-horse-battery-staple";
const PUUID = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFGHIJ";
const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const OBSERVED = "2026-08-21T11:59:00.000Z";

function body(over: Record<string, unknown> = {}) {
  return { puuid: PUUID, tier: "PLATINUM", division: "IV", lp: 42, observedAt: OBSERVED, source: "companion", ...over };
}

function postReq(payload: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    url: "http://localhost/api/mystats/rank-sample",
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => payload,
  } as unknown as Parameters<typeof rankSamplePOST>[0];
}

function authed(payload: unknown) {
  return postReq(payload, { [ACCOUNT_SECRET_HEADER]: SECRET });
}

interface Statement {
  text: string;
  values: unknown[];
}

function recordingSql(collected: Statement[], rows: unknown[] = [{ stored: 1, pruned: 0 }]) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    collected.push({ text: strings.join("|"), values });
    return Promise.resolve(rows);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// parseRankSampleBody — PURE. No DB, and no clock of its own (the caller passes
// `now`), so every window rule below is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseRankSampleBody — the shape of an acceptable reading", () => {
  it("accepts the spec's request body and normalises it", () => {
    const parsed = parseRankSampleBody(body(), NOW);
    expect(parsed).toEqual({
      puuid: PUUID,
      observedAt: OBSERVED,
      tier: "PLATINUM",
      division: "IV",
      lp: 42,
      source: "companion",
    });
  });

  it("upper-cases tier and division, so one rank is not stored two ways", () => {
    const parsed = parseRankSampleBody(body({ tier: " platinum ", division: "iv" }), NOW);
    expect(parsed).toMatchObject({ tier: "PLATINUM", division: "IV" });
  });

  it("normalises observedAt to UTC ISO, so two spellings of ONE instant share a key", () => {
    // The idempotency guarantee is a primary key on (puuid, observed_at). A
    // companion that sends "+02:00" today and "Z" tomorrow for the same instant
    // must not produce two rows — and, more to the point, must not produce a
    // SECOND reading that then brackets a session on its own.
    const a = parseRankSampleBody(body({ observedAt: "2026-08-21T13:59:00.000+02:00" }), NOW);
    const b = parseRankSampleBody(body({ observedAt: "2026-08-21T11:59:00Z" }), NOW);
    expect(isRankSampleError(a)).toBe(false);
    expect(isRankSampleError(b)).toBe(false);
    expect((a as { observedAt: string }).observedAt).toBe(OBSERVED);
    expect((b as { observedAt: string }).observedAt).toBe(OBSERVED);
  });

  it("accepts an UNRANKED reading — all three rank fields null together", () => {
    // A successful read of an unranked account is a real observation and is
    // stored (migration 0022's convention, kept by 0027). ladder.ts refuses to
    // place it, so it is skipped when bracketing rather than scored as 0 LP.
    const parsed = parseRankSampleBody(body({ tier: null, division: null, lp: null }), NOW);
    expect(parsed).toEqual({
      puuid: PUUID,
      observedAt: OBSERVED,
      tier: null,
      division: null,
      lp: null,
      source: "companion",
    });
    expect(ladderPoints(parsed as { tier: null; division: null; lp: null })).toBeNull();
  });

  it("accepts an apex reading with no division", () => {
    const parsed = parseRankSampleBody(body({ tier: "MASTER", division: null, lp: 312 }), NOW);
    expect(parsed).toMatchObject({ tier: "MASTER", division: null, lp: 312 });
  });

  it("accepts a tier this build's ladder does not know, rather than losing the reading", () => {
    // DELIBERATE. The boundary enforces COHERENCE, not vocabulary: if Riot adds
    // a tier, refusing it here would silently kill capture (the companion fails
    // silently by design, spec §5) and the reading would be gone forever.
    // Stored, it renders a dash today — ladder.ts fails closed on an unknown
    // tier — and becomes usable the moment ladder.ts learns the name.
    const parsed = parseRankSampleBody(body({ tier: "MITHRIL", division: "II", lp: 10 }), NOW);
    expect(isRankSampleError(parsed)).toBe(false);
    expect(parsed).toMatchObject({ tier: "MITHRIL" });
    expect(ladderPoints(parsed as never)).toBeNull(); // unusable, but not lost
  });
});

describe("parseRankSampleBody — what it refuses", () => {
  const bad: [string, unknown][] = [
    ["a non-object body", "nope"],
    ["null", null],
    ["an array", []],
    ["a missing puuid", body({ puuid: undefined })],
    ["a puuid with a path separator in it", body({ puuid: "aaaaaaaaaaaaaaaaaaaa/../etc" })],
    ["a too-short puuid", body({ puuid: "short" })],
    ["a missing source", body({ source: undefined })],
    ["a source outside the allowlist", body({ source: "desktop" })],
    ["a missing observedAt", body({ observedAt: undefined })],
    ["an unparseable observedAt", body({ observedAt: "yesterday" })],
    ["an epoch NUMBER for observedAt", body({ observedAt: 1755000000 })],
    ["a fractional lp", body({ lp: 42.5 })],
    ["a negative lp", body({ lp: -1 })],
    ["a string lp", body({ lp: "42" })],
    ["a ranked reading with NO lp", body({ lp: null })],
    ["lp without a tier", body({ tier: null, division: null })],
    ["a division without a tier", body({ tier: null, lp: null })],
  ];

  for (const [label, input] of bad) {
    it("refuses " + label, () => {
      const parsed = parseRankSampleBody(input, NOW);
      expect(isRankSampleError(parsed), label + " was ACCEPTED").toBe(true);
      expect((parsed as { error: string }).error.length).toBeGreaterThan(0);
    });
  }

  it("refuses an unrecognised source rather than storing a value nobody can interpret", () => {
    for (const s of RANK_SAMPLE_SOURCES) {
      expect(isRankSampleError(parseRankSampleBody(body({ source: s }), NOW))).toBe(false);
    }
    expect(isRankSampleError(parseRankSampleBody(body({ source: "COMPANION" }), NOW))).toBe(true);
  });
});

describe("parseRankSampleBody — the observed_at window", () => {
  it("refuses a reading from the future beyond the allowed clock skew", () => {
    // A far-future reading is POISON, not noise: it sorts to the top of the
    // (puuid, observed_at DESC) index and becomes the closing bracket of every
    // session from now until that date, silently.
    const justInside = new Date(NOW + RANK_SAMPLE_FUTURE_SKEW_MS - 1000).toISOString();
    const justOutside = new Date(NOW + RANK_SAMPLE_FUTURE_SKEW_MS + 1000).toISOString();
    expect(isRankSampleError(parseRankSampleBody(body({ observedAt: justInside }), NOW))).toBe(false);
    expect(isRankSampleError(parseRankSampleBody(body({ observedAt: justOutside }), NOW))).toBe(true);
    expect(isRankSampleError(parseRankSampleBody(body({ observedAt: "2031-01-01T00:00:00.000Z" }), NOW))).toBe(true);
  });

  it("refuses a reading the prune in the same statement would immediately delete", () => {
    // The write and the retention bound are one decision. Accepting a row older
    // than RETENTION_DAYS would spend a write on a row the DELETE clause beside
    // it removes, and report `ok: true` for a sample that never existed.
    const dayMs = 24 * 60 * 60 * 1000;
    const inside = new Date(NOW - (RETENTION_DAYS - 1) * dayMs).toISOString();
    const outside = new Date(NOW - (RETENTION_DAYS + 1) * dayMs).toISOString();
    expect(isRankSampleError(parseRankSampleBody(body({ observedAt: inside }), NOW))).toBe(false);
    expect(isRankSampleError(parseRankSampleBody(body({ observedAt: outside }), NOW))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// insertRankSample — ONE statement: insert, dedupe, prune.
// ─────────────────────────────────────────────────────────────────────────────

describe("insertRankSample", () => {
  it("writes to my_rank_samples with ON CONFLICT DO NOTHING and prunes in the SAME statement", async () => {
    const collected: Statement[] = [];
    const sql = recordingSql(collected);
    const sample = parseRankSampleBody(body(), NOW) as never;

    await insertRankSample(sql as never, sample);

    // ONE round trip. A prune split into a second statement doubles this
    // endpoint's compute for no behavioural difference — see this file's header.
    expect(collected).toHaveLength(1);
    const [stmt] = collected;
    expect(stmt.text).toContain("coachbuild.my_rank_samples");
    expect(stmt.text).toContain("ON CONFLICT");
    expect(stmt.text).toContain("DO NOTHING");
    expect(stmt.text).toContain("DELETE");
    // Every field of the reading reaches the statement...
    for (const v of [PUUID, OBSERVED, "PLATINUM", "IV", 42, "companion"]) expect(stmt.values).toContain(v);
    // ...and the retention bound is the SHARED constant, not a copy. A prune
    // window that drifted below the read window would delete samples the
    // summary route still reads.
    expect(stmt.values).toContain(RETENTION_DAYS);
    expect(stmt.values).toContain(RANK_SAMPLE_PRUNE_LIMIT);
  });

  it("scopes the prune to the writing account", async () => {
    // An unscoped DELETE here would let one account's capture delete another
    // linked account's history.
    const collected: Statement[] = [];
    await insertRankSample(recordingSql(collected) as never, parseRankSampleBody(body(), NOW) as never);
    const deleteHalf = collected[0].text.slice(collected[0].text.indexOf("DELETE"));
    expect(deleteHalf).toContain("puuid");
  });

  it("reports a duplicate as stored:false — not an error", async () => {
    const dupe = recordingSql([], [{ stored: 0, pruned: 0 }]);
    await expect(insertRankSample(dupe as never, parseRankSampleBody(body(), NOW) as never)).resolves.toEqual({
      stored: false,
      pruned: 0,
    });
  });

  it("survives a driver that returns nothing at all", async () => {
    // A crash on an empty result would 500 a capture that actually succeeded.
    const empty = recordingSql([], []);
    await expect(insertRankSample(empty as never, parseRankSampleBody(body(), NOW) as never)).resolves.toEqual({
      stored: false,
      pruned: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The route.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/mystats/rank-sample", () => {
  const realSecret = process.env.MYSTATS_ACCOUNT_SECRET;

  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockImplementation(() => Promise.resolve([{ stored: 1, pruned: 0 }]));
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    if (realSecret === undefined) delete process.env.MYSTATS_ACCOUNT_SECRET;
    else process.env.MYSTATS_ACCOUNT_SECRET = realSecret;
    vi.useRealTimers();
    const { getSql } = await import("@/lib/pro/db");
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("accepts an authenticated, valid reading", async () => {
    const res = await rankSamplePOST(authed(body()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, stored: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("IDEMPOTENT: a duplicate is 200 ok, never a 500", async () => {
    mockSql.mockImplementation(() => Promise.resolve([{ stored: 0, pruned: 0 }]));
    const res = await rankSamplePOST(authed(body()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, stored: false });
  });

  it("rejects an unauthenticated write, and reads NOTHING before it does", async () => {
    const res = await rankSamplePOST(postReq(body()));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    // The gate runs before the DB is touched and before the body is validated:
    // an unauthenticated caller must not learn whether the DB is up, nor get
    // free validation of a payload.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a WRONG secret", async () => {
    const res = await rankSamplePOST(postReq(body(), { [ACCOUNT_SECRET_HEADER]: "wrong-secret-entirely" }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the server has no secret configured", async () => {
    delete process.env.MYSTATS_ACCOUNT_SECRET;
    const res = await rankSamplePOST(authed(body()));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400s an invalid body, with the reason, and writes nothing", async () => {
    const res = await rankSamplePOST(authed(body({ source: "whatever" })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toBe("invalid-body");
    expect(typeof json.detail).toBe("string");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON at all", async () => {
    const req = {
      url: "http://localhost/api/mystats/rank-sample",
      headers: { get: (k: string) => (k.toLowerCase() === ACCOUNT_SECRET_HEADER ? SECRET : null) },
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Parameters<typeof rankSamplePOST>[0];
    const res = await rankSamplePOST(req);
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("503s when DATABASE_URL is absent, without pretending the write happened", async () => {
    const { getSql } = await import("@/lib/pro/db");
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await rankSamplePOST(authed(body()));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });

  it("500s on an unexpected DB failure — and says ok:false, so a retry is honest", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("connection reset")));
    const res = await rankSamplePOST(authed(body()));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });

  it("uses the SERVER's clock for the window check, not a client-supplied one", async () => {
    // A client that could name "now" could pre-date a reading past the future
    // bound and park a permanent closing bracket in the table.
    const res = await rankSamplePOST(
      authed(body({ observedAt: "2030-01-01T00:00:00.000Z", now: "2030-01-01T00:00:00.000Z" }))
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
