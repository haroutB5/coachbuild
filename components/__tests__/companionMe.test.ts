/**
 * Tests for the browser half of My Stats account detection:
 * companionClient.ts's getMe / parseCompanionIdentity (companion 1.10.0's
 * GET /me) and components/live/mystatsAccount.ts's report path.
 *
 * THE PRE-1.10.0 DEGRADATION IS THE POINT. The companion updates on its own
 * schedule over `irm | iex`, so a browser will routinely be talking to an older
 * companion than the page was built against. An older one has no /me branch and
 * answers 404, and that must be silent -- the user keeps whichever account is
 * already active and sees nothing. This feature only REFINES existing behaviour,
 * so it must never be the reason My Stats shows an error.
 *
 * The all-or-nothing narrowing is the other half: a partial identity would let
 * the client link and activate an account row that is not the user's, quietly
 * repointing every My Stats number.
 */
import { describe, it, expect, vi } from "vitest";
import { getMe, parseCompanionIdentity } from "@/components/live/companionClient";
import {
  shouldReportIdentity,
  ACCOUNT_SECRET_HEADER as CLIENT_SECRET_HEADER,
} from "@/components/live/mystatsAccount";
import { ACCOUNT_SECRET_HEADER as SERVER_SECRET_HEADER } from "@/lib/mystats/accountAuth";

const PORT = 48291 as const;
const SESSION = "sess-token";

/** The real captured SHAPE (_capture/lcu-raw-20260727-192506.jsonl), minus the
 *  fields companion.ps1 deliberately does not forward. The puuid VALUE is
 *  synthetic — it was a 44-character prefix of the user's real one until
 *  2026-07-30, which is more than enough to identify the account. Nothing on
 *  either side of this wire contract asserts a puuid's length or charset
 *  (parseCompanionIdentity checks present/string/non-blank), so a synthetic
 *  value tests exactly as much. Same rule as companion.ps1's $realShape. */
const GOOD = { gameName: "MunsterHunter", tagLine: "EUW", puuid: "SYNTHETIC-PUUID-NOT-A-REAL-ACCOUNT-000000000" };

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("parseCompanionIdentity", () => {
  it("accepts a well-formed identity and trims it", () => {
    expect(parseCompanionIdentity(GOOD)).toEqual(GOOD);
    expect(parseCompanionIdentity({ ...GOOD, gameName: "  MunsterHunter  " })).toEqual(GOOD);
  });

  it("accepts a CUSTOM tagLine unchanged -- 'swift' is not a region and must not be normalised", () => {
    const swift = { gameName: "K1ayer", tagLine: "swift", puuid: "abc123def456" };
    expect(parseCompanionIdentity(swift)).toEqual(swift);
  });

  it("null on the no-client sentinel", () => {
    expect(parseCompanionIdentity({ error: "no-client" })).toBeNull();
  });

  it("null on a PARTIAL identity -- never a half-known account", () => {
    for (const bad of [
      { gameName: "A", tagLine: "B" },
      { gameName: "A", puuid: "p" },
      { tagLine: "B", puuid: "p" },
      { gameName: "", tagLine: "B", puuid: "p" },
      { gameName: "A", tagLine: "  ", puuid: "p" },
      { gameName: "A", tagLine: "B", puuid: "" },
      { gameName: 1, tagLine: "B", puuid: "p" },
    ]) {
      expect(parseCompanionIdentity(bad)).toBeNull();
    }
  });

  it("null on null/non-object input", () => {
    for (const bad of [null, undefined, 42, "x", []]) expect(parseCompanionIdentity(bad)).toBeNull();
  });
});

describe("getMe", () => {
  it("returns the identity on a well-formed 200", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonRes(GOOD);
    });
    expect(await getMe(PORT, SESSION, { fetchImpl: fetchImpl as never })).toEqual(GOOD);
    // Same session/port URL convention as every other bridge call.
    expect(urls[0]).toBe(`http://127.0.0.1:48291/me?session=${SESSION}`);
  });

  it("null on 404 -- a PRE-1.10.0 companion has no /me route, and that must be silent", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: "not-found" }, false, 404));
    expect(await getMe(PORT, SESSION, { fetchImpl: fetchImpl as never })).toBeNull();
  });

  it("null on {error:'no-client'} -- the League client is closed, the normal state most of the day", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: "no-client" }));
    expect(await getMe(PORT, SESSION, { fetchImpl: fetchImpl as never })).toBeNull();
  });

  it("null when the companion is unreachable -- never throws to the caller", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(getMe(PORT, SESSION, { fetchImpl: fetchImpl as never })).resolves.toBeNull();
  });

  it("null on a 200 whose body is not JSON at all", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response
    );
    await expect(getMe(PORT, SESSION, { fetchImpl: fetchImpl as never })).resolves.toBeNull();
  });
});

describe("shouldReportIdentity", () => {
  it("false with no identity -- nothing to report", () => {
    expect(shouldReportIdentity(null, "MunsterHunter#EUW")).toBe(false);
    expect(shouldReportIdentity(null, null)).toBe(false);
  });

  it("true when nothing is active yet", () => {
    expect(shouldReportIdentity(GOOD, null)).toBe(true);
  });

  it("false when the companion agrees with the active account -- avoids a write on every page view", () => {
    expect(shouldReportIdentity(GOOD, "MunsterHunter#EUW")).toBe(false);
  });

  it("true on the reported bug: playing K1ayer#swift while My Stats still shows MunsterHunter", () => {
    const swift = { gameName: "K1ayer", tagLine: "swift", puuid: "p2" };
    expect(shouldReportIdentity(swift, "MunsterHunter#EUW")).toBe(true);
  });

  it("true on a RENAME of the active account, so the stored display tag gets refreshed", () => {
    expect(shouldReportIdentity({ ...GOOD, gameName: "NewName" }, "MunsterHunter#EUW")).toBe(true);
  });
});

describe("secret header constant", () => {
  it("client and server agree on the header name", () => {
    // Duplicated deliberately (accountAuth.ts imports node:crypto and must never
    // reach a client bundle) -- pinned here so the duplication cannot drift into
    // a silent 401 on every write.
    expect(CLIENT_SECRET_HEADER).toBe(SERVER_SECRET_HEADER);
  });
});
