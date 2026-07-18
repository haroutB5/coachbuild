/**
 * Tests for lib/pro/puuidResolve.ts — the PUUID fallback resolution chain:
 * try lolpros' encrypted_puuid against our Riot key first, fall back to
 * account-v1/by-riot-id on failure, degrade gracefully without a key.
 * lib/pro/riot.ts is mocked — no network.
 *
 * P3(d) regression coverage (2026-07-17 Fable review): a TRANSIENT failure
 * (network throw, 5xx, 429) on either attempt must never downgrade an
 * account to `active: false` — only a DEFINITIVE Riot rejection (4xx,
 * not 429) may. RiotRequestError needs an ACTUAL instance with a `.status`
 * for these tests (a plain Error is always treated as transient — it means
 * the fetch itself threw before Riot even responded).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../pro/riot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pro/riot")>();
  return { ...actual, getAccountByRiotId: vi.fn(), getMatchIdsByPuuid: vi.fn() };
});

import { getAccountByRiotId, getMatchIdsByPuuid, RiotRequestError } from "../pro/riot";
import { resolveAccount } from "../pro/puuidResolve";
import type { LolProsAccountRaw } from "../pro/types";

const ORIGINAL_KEY = process.env.RIOT_API_KEY;

function account(overrides: Partial<LolProsAccountRaw> = {}): LolProsAccountRaw {
  return {
    server: "EUW",
    encrypted_puuid: "lolpros-puuid-1",
    gamename: "SomePro",
    tagline: "EUW1",
    summoner_name: "SomePro#EUW1",
    ...overrides,
  };
}

describe("resolveAccount", () => {
  beforeEach(() => {
    vi.mocked(getAccountByRiotId).mockReset();
    vi.mocked(getMatchIdsByPuuid).mockReset();
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RIOT_API_KEY;
    else process.env.RIOT_API_KEY = ORIGINAL_KEY;
  });

  it("returns null for an unmapped region", async () => {
    delete process.env.RIOT_API_KEY;
    expect(await resolveAccount(account({ server: "MARS" }))).toBeNull();
  });

  it("returns null when there's neither a puuid nor a riotId to try", async () => {
    delete process.env.RIOT_API_KEY;
    expect(
      await resolveAccount(account({ encrypted_puuid: null, gamename: undefined, tagline: undefined, summoner_name: undefined }))
    ).toBeNull();
  });

  it("without RIOT_API_KEY: stores the lolpros puuid as inactive/unresolved", async () => {
    delete process.env.RIOT_API_KEY;
    const result = await resolveAccount(account());
    expect(result).toEqual({
      puuid: "lolpros-puuid-1",
      riotId: "SomePro#EUW1",
      region: "EUW",
      platform: "euw1",
      regional: "europe",
      active: false,
    });
    expect(getMatchIdsByPuuid).not.toHaveBeenCalled();
  });

  it("without RIOT_API_KEY and no puuid at all: returns null (nothing to store)", async () => {
    delete process.env.RIOT_API_KEY;
    expect(await resolveAccount(account({ encrypted_puuid: null }))).toBeNull();
  });

  it("with a key: uses the lolpros puuid directly when the probe succeeds", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockResolvedValueOnce(["EUW1_1"]);
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "lolpros-puuid-1", active: true });
    expect(getAccountByRiotId).not.toHaveBeenCalled();
  });

  it("with a key: falls back to account-v1/by-riot-id when the puuid probe 400/404s", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"));
    vi.mocked(getAccountByRiotId).mockResolvedValueOnce({
      puuid: "our-key-puuid-2",
      gameName: "SomePro",
      tagLine: "EUW1",
    });
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "our-key-puuid-2", active: true, riotId: "SomePro#EUW1" });
    expect(getAccountByRiotId).toHaveBeenCalledWith("europe", "SomePro", "EUW1");
  });

  it("with a key: marks unresolved (inactive) when both the probe and the fallback DEFINITIVELY fail (clean 4xx, not 429)", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new RiotRequestError("url", 400, "Bad Request"));
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "lolpros-puuid-1", active: false });
  });

  it("P3(d) fix: a TRANSIENT failure (plain network throw) on the puuid probe never downgrades to active:false — returns null (skip this pass) instead, even when the fallback also definitively fails", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"));
    const result = await resolveAccount(account());
    expect(result).toBeNull();
  });

  it("P3(d) fix: a Riot 503 on the puuid probe is transient — null, not active:false", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new RiotRequestError("url", 503, "Service Unavailable"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"));
    const result = await resolveAccount(account());
    expect(result).toBeNull();
  });

  it("P3(d) fix: a Riot 429 (rate limit) on the puuid probe is transient — null, not active:false", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new RiotRequestError("url", 429, "Too Many Requests"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"));
    const result = await resolveAccount(account());
    expect(result).toBeNull();
  });

  it("P3(d) fix: a transient failure on the FALLBACK call also blocks the inactive downgrade, even when the primary probe definitively failed", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new RiotRequestError("url", 400, "Bad Request"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new Error("network hiccup"));
    const result = await resolveAccount(account());
    expect(result).toBeNull();
  });

  it("still resolves active:true when the puuid probe transiently fails but the riotId fallback succeeds (the transient hit is moot once resolved)", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new Error("network hiccup"));
    vi.mocked(getAccountByRiotId).mockResolvedValueOnce({
      puuid: "our-key-puuid-recovered",
      gameName: "SomePro",
      tagLine: "EUW1",
    });
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "our-key-puuid-recovered", active: true });
  });

  it("with a key and no lolpros puuid: resolves straight via riotId fallback", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getAccountByRiotId).mockResolvedValueOnce({
      puuid: "our-key-puuid-3",
      gameName: "SomePro",
      tagLine: "EUW1",
    });
    const result = await resolveAccount(account({ encrypted_puuid: null }));
    expect(getMatchIdsByPuuid).not.toHaveBeenCalled();
    expect(result).toMatchObject({ puuid: "our-key-puuid-3", active: true });
  });
});
