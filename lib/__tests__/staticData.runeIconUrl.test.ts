/**
 * Tests for lib/staticData.ts runeIconUrl — specifically the stale-bundle
 * special cases. The coachless rune bundle carries dead Icon paths for two
 * reworked keystones (Deathfire Touch 8992, Stormraider's Surge 8230); both
 * must resolve to their known-good CDN paths regardless of what the bundle
 * says. Pure URL construction — no network.
 */
import { describe, it, expect } from "vitest";
import { runeIconUrl } from "../staticData";

const VER = "16.13.1";
const BASE = `https://cdn.coachless.gg/static-files/${VER}/img/`;

describe("runeIconUrl", () => {
  it("special-cases Stormraider's Surge (8230) past the bundle's stale PhaseRush path", () => {
    // The bundle still hands out the pre-rework path, which 403s on the CDN.
    expect(runeIconUrl(8230, "perk-images/Styles/Sorcery/PhaseRush/PhaseRush.png", VER)).toBe(
      BASE + "perk-images/Styles/Sorcery/PhaseRush/StormraidersSurgeRuneIcon2.webp"
    );
    // Must hold even when the bundle has no Icon path at all.
    expect(runeIconUrl(8230, undefined, VER)).toBe(
      BASE + "perk-images/Styles/Sorcery/PhaseRush/StormraidersSurgeRuneIcon2.webp"
    );
  });

  it("special-cases Deathfire Touch (8992)", () => {
    expect(runeIconUrl(8992, "anything.png", VER)).toBe(
      BASE + "perk-images/Styles/Sorcery/DeathfireTouch/DEATHFIRE_TOUCH_KEYSTONE.webp"
    );
  });

  it("converts .png bundle paths to .webp for ordinary runes", () => {
    expect(runeIconUrl(8112, "perk-images/Styles/Domination/Electrocute/Electrocute.png", VER)).toBe(
      BASE + "perk-images/Styles/Domination/Electrocute/Electrocute.webp"
    );
  });

  it("returns empty string when an ordinary rune has no Icon path", () => {
    expect(runeIconUrl(8112, undefined, VER)).toBe("");
  });
});
