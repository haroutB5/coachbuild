/**
 * Tests for lib/splash.ts — pure URL construction, no network/mocks needed.
 * Live-verified separately (see HANDOFF-engo.md): Viktor/LeeSin/Jinx/Locke
 * all 200 at the constructed URL; a wrong key (Wukong vs. the real
 * "MonkeyKing") 403s, not 404s.
 */
import { describe, it, expect } from "vitest";
import { getSplashUrl } from "../splash";

describe("getSplashUrl", () => {
  it("builds the ddragon splash URL for a known key", () => {
    expect(getSplashUrl("Viktor")).toBe(
      "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Viktor_0.jpg"
    );
  });

  it("works for multi-word CDN keys (no space)", () => {
    expect(getSplashUrl("LeeSin")).toBe(
      "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/LeeSin_0.jpg"
    );
  });

  it("builds a URL even for a champion coachless doesn't have yet (Locke) — ddragon splash ships same-day", () => {
    expect(getSplashUrl("Locke")).toBe(
      "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Locke_0.jpg"
    );
  });

  it("returns null for an empty key", () => {
    expect(getSplashUrl("")).toBeNull();
  });

  it("returns null for a whitespace-only key", () => {
    expect(getSplashUrl("   ")).toBeNull();
  });

  it("does NOT validate the key resolves — builds a URL for a wrong key too (e.g. 'Wukong', which 403s live; caller must handle via onError, not by trusting this URL)", () => {
    expect(getSplashUrl("Wukong")).toBe(
      "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Wukong_0.jpg"
    );
  });
});
