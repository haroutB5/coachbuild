import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockLinkAccount = vi.fn();
vi.mock("@/lib/mystats/account", () => ({
  linkAccount: (...args: unknown[]) => mockLinkAccount(...args),
}));

import { GET as diagnosticsGET, POST as diagnosticsPOST } from "@/app/api/mystats/diagnostics/route";
import { ACCOUNT_SECRET_HEADER } from "@/lib/mystats/accountAuth";
import {
  DIAGNOSTICS_BODY_MAX_BYTES,
  DIAGNOSTICS_KEEP_COUNT,
  DIAGNOSTICS_SOURCE,
  getDiagnostics,
  insertDiagnostics,
  isDiagnosticsError,
  parseDiagnosticsBody,
  parseDiagnosticsOrdinal,
} from "@/lib/mystats/diagnostics";
import { getSql } from "@/lib/pro/db";

const SECRET = "correct-horse-battery-staple";
const RESOLVED_PUUID = "riot-encrypted-puuid-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const UPLOADED_AT = "2026-08-21T12:34:56.000Z";
const LOG_BODY = "CoachBuild diagnostics\nline two\n";

function body(over: Record<string, unknown> = {}) {
  return {
    gameName: "K1ayer",
    tagLine: "swift",
    body: LOG_BODY,
    source: DIAGNOSTICS_SOURCE,
    ...over,
  };
}

function requestHeaders(values: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (key: string) => lower[key.toLowerCase()] ?? null };
}

function postReq(payload: unknown, headers: Record<string, string> = {}) {
  return {
    url: "http://localhost/api/mystats/diagnostics",
    headers: requestHeaders(headers),
    json: async () => payload,
  } as unknown as Parameters<typeof diagnosticsPOST>[0];
}

function getReq(query: string, headers: Record<string, string> = {}) {
  return {
    url: `http://localhost/api/mystats/diagnostics?${query}`,
    headers: requestHeaders(headers),
  } as unknown as Parameters<typeof diagnosticsGET>[0];
}

function authedPost(payload: unknown) {
  return postReq(payload, { [ACCOUNT_SECRET_HEADER]: SECRET });
}

function authedGet(query = "gameName=K1ayer&tagLine=swift") {
  return getReq(query, { [ACCOUNT_SECRET_HEADER]: SECRET });
}

interface Statement {
  text: string;
  values: unknown[];
}

function recordingSql(collected: Statement[], rows: unknown[]) {
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    collected.push({ text: strings.join("|"), values });
    return Promise.resolve(rows);
  });
}

describe("migration 0028", () => {
  const migration = readFileSync(new URL("../../migrations/0028_mystats_diagnostics.sql", import.meta.url), "utf8");

  it("creates the diagnostics table with the fixed columns and descending account index", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS coachbuild.my_diagnostics");
    expect(migration).toMatch(/puuid\s+text\s+NOT NULL/i);
    expect(migration).toMatch(/uploaded_at\s+timestamptz\s+NOT NULL/i);
    expect(migration).toMatch(/body\s+text\s+NOT NULL/i);
    expect(migration).toMatch(/source\s+text\s+NOT NULL/i);
    expect(migration).toMatch(/\(puuid, uploaded_at DESC\)/i);
    expect(migration).toContain("RETENTION SHIPS WITH THE TABLE");
  });
});

describe("diagnostics request validation", () => {
  it("accepts the fixed request shape, trims Riot ID fields, and ignores a caller puuid", () => {
    const parsed = parseDiagnosticsBody(
      body({
        gameName: "  K1ayer  ",
        tagLine: "  swift  ",
        puuid: "550e8400-e29b-41d4-a716-446655440000",
      })
    );
    expect(parsed).toEqual({ gameName: "K1ayer", tagLine: "swift", body: LOG_BODY, source: "companion" });
    expect(parsed).not.toHaveProperty("puuid");
  });

  it("accepts exactly 256 KiB but rejects one byte more with a clear reason", () => {
    const atLimit = parseDiagnosticsBody(body({ body: "x".repeat(DIAGNOSTICS_BODY_MAX_BYTES) }));
    expect(isDiagnosticsError(atLimit)).toBe(false);

    const tooLarge = parseDiagnosticsBody(body({ body: "x".repeat(DIAGNOSTICS_BODY_MAX_BYTES + 1) }));
    expect(isDiagnosticsError(tooLarge)).toBe(true);
    expect((tooLarge as { error: string }).error).toContain(`${DIAGNOSTICS_BODY_MAX_BYTES} UTF-8 bytes`);
  });

  it("measures the cap in UTF-8 bytes, not JavaScript string length", () => {
    const twoByteCharacters = "\u00e9".repeat(DIAGNOSTICS_BODY_MAX_BYTES / 2 + 1);
    const parsed = parseDiagnosticsBody(body({ body: twoByteCharacters }));
    expect(isDiagnosticsError(parsed)).toBe(true);
  });

  it("requires the companion source", () => {
    const parsed = parseDiagnosticsBody(body({ source: "desktop" }));
    expect(parsed).toEqual({ error: 'source must be "companion"' });
  });

  it("requires gameName and tagLine even when a plausible-looking puuid is supplied", () => {
    const parsed = parseDiagnosticsBody({
      puuid: RESOLVED_PUUID,
      body: LOG_BODY,
      source: DIAGNOSTICS_SOURCE,
    });
    expect(isDiagnosticsError(parsed)).toBe(true);
  });

  it("parses n as a one-based retained-upload ordinal", () => {
    expect(parseDiagnosticsOrdinal(null)).toBe(1);
    expect(parseDiagnosticsOrdinal("1")).toBe(1);
    expect(parseDiagnosticsOrdinal("5")).toBe(5);
    expect(isDiagnosticsError(parseDiagnosticsOrdinal("0"))).toBe(true);
    expect(isDiagnosticsError(parseDiagnosticsOrdinal("6"))).toBe(true);
    expect(isDiagnosticsError(parseDiagnosticsOrdinal("1.5"))).toBe(true);
  });
});

describe("diagnostics SQL", () => {
  it("inserts and prunes to five in one data-modifying-CTE statement", async () => {
    const collected: Statement[] = [];
    const sql = recordingSql(collected, [{ uploaded_at: UPLOADED_AT, pruned: 2 }]);

    await expect(
      insertDiagnostics(sql as never, {
        puuid: RESOLVED_PUUID,
        body: LOG_BODY,
        source: DIAGNOSTICS_SOURCE,
      })
    ).resolves.toEqual({ uploadedAt: UPLOADED_AT, pruned: 2 });

    expect(collected).toHaveLength(1);
    const [statement] = collected;
    expect(statement.text).toContain("WITH inserted AS");
    expect(statement.text).toContain("INSERT INTO coachbuild.my_diagnostics");
    expect(statement.text).toContain("UNION ALL");
    expect(statement.text).toContain("FROM inserted");
    expect(statement.text).toContain("DELETE FROM coachbuild.my_diagnostics");
    expect(statement.text).toContain("ORDER BY uploaded_at DESC");
    expect(statement.values).toEqual(
      expect.arrayContaining([RESOLVED_PUUID, LOG_BODY, DIAGNOSTICS_SOURCE, DIAGNOSTICS_KEEP_COUNT])
    );
  });

  it("reads the requested Nth upload with a bound zero-based offset", async () => {
    const collected: Statement[] = [];
    const sql = recordingSql(collected, [{ body: LOG_BODY, source: DIAGNOSTICS_SOURCE, uploaded_at: UPLOADED_AT }]);

    await expect(getDiagnostics(sql as never, RESOLVED_PUUID, 3)).resolves.toEqual({
      body: LOG_BODY,
      source: DIAGNOSTICS_SOURCE,
      uploadedAt: UPLOADED_AT,
    });
    expect(collected).toHaveLength(1);
    expect(collected[0].text).toContain("ORDER BY uploaded_at DESC");
    expect(collected[0].values).toEqual(expect.arrayContaining([RESOLVED_PUUID, 2]));
  });
});

describe("POST /api/mystats/diagnostics", () => {
  const realSecret = process.env.MYSTATS_ACCOUNT_SECRET;

  beforeEach(() => {
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
    mockLinkAccount.mockReset();
    mockLinkAccount.mockResolvedValue({ ok: true, account: { puuid: RESOLVED_PUUID }, created: false });
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ uploaded_at: UPLOADED_AT, pruned: 0 }]);
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  afterEach(() => {
    if (realSecret === undefined) delete process.env.MYSTATS_ACCOUNT_SECRET;
    else process.env.MYSTATS_ACCOUNT_SECRET = realSecret;
  });

  it("resolves the Riot ID and stores only the returned encrypted puuid", async () => {
    const response = await diagnosticsPOST(authedPost(body()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockLinkAccount).toHaveBeenCalledWith(mockSql, { gameName: "K1ayer", tagLine: "swift" });
    expect(mockSql).toHaveBeenCalledTimes(1);
    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain(RESOLVED_PUUID);
    expect(values).not.toContain("K1ayer");
  });

  it("rejects an oversized body before identity resolution or SQL", async () => {
    const response = await diagnosticsPOST(
      authedPost(body({ body: "x".repeat(DIAGNOSTICS_BODY_MAX_BYTES + 1) }))
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: "invalid-body",
      detail: expect.stringContaining("UTF-8 bytes"),
    });
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable identity and stores nothing", async () => {
    mockLinkAccount.mockResolvedValueOnce({ ok: false, reason: "account-not-found" });
    const response = await diagnosticsPOST(authedPost(body()));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "account-not-found" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("never falls back to a caller-supplied puuid", async () => {
    const response = await diagnosticsPOST(
      authedPost({ puuid: RESOLVED_PUUID, body: LOG_BODY, source: DIAGNOSTICS_SOURCE })
    );
    expect(response.status).toBe(400);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a missing request secret before reading the body", async () => {
    const json = vi.fn(async () => body());
    const request = {
      url: "http://localhost/api/mystats/diagnostics",
      headers: requestHeaders({}),
      json,
    } as unknown as Parameters<typeof diagnosticsPOST>[0];
    const response = await diagnosticsPOST(request);
    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a wrong request secret", async () => {
    const response = await diagnosticsPOST(
      postReq(body(), { [ACCOUNT_SECRET_HEADER]: "wrong-secret-entirely" })
    );
    expect(response.status).toBe(401);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("fails closed when the server secret is not configured", async () => {
    delete process.env.MYSTATS_ACCOUNT_SECRET;
    const response = await diagnosticsPOST(authedPost(body()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("GET /api/mystats/diagnostics", () => {
  const realSecret = process.env.MYSTATS_ACCOUNT_SECRET;

  beforeEach(() => {
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
    mockLinkAccount.mockReset();
    mockLinkAccount.mockResolvedValue({ ok: true, account: { puuid: RESOLVED_PUUID }, created: false });
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ body: LOG_BODY, source: DIAGNOSTICS_SOURCE, uploaded_at: UPLOADED_AT }]);
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  afterEach(() => {
    if (realSecret === undefined) delete process.env.MYSTATS_ACCOUNT_SECRET;
    else process.env.MYSTATS_ACCOUNT_SECRET = realSecret;
  });

  it("returns the latest resolved account upload as exact plain text", async () => {
    const response = await diagnosticsGET(authedGet());
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(LOG_BODY);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockLinkAccount).toHaveBeenCalledWith(mockSql, { gameName: "K1ayer", tagLine: "swift" });
    expect(mockSql.mock.calls[0].slice(1)).toEqual(expect.arrayContaining([RESOLVED_PUUID, 0]));
  });

  it("uses n as a one-based offset", async () => {
    const response = await diagnosticsGET(authedGet("gameName=K1ayer&tagLine=swift&n=3"));
    expect(response.status).toBe(200);
    expect(mockSql.mock.calls[0].slice(1)).toEqual(expect.arrayContaining([RESOLVED_PUUID, 2]));
  });

  it("rejects an invalid n without resolving or reading", async () => {
    const response = await diagnosticsGET(authedGet("gameName=K1ayer&tagLine=swift&n=0"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "invalid-n" });
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable identity and reads no diagnostics", async () => {
    mockLinkAccount.mockResolvedValueOnce({ ok: false, reason: "account-not-found" });
    const response = await diagnosticsGET(authedGet());
    expect(response.status).toBe(404);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 404 when that retained ordinal does not exist", async () => {
    mockSql.mockResolvedValueOnce([]);
    const response = await diagnosticsGET(authedGet("gameName=K1ayer&tagLine=swift&n=5"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects a missing request secret before parsing identity", async () => {
    const response = await diagnosticsGET(getReq("gameName=K1ayer&tagLine=swift"));
    expect(response.status).toBe(401);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a wrong request secret", async () => {
    const response = await diagnosticsGET(
      getReq("gameName=K1ayer&tagLine=swift", { [ACCOUNT_SECRET_HEADER]: "wrong-secret-entirely" })
    );
    expect(response.status).toBe(401);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("fails closed when the server secret is not configured", async () => {
    delete process.env.MYSTATS_ACCOUNT_SECRET;
    const response = await diagnosticsGET(authedGet());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
});
