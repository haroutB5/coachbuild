/**
 * Draft redesign plan §2.3/§6 — lib/draft/damageProfile.ts's suggestedDefense.
 * AP/AD/mixed/CC category coverage, plus the "nothing to derive from" null
 * case.
 */
import { describe, it, expect } from "vitest";
import { suggestedDefense } from "../draft/damageProfile";

describe("suggestedDefense", () => {
  it("AP-leaning (magic > attack) -> Magic Resist", () => {
    const r = suggestedDefense(["Mage"], { attack: 2, defense: 4, magic: 10 });
    expect(r).toEqual({
      label: "Magic Resist / Mercury's Treads",
      reason: "their kit leans magic damage",
    });
  });

  it("AD-leaning (attack > magic) -> Armor", () => {
    const r = suggestedDefense(["Marksman"], { attack: 9, defense: 3, magic: 1 });
    expect(r).toEqual({
      label: "Armor / Plated Steelcaps",
      reason: "their kit leans physical damage",
    });
  });

  it("mixed (attack === magic, no CC tag) -> a mixed-defense call, never a fabricated single lean", () => {
    const r = suggestedDefense(["Fighter"], { attack: 6, defense: 5, magic: 6 });
    expect(r).toEqual({
      label: "Mixed (Armor & Magic Resist)",
      reason: "their kit deals a roughly even physical/magic split",
    });
  });

  it("Tank tag -> Tenacity, REGARDLESS of damage-type lean (CC threat takes priority)", () => {
    const r = suggestedDefense(["Tank"], { attack: 5, defense: 9, magic: 3 });
    expect(r?.label).toBe("Tenacity (Mercury's Treads)");
  });

  it("Support tag -> Tenacity even with no info at all", () => {
    const r = suggestedDefense(["Support"], null);
    expect(r?.label).toBe("Tenacity (Mercury's Treads)");
  });

  it("no CC tag and no info -> null (nothing to derive from, never a fabricated default)", () => {
    expect(suggestedDefense(["Fighter"], null)).toBeNull();
    expect(suggestedDefense([], null)).toBeNull();
  });

  it("Tank+Mage (both present) -> CC check wins over the magic lean", () => {
    const r = suggestedDefense(["Tank", "Mage"], { attack: 1, defense: 8, magic: 7 });
    expect(r?.label).toBe("Tenacity (Mercury's Treads)");
  });
});
