/**
 * Tests for the My Stats multi-account write path (v0.83, migration 0020):
 * lib/mystats/accountAuth.ts's shared-secret gate, lib/mystats/accountRequest.ts's
 * body validation, and app/api/mystats/accounts/route.ts's two modes.
 *
 * The AUTH tests are the load-bearing ones. This endpoint is publicly reachable
 * (the app has no user auth) and a successful write repoints every My Stats
 * surface at a different account, so "rejects an unauthenticated write" is not a
 * nicety — it is the only thing standing between a stranger and the user's stats.
 * The one failure mode worth being paranoid about is a SOFT fallback: an
 * unconfigured secret must fail CLOSED, because an endpoint that quietly works
 * without a secret is indistinguishable from one that was never protected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetActiveAccount = vi.fn();
const mockListAccounts = vi.fn();
const mockLinkAccount = vi.fn();
const mockSetActiveAccount = vi.fn();
vi.mock("@/lib/mystats/account", () => ({
  getActiveAccount: (...a: unknown[]) => mockGetActiveAccount(...a),
  listAccounts: (...a: unknown[]) => mockListAccounts(...a),
  linkAccount: (...a: unknown[]) => mockLinkAccount(...a),
  setActiveAccount: (...a: unknown[]) => mockSetActiveAccount(...a),
}));

import { GET as accountsGET, POST as accountsPOST } from "@/app/api/mystats/accounts/route";
import { ACCOUNT_SECRET_HEADER, checkAccountSecret } from "@/lib/mystats/accountAuth";
import { parseAccountsBody, isAccountsRequestError } from "@/lib/mystats/accountRequest";

const SECRET = "correct-horse-battery-staple";

const ACCOUNT_A = {
  id: 1,
  puuid: "puuid-a",
  riotId: "MunsterHunter#EUW",
  gameName: "MunsterHunter",
  tagLine: "EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};
const ACCOUNT_B = {
  id: 2,
  puuid: "puuid-b",
  riotId: "K1ayer#swift",
  gameName: "K1ayer",
  tagLine: "swift",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function summary(a: typeof ACCOUNT_A, active: boolean) {
  return {
    id: a.id,
    riotId: a.riotId,
    gameName: a.gameName,
    tagLine: a.tagLine,
    region: a.region,
    active,
    lastSeenAt: null,
    games: 0,
  };
}

function postReq(body: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    url: "http://localhost/api/mystats/accounts",
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Parameters<typeof accountsPOST>[0];
}

function authed(body: unknown) {
  return postReq(body, { [ACCOUNT_SECRET_HEADER]: SECRET });
}

describe("checkAccountSecret (pure)", () => {
  it("rejects when the server has no secret configured -- FAIL CLOSED, never open", () => {
    expect(checkAccountSecret(undefined, "anything")).toEqual({ ok: false, reason: "not-configured" });
    expect(checkAccountSecret(null, "anything")).toEqual({ ok: false, reason: "not-configured" });
    // The nastiest case: an empty env var plus an empty header must NOT compare
    // equal and authorise everything.
    expect(checkAccountSecret("", "")).toEqual({ ok: false, reason: "not-configured" });
    expect(checkAccountSecret("   ", "   ")).toEqual({ ok: false, reason: "not-configured" });
  });

  it("rejects a missing, wrong, or wrong-length secret", () => {
    expect(checkAccountSecret(SECRET, null)).toEqual({ ok: false, reason: "unauthorized" });
    expect(checkAccountSecret(SECRET, "")).toEqual({ ok: false, reason: "unauthorized" });
    expect(checkAccountSecret(SECRET, "wrong")).toEqual({ ok: false, reason: "unauthorized" });
    // Same length, one byte different -- the case timingSafeEqual is actually for.
    expect(checkAccountSecret(SECRET, SECRET.slice(0, -1) + "X")).toEqual({ ok: false, reason: "unauthorized" });
    // A prefix of the real secret must not pass.
    expect(checkAccountSecret(SECRET, SECRET.slice(0, 5))).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("accepts the exact secret, and tolerates surrounding whitespace in the CONFIGURED value only", () => {
    expect(checkAccountSecret(SECRET, SECRET)).toEqual({ ok: true });
    expect(checkAccountSecret(`  ${SECRET}  `, SECRET)).toEqual({ ok: true });
    // ...but not in what the client sends: a padded client value is a different
    // string and is not silently normalised into a match.
    expect(checkAccountSecret(SECRET, ` ${SECRET} `)).toEqual({ ok: false, reason: "unauthorized" });
  });
});

describe("parseAccountsBody (pure)", () => {
  it("rejects non-objects and unknown modes", () => {
    for (const bad of [null, undefined, 42, "x", [], {}, { mode: "delete" }]) {
      expect(isAccountsRequestError(parseAccountsBody(bad))).toBe(true);
    }
  });

  it("select requires a positive integer id", () => {
    expect(parseAccountsBody({ mode: "select", id: 3 })).toEqual({ mode: "select", id: 3 });
    // A numeric STRING or a float would reach a smallint column and either error
    // or round into a DIFFERENT account's id.
    for (const bad of ["3", 3.5, 0, -1, null, undefined, NaN]) {
      expect(isAccountsRequestError(parseAccountsBody({ mode: "select", id: bad }))).toBe(true);
    }
  });

  it("detect requires all three identity fields", () => {
    const ok = parseAccountsBody({ mode: "detect", gameName: "K1ayer", tagLine: "swift", puuid: "a".repeat(78) });
    expect(ok).toEqual({ mode: "detect", gameName: "K1ayer", tagLine: "swift", puuid: "a".repeat(78) });
    for (const bad of [
      { mode: "detect", tagLine: "swift", puuid: "a".repeat(78) },
      { mode: "detect", gameName: "", tagLine: "swift", puuid: "a".repeat(78) },
      { mode: "detect", gameName: "  ", tagLine: "swift", puuid: "a".repeat(78) },
      { mode: "detect", gameName: "K1ayer", tagLine: "", puuid: "a".repeat(78) },
      { mode: "detect", gameName: "K1ayer", tagLine: "swift" },
      { mode: "detect", gameName: "K1ayer", tagLine: "swift", puuid: "short" },
      { mode: "detect", gameName: 123, tagLine: "swift", puuid: "a".repeat(78) },
    ]) {
      expect(isAccountsRequestError(parseAccountsBody(bad))).toBe(true);
    }
  });

  it("rejects a puuid carrying URL path characters -- it is interpolated into a Riot request path", () => {
    for (const bad of ["../../etc/passwd0000000000", "a".repeat(30) + "/x", "a".repeat(30) + "?q=1", "a".repeat(30) + "#f"]) {
      expect(isAccountsRequestError(parseAccountsBody({ mode: "detect", gameName: "A", tagLine: "B", puuid: bad }))).toBe(true);
    }
  });

  it("accepts a CUSTOM (non-region) tagLine -- the user's own second account is K1ayer#swift", () => {
    expect(parseAccountsBody({ mode: "detect", gameName: "K1ayer", tagLine: "swift", puuid: "b".repeat(78) })).toEqual({
      mode: "detect",
      gameName: "K1ayer",
      tagLine: "swift",
      puuid: "b".repeat(78),
    });
  });
});

describe("POST /api/mystats/accounts -- auth rejection", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
    mockListAccounts.mockReset();
    mockLinkAccount.mockReset();
    mockSetActiveAccount.mockReset();
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
  });

  it("401 with no secret header, and NOTHING is written", async () => {
    const res = await accountsPOST(postReq({ mode: "select", id: 2 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("401 with a wrong secret", async () => {
    const res = await accountsPOST(postReq({ mode: "select", id: 2 }, { [ACCOUNT_SECRET_HEADER]: "nope" }));
    expect(res.status).toBe(401);
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
  });

  it("503 not-configured (never 200) when the server secret is unset -- no open fallback", async () => {
    delete process.env.MYSTATS_ACCOUNT_SECRET;
    const res = await accountsPOST(postReq({ mode: "select", id: 2 }, { [ACCOUNT_SECRET_HEADER]: "anything" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("not-configured");
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
  });

  it("auth is checked BEFORE the body is validated -- an unauthenticated caller learns nothing about the contract", async () => {
    const res = await accountsPOST(postReq({ mode: "garbage" }));
    expect(res.status).toBe(401); // NOT 400
  });

  it("an INVALID body from an AUTHENTICATED caller 400s and still writes nothing", async () => {
    const res = await accountsPOST(authed({ mode: "select", id: "2" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-body");
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
  });
});

describe("POST /api/mystats/accounts -- select mode", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
    mockListAccounts.mockReset();
    mockLinkAccount.mockReset();
    mockSetActiveAccount.mockReset();
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
  });

  it("switches the active account and reports switched:true", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A); // before
    mockSetActiveAccount.mockResolvedValueOnce(ACCOUNT_B);
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_B, true), summary(ACCOUNT_A, false)]);

    const res = await accountsPOST(authed({ mode: "select", id: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeId).toBe(2);
    expect(body.riotId).toBe("K1ayer#swift");
    expect(body.switched).toBe(true);
    expect(body.created).toBe(false);
    // NEVER spends a Riot call: the account is already linked, region already stored.
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it("re-selecting the ALREADY-active account reports switched:false (so the client skips a needless refetch)", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockSetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_A, true)]);
    const body = await (await accountsPOST(authed({ mode: "select", id: 1 }))).json();
    expect(body.switched).toBe(false);
  });

  it("404 for an id that matches no row -- never a silent no-op that looks like success", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockSetActiveAccount.mockResolvedValueOnce(null);
    const res = await accountsPOST(authed({ mode: "select", id: 99 }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no-such-account");
  });

  it("never exposes a puuid in the response", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockSetActiveAccount.mockResolvedValueOnce(ACCOUNT_B);
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_B, true), summary(ACCOUNT_A, false)]);
    const raw = JSON.stringify(await (await accountsPOST(authed({ mode: "select", id: 2 }))).json());
    expect(raw).not.toContain("puuid");
    expect(raw).not.toContain(ACCOUNT_B.puuid);
  });
});

describe("POST /api/mystats/accounts -- detect mode", () => {
  const IDENTITY = { mode: "detect", gameName: "K1ayer", tagLine: "swift", puuid: "c".repeat(78) };

  beforeEach(() => {
    mockSql.mockReset();
    mockGetActiveAccount.mockReset();
    mockListAccounts.mockReset();
    mockLinkAccount.mockReset();
    mockSetActiveAccount.mockReset();
    process.env.MYSTATS_ACCOUNT_SECRET = SECRET;
  });

  it("links a newly detected account, activates it, and reports created+switched", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockLinkAccount.mockResolvedValueOnce({ ok: true, account: ACCOUNT_B, created: true });
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_B, true), summary(ACCOUNT_A, false)]);

    const res = await accountsPOST(authed(IDENTITY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.switched).toBe(true);
    expect(body.activeId).toBe(2);
    expect(mockLinkAccount).toHaveBeenCalledWith(mockSql, {
      gameName: "K1ayer",
      tagLine: "swift",
      puuid: "c".repeat(78),
    });
  });

  it("re-detecting the account that is ALREADY active reports switched:false and created:false", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockLinkAccount.mockResolvedValueOnce({ ok: true, account: ACCOUNT_A, created: false });
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_A, true)]);
    const body = await (
      await accountsPOST(authed({ mode: "detect", gameName: "MunsterHunter", tagLine: "EUW", puuid: "d".repeat(78) }))
    ).json();
    expect(body.switched).toBe(false);
    expect(body.created).toBe(false);
  });

  it("502 (not 500) when the region cannot be resolved -- upstream failed, nothing was written, retry is safe", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockLinkAccount.mockResolvedValueOnce({ ok: false, reason: "region-unresolved" });
    const res = await accountsPOST(authed(IDENTITY));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("region-unresolved");
  });

  it("502 when Riot is unavailable", async () => {
    mockGetActiveAccount.mockResolvedValueOnce(ACCOUNT_A);
    mockLinkAccount.mockResolvedValueOnce({ ok: false, reason: "riot-unavailable" });
    const res = await accountsPOST(authed(IDENTITY));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("riot-unavailable");
  });
});

describe("GET /api/mystats/accounts", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockListAccounts.mockReset();
  });

  it("lists accounts with the active one identified, no-store, and no puuid", async () => {
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_B, true), summary(ACCOUNT_A, false)]);
    const res = await accountsGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.activeId).toBe(2);
    expect(body.accounts).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("puuid");
  });

  it("activeId is null when no account is active", async () => {
    mockListAccounts.mockResolvedValueOnce([summary(ACCOUNT_A, false)]);
    const body = await (await accountsGET()).json();
    expect(body.activeId).toBeNull();
  });
});
