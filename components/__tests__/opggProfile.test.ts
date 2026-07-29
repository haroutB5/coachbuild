import { describe, it, expect } from "vitest";
import { opggRegion, opggProfileUrl } from "../hextech/opggProfile";

describe("opggRegion", () => {
  // The whole reason this module exists: the OP.GG slug is NOT a lowercased
  // Riot platform id. These four are the ones that would break silently.
  it("maps the platforms that are not just lowercased", () => {
    expect(opggRegion("EUW1")).toBe("euw");
    expect(opggRegion("EUN1")).toBe("eune");
    expect(opggRegion("NA1")).toBe("na");
    expect(opggRegion("LA1")).toBe("lan");
    expect(opggRegion("LA2")).toBe("las");
    expect(opggRegion("OC1")).toBe("oce");
  });

  it("maps the platforms that are", () => {
    expect(opggRegion("KR")).toBe("kr");
    expect(opggRegion("RU")).toBe("ru");
  });

  it("covers the rest of the live platform set", () => {
    expect(opggRegion("BR1")).toBe("br");
    expect(opggRegion("JP1")).toBe("jp");
    expect(opggRegion("TR1")).toBe("tr");
    expect(opggRegion("PH2")).toBe("ph");
    expect(opggRegion("SG2")).toBe("sg");
    expect(opggRegion("TH2")).toBe("th");
    expect(opggRegion("TW2")).toBe("tw");
    expect(opggRegion("VN2")).toBe("vn");
    expect(opggRegion("ME1")).toBe("me");
  });

  it("tolerates case and whitespace from a scraped source", () => {
    expect(opggRegion("euw1")).toBe("euw");
    expect(opggRegion("  EUW1 ")).toBe("euw");
  });

  // A guessed slug is a live link to a stranger's profile. Null is the only
  // safe answer, and the card renders plain text on it.
  it("refuses anything it has not verified", () => {
    expect(opggRegion(null)).toBeNull();
    expect(opggRegion(undefined)).toBeNull();
    expect(opggRegion("")).toBeNull();
    expect(opggRegion("   ")).toBeNull();
    expect(opggRegion("PBE1")).toBeNull();
    expect(opggRegion("EUW")).toBeNull();
    expect(opggRegion("NA")).toBeNull();
  });

  // The regional ROUTING cluster is a different field answering a different
  // question — see the module header. It must not resolve here by accident.
  it("does not accept a match-routing cluster", () => {
    expect(opggRegion("europe")).toBeNull();
    expect(opggRegion("americas")).toBeNull();
    expect(opggRegion("asia")).toBeNull();
    expect(opggRegion("sea")).toBeNull();
  });
});

describe("opggProfileUrl", () => {
  it("builds the canonical URL", () => {
    expect(opggProfileUrl("EUW1", "Dun", "EUW")).toBe("https://op.gg/lol/summoners/euw/Dun-EUW");
  });

  // Verified 200 live on 2026-07-29 — the shape this exact case produces.
  it("percent-encodes a space in the game name", () => {
    expect(opggProfileUrl("EUW1", "TWTV Peng04", "Yuqi")).toBe(
      "https://op.gg/lol/summoners/euw/TWTV%20Peng04-Yuqi"
    );
  });

  // The separator between name and tag is a literal `-`, which is why the two
  // halves are encoded separately rather than the path being encoded whole.
  it("keeps the name/tag separator literal", () => {
    const url = opggProfileUrl("KR", "Hide on bush", "KR1");
    expect(url).toBe("https://op.gg/lol/summoners/kr/Hide%20on%20bush-KR1");
    expect(url!.endsWith("-KR1")).toBe(true);
  });

  it("encodes characters that would otherwise break the path", () => {
    expect(opggProfileUrl("NA1", "a/b?c#d", "NA1")).toBe(
      "https://op.gg/lol/summoners/na/a%2Fb%3Fc%23d-NA1"
    );
  });

  it("targets the canonical host, not a redirecting one", () => {
    const url = opggProfileUrl("NA1", "Doublelift", "NA1")!;
    expect(url.startsWith("https://op.gg/lol/summoners/")).toBe(true);
    expect(url).not.toContain("www.op.gg");
  });

  it("returns null on an unmappable platform rather than guessing", () => {
    expect(opggProfileUrl("PBE1", "Someone", "NA1")).toBeNull();
    expect(opggProfileUrl(null, "Someone", "NA1")).toBeNull();
  });

  it("returns null on a missing or blank Riot ID half", () => {
    expect(opggProfileUrl("EUW1", "", "EUW")).toBeNull();
    expect(opggProfileUrl("EUW1", "Dun", "")).toBeNull();
    expect(opggProfileUrl("EUW1", "  ", "EUW")).toBeNull();
    expect(opggProfileUrl("EUW1", null, "EUW")).toBeNull();
    expect(opggProfileUrl("EUW1", "Dun", undefined)).toBeNull();
  });
});
