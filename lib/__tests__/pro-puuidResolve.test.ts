/**
 * Tests for lib/pro/puuidResolve.ts — the PUUID fallback resolution chain:
 * try lolpros' encrypted_puuid against our Riot key first, fall back to
 * account-v1/by-riot-id on failure, degrade gracefully without a key.
 * lib/pro/riot.ts is mocked — no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../pro/riot", () => ({
  getAccountByRiotId: vi.fn(),
  getMatchIdsByPuuid: vi.fn(),
}));

import { getAccountByRiotId, getMatchIdsByPuuid } from "../pro/riot";
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
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new Error("riot -> 404"));
    vi.mocked(getAccountByRiotId).mockResolvedValueOnce({
      puuid: "our-key-puuid-2",
      gameName: "SomePro",
      tagLine: "EUW1",
    });
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "our-key-puuid-2", active: true, riotId: "SomePro#EUW1" });
    expect(getAccountByRiotId).toHaveBeenCalledWith("europe", "SomePro", "EUW1");
  });

  it("with a key: marks unresolved (inactive) when both the probe and the fallback fail", async () => {
    process.env.RIOT_API_KEY = "test-key";
    vi.mocked(getMatchIdsByPuuid).mockRejectedValueOnce(new Error("riot -> 404"));
    vi.mocked(getAccountByRiotId).mockRejectedValueOnce(new Error("riot -> 404"));
    const result = await resolveAccount(account());
    expect(result).toMatchObject({ puuid: "lolpros-puuid-1", active: false });
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
