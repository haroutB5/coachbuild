/**
 * Tests for lib/pro/regionMap.ts's routingForPlatform -- the reverse lookup that
 * turns Riot's account-v1 answer ("euw1") into this app's own server key ("EUW")
 * plus its match-v5 routing.
 *
 * WHY THIS FUNCTION EXISTS AT ALL, restated because the test is otherwise easy
 * to read as trivia: the League client tells the companion WHO is logged in but
 * not WHERE they play, and match-v5 is routed by regional cluster. A tagLine
 * cannot supply it -- the user's own second account is "K1ayer#swift", and
 * routingForServer("swift") is null. So the region comes from Riot's own
 * region-by-puuid endpoint, which answers with a platform id, and this converts
 * it. The first test below is the one that makes the whole design necessary.
 */
import { describe, it, expect } from "vitest";
import { routingForPlatform, routingForServer } from "@/lib/pro/regionMap";

describe("routingForServer -- the failure that motivates routingForPlatform", () => {
  it("a CUSTOM tagLine is not a region and must not resolve to one", () => {
    expect(routingForServer("swift")).toBeNull();
    expect(routingForServer("gg")).toBeNull();
    expect(routingForServer("1234")).toBeNull();
  });
});

describe("routingForPlatform", () => {
  it("maps the live-verified answer for this user's account", () => {
    // Verified live 2026-07-29: account-v1 region/by-game/lol/by-puuid returned
    // {"game":"lol","region":"euw1"} for the stored MunsterHunter puuid.
    expect(routingForPlatform("euw1")).toEqual({ server: "EUW", routing: { platform: "euw1", regional: "europe" } });
  });

  it("maps one platform per regional cluster", () => {
    expect(routingForPlatform("na1")?.routing.regional).toBe("americas");
    expect(routingForPlatform("kr")?.routing.regional).toBe("asia");
    expect(routingForPlatform("vn2")?.routing.regional).toBe("sea");
    expect(routingForPlatform("eun1")?.server).toBe("EUNE");
    // OCE routes under americas (moved 2023) -- pinned so a "fix" doesn't move it back.
    expect(routingForPlatform("oc1")?.routing.regional).toBe("americas");
  });

  it("is case-insensitive on input", () => {
    expect(routingForPlatform("EUW1")?.server).toBe("EUW");
    expect(routingForPlatform("Kr")?.server).toBe("KR");
  });

  it("null (never a guess) for an unmapped or empty platform", () => {
    for (const bad of ["zz9", "euw", "europe", "", null, undefined]) {
      expect(routingForPlatform(bad)).toBeNull();
    }
  });

  it("round-trips with routingForServer for every mapped platform", () => {
    // Both directions read the same table, so this pins that they cannot drift
    // -- the reason routingForPlatform derives its answer instead of declaring a
    // second literal map.
    for (const platform of ["euw1", "eun1", "tr1", "ru", "na1", "br1", "la1", "la2", "oc1", "kr", "jp1", "vn2", "ph2", "sg2", "th2", "tw2"]) {
      const byPlatform = routingForPlatform(platform);
      expect(byPlatform, `platform ${platform} did not map`).not.toBeNull();
      expect(routingForServer(byPlatform!.server)).toEqual(byPlatform!.routing);
    }
  });
});
