/**
 * Unit tests for buildSlotCap.ts — the 6-slot game-reality cap enforced at
 * ItemsBlock assembly (recommend.ts) for CORE ORDER / OPTIMIZED ORDER.
 *
 * Regression fixture: Galio (championId 3) MID, captured against what the app
 * then called "High Elo" (coachless tiers [5,6,7], really Emerald+Diamond+
 * Master — the label was off by one; see lib/rankBrackets.ts) — the live bug that
 * prompted this rule. Uncapped, the engine's core-order line rendered 7
 * tiles: Hextech Rocketbelt -> Imperial Mandate -> Riftmaker (the confirmed
 * 3-slot core) -> Plated Steelcaps (boots) -> Kaenic Rookern -> Force of
 * Nature -> Randuin's Omen (3 more "4th+" legendaries, already WPA-sorted
 * best-first by recommend.ts's `topItems`) = 6 full items + boots, impossible
 * in a 6-slot inventory.
 */

import { describe, it, expect } from "vitest";
import { fullItemCapForRole, capExtraFullItems } from "../buildSlotCap";
import type { RoleId } from "../types";

// Stand-ins for the WPA-sorted (best-first) "4th+ legendary" pool
// recommend.ts hands to capExtraFullItems. Order matters: this is what
// "never fabricate, never reorder, drop the lowest-value surplus" is tested
// against.
const galioFourthPlus = [
  { name: "Kaenic Rookern", wpa: 2.1 },
  { name: "Force of Nature", wpa: 1.4 },
  { name: "Randuin's Omen", wpa: 0.6 }, // lowest-value of the 3 — expected to drop first
];

describe("fullItemCapForRole (6-slot budget)", () => {
  it("Top/Jungle/Mid/Auto cap at 5 full items (+ boots = the game's 6 slots)", () => {
    const standard: RoleId[] = [0, 1, 2, 5];
    for (const role of standard) expect(fullItemCapForRole(role)).toBe(5);
  });

  it("bot lane (ADC, role 3) caps at 6 full items — the boots-sell exception", () => {
    expect(fullItemCapForRole(3)).toBe(6);
  });

  it("SUPPORT (role 4) caps at 4 full items — the quest item owns a slot too", () => {
    // A support's quest item (World Atlas -> Zaz'Zak's Realmspike / Bloodsong)
    // permanently occupies one of the six and is rendered separately by
    // SupportItemCard. At the old cap of 5 the surfaces together showed
    // support item + boots + 5 full = SEVEN real slots — the same impossible
    // inventory the Galio fixture below catches, by a different route.
    expect(fullItemCapForRole(4)).toBe(4);
  });

  it("every role's total stays inside the six slots the game actually has", () => {
    const SUPPORT_QUEST_SLOT = 1;
    const BOOTS_SLOT = 1;
    expect(fullItemCapForRole(0) + BOOTS_SLOT).toBe(6);
    expect(fullItemCapForRole(4) + BOOTS_SLOT + SUPPORT_QUEST_SLOT).toBe(6);
    // Bot is the one deliberate exception: 7 tiles in a PROGRESSION line.
    expect(fullItemCapForRole(3) + BOOTS_SLOT).toBe(7);
  });
});

describe("capExtraFullItems — Galio MID (non-bot) regression fixture", () => {
  it("trims the uncapped 6-full-item line (3 core + 3 extra) down to 5 full items, dropping the lowest-value surplus", () => {
    const capped = capExtraFullItems(galioFourthPlus, /* fixedCount (core 1/2/3) */ 3, 2);
    // Budget = 5 - 3 = 2 extra slots. Keeps the top 2 by the pool's existing
    // best-first order; drops Randuin's Omen (the lowest-WPA of the 3).
    expect(capped.map((c) => c.name)).toEqual(["Kaenic Rookern", "Force of Nature"]);
  });

  it("preserves relative order of survivors — never reorders by value", () => {
    const capped = capExtraFullItems(galioFourthPlus, 3, 2);
    expect(capped).toEqual(galioFourthPlus.slice(0, 2));
  });

  it("total tiles (core 3 + boots 1 + capped extra) settle at exactly 6, not 7", () => {
    const capped = capExtraFullItems(galioFourthPlus, 3, 2);
    const CORE = 3;
    const BOOTS = 1;
    expect(CORE + BOOTS + capped.length).toBe(6);
  });
});

describe("capExtraFullItems — bot lane (ADC) exception", () => {
  it("keeps all 3 extra items unchanged (budget 6 - 3 core = 3)", () => {
    const capped = capExtraFullItems(galioFourthPlus, 3, 3);
    expect(capped).toEqual(galioFourthPlus);
  });

  it("total tiles (core 3 + boots 1 + extra 3) settle at exactly 7 — the documented bot-lane exception", () => {
    const capped = capExtraFullItems(galioFourthPlus, 3, 3);
    expect(3 + 1 + capped.length).toBe(7);
  });

  it("still trims when the extra pool exceeds even the bot-lane budget (4 candidates -> 3 kept)", () => {
    const fourCandidates = [
      ...galioFourthPlus,
      { name: "Overkill Item", wpa: 0.1 }, // lowest value — dropped
    ];
    const capped = capExtraFullItems(fourCandidates, 3, 3);
    expect(capped.map((c) => c.name)).toEqual([
      "Kaenic Rookern",
      "Force of Nature",
      "Randuin's Omen",
    ]);
  });
});

describe("capExtraFullItems — thin data (never fabricates)", () => {
  it("returns the pool unchanged when it is shorter than the budget", () => {
    const thin = [{ name: "Only Item", wpa: 1.0 }];
    expect(capExtraFullItems(thin, 3, 2)).toEqual(thin);
    expect(capExtraFullItems(thin, 3, 3)).toEqual(thin);
  });

  it("returns [] when there is no extra pool at all, never inventing an item", () => {
    expect(capExtraFullItems([], 3, 2)).toEqual([]);
  });

  it("is agnostic to boots — it never inspects, adds, or removes a boots entry; the 'no boots in data' case is a hard 404 upstream (recommend.ts's bootsBest guard), never a value this function has to compensate for", () => {
    // Simulate a caller that (incorrectly) fed a boots-shaped item into the
    // full-items pool: capExtraFullItems has no boots awareness and treats
    // it exactly like any other candidate — proving the cap logic doesn't
    // special-case or fabricate around boots at all.
    const withBootsLookalike = [
      { name: "Some Boots", wpa: 5.0 },
      { name: "Full Item A", wpa: 1.0 },
      { name: "Full Item B", wpa: 0.5 },
    ];
    // role 2 (mid) -> cap 5; fixedCount 3 -> budget 2, so exactly 1 of the 3
    // candidates above is dropped regardless of whether it "looks like" boots.
    expect(capExtraFullItems(withBootsLookalike, 3, 2)).toEqual([
      { name: "Some Boots", wpa: 5.0 },
      { name: "Full Item A", wpa: 1.0 },
    ]);
  });
});

describe("capExtraFullItems — optimized-order line (seed + conditioned chain)", () => {
  it("a 2-item conditioned chain (fixedCount=1 seed) is untouched under either lane's budget", () => {
    const chain = [{ name: "Second", wpa: 1.2 }, { name: "Third", wpa: 0.9 }];
    expect(capExtraFullItems(chain, 1, 2)).toEqual(chain); // non-bot: budget 5-1=4
    expect(capExtraFullItems(chain, 1, 3)).toEqual(chain); // bot: budget 6-1=5
  });
});
