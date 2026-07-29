import { describe, it, expect } from "vitest";
import { resolveAltKeystone, ALT_KEYSTONE_MIN_GAP } from "../altKeystone";
import type { BuildResponse, Pick, RunesBlock, TreeRef } from "@/lib/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately built from the WIRE shape (BuildResponse[]), not from engine
// internals — this module's whole job is to read what /api/build actually
// returns, and the numbers below were captured from real
// `buildRecommendations` runs against api.coachless.gg on 2026-07-29
// (patch 16.13, tiers [5,6,7]).

const TREE: Record<string, TreeRef> = {
  precision: { id: 8000, name: "Precision", icon: "p.png" },
  domination: { id: 8100, name: "Domination", icon: "d.png" },
  sorcery: { id: 8200, name: "Sorcery", icon: "s.png" },
  resolve: { id: 8400, name: "Resolve", icon: "r.png" },
  inspiration: { id: 8300, name: "Inspiration", icon: "i.png" },
};

function pick(id: number, name: string, wpa: number, occurrence: number, lowSample = false): Pick {
  return { id, name, icon: `${id}.png`, wpa, winrate: null, occurrence, lowSample };
}

function variant(keystone: Pick, primaryTree: TreeRef): BuildResponse {
  const runes: RunesBlock = {
    primaryTree,
    secondaryTree: TREE.resolve,
    keystone,
    primary: [],
    // A REAL secondary row, including the sub-noise-floor entries
    // lib/recommend.ts's `bestAboveFloor` fallback can produce (Ziggs BOT
    // variant #3: Bone Plating on 322 games out of 153,475). Present in the
    // fixture ON PURPOSE: if this module ever starts forwarding a variant's
    // secondary rows, the "never exposes bestAboveFloor's fallback" test below
    // has something real to catch it with.
    secondary: [pick(8473, "Bone Plating", 2.051, 322, true), pick(8429, "Overgrowth", 1.825, 203, true)],
    shards: {
      offense: pick(5005, "Attack Speed", 0, 0),
      flex: pick(5008, "Adaptive Force", 0, 0),
      defense: pick(5001, "Health", 0, 0),
    },
  };
  return {
    champion: { id: 1, key: "x", name: "X", icon: "c.png" },
    role: 3,
    roleLabel: "Bot",
    patch: "16.13",
    tierLabel: "High Elo",
    runes,
    spells: [],
    items: {} as BuildResponse["items"],
    generatedAt: "2026-07-29T00:00:00.000Z",
    sources: { provider: "coachless.gg" },
  };
}

/** Ziggs BOT — the mild case the user actually reported. Alternative is in
 *  builds[1]; builds[2] is a filler page repeating variant #1's keystone. */
const ZIGGS: BuildResponse[] = [
  variant(pick(8229, "Arcane Comet", -0.0242, 140275), TREE.sorcery),
  variant(pick(8369, "First Strike", 0.463, 9297), TREE.inspiration),
  variant(pick(8229, "Arcane Comet", -0.0242, 140275), TREE.sorcery),
];

/** Jhin BOT — the extreme case, and the one that kills a builds[1]-only read:
 *  builds[1] is WORSE than what is shown and the real alternative is builds[2]. */
const JHIN: BuildResponse[] = [
  variant(pick(8021, "Fleet Footwork", -0.2723, 387410), TREE.precision),
  variant(pick(8128, "Dark Harvest", -0.7247, 131012), TREE.domination),
  variant(pick(8992, "Deathfire Touch", 2.5002, 81053), TREE.sorcery),
];

/** Caitlyn BOT — shown WPA of -0.011 sits inside wpaClass's neutral-grey dead
 *  zone, so a "renders red" trigger would drop it. It must still fire. */
const CAITLYN: BuildResponse[] = [
  variant(pick(8008, "Lethal Tempo", -0.0108, 517777), TREE.precision),
  variant(pick(8369, "First Strike", 0.8072, 65776), TREE.inspiration),
  variant(pick(8008, "Lethal Tempo", -0.0108, 517777), TREE.precision),
];

/** Lux SUP — shown keystone is POSITIVE and the alternative is worse. Nothing
 *  should render; this is the "card looks exactly as it does today" case. */
const LUX: BuildResponse[] = [
  variant(pick(8229, "Arcane Comet", 0.1804, 216533), TREE.sorcery),
  variant(pick(8128, "Dark Harvest", -0.762, 46077), TREE.domination),
  variant(pick(8229, "Arcane Comet", 0.1804, 216533), TREE.sorcery),
];

// ── Live-captured cases ──────────────────────────────────────────────────────

describe("resolveAltKeystone — champions captured from the real engine", () => {
  it("Ziggs BOT: surfaces First Strike from builds[1]", () => {
    const alt = resolveAltKeystone(ZIGGS);
    expect(alt).not.toBeNull();
    expect(alt!.keystone.name).toBe("First Strike");
    expect(alt!.keystone.wpa).toBeCloseTo(0.463, 5);
    expect(alt!.keystone.occurrence).toBe(9297);
    expect(alt!.tree.name).toBe("Inspiration");
    expect(alt!.variantRank).toBe(2);
  });

  it("Jhin BOT: surfaces Deathfire Touch from builds[2], NOT the worse builds[1]", () => {
    const alt = resolveAltKeystone(JHIN);
    expect(alt).not.toBeNull();
    expect(alt!.keystone.name).toBe("Deathfire Touch");
    expect(alt!.keystone.wpa).toBeCloseTo(2.5002, 5);
    expect(alt!.variantRank).toBe(3);
  });

  it("Jhin BOT: never offers builds[1], whose WPA is below the shown keystone's", () => {
    const alt = resolveAltKeystone(JHIN);
    expect(alt!.keystone.name).not.toBe("Dark Harvest");
    expect(alt!.keystone.wpa).toBeGreaterThan(JHIN[0].runes.keystone.wpa);
  });

  it("Caitlyn BOT: fires on a shown WPA inside the neutral-grey dead zone (-0.011)", () => {
    const alt = resolveAltKeystone(CAITLYN);
    expect(alt).not.toBeNull();
    expect(alt!.keystone.name).toBe("First Strike");
  });

  it("Lux SUP: returns null when the shown keystone is already positive", () => {
    expect(resolveAltKeystone(LUX)).toBeNull();
  });
});

// ── The predicate, conjunct by conjunct ──────────────────────────────────────

describe("resolveAltKeystone — trigger predicate", () => {
  const shownNeg = pick(1, "Shown", -0.5, 100000);

  function withAlt(altWpa: number, lowSample = false, altId = 2): BuildResponse[] {
    return [variant(shownNeg, TREE.precision), variant(pick(altId, "Alt", altWpa, 50000, lowSample), TREE.sorcery)];
  }

  it("(1) does not fire when the shown keystone is positive", () => {
    const builds = [variant(pick(1, "Shown", 0.1, 100000), TREE.precision), variant(pick(2, "Alt", 9, 50000), TREE.sorcery)];
    expect(resolveAltKeystone(builds)).toBeNull();
  });

  it("(1) does not fire when the shown keystone is exactly zero", () => {
    const builds = [variant(pick(1, "Shown", 0, 100000), TREE.precision), variant(pick(2, "Alt", 9, 50000), TREE.sorcery)];
    expect(resolveAltKeystone(builds)).toBeNull();
  });

  it("(1) fires on a hairline-negative shown keystone", () => {
    const builds = [
      variant(pick(1, "Shown", -0.0001, 100000), TREE.precision),
      variant(pick(2, "Alt", 0.5, 50000), TREE.sorcery),
    ];
    expect(resolveAltKeystone(builds)).not.toBeNull();
  });

  it("(2) does not fire when the alternative is merely LESS negative", () => {
    expect(resolveAltKeystone(withAlt(-0.01))).toBeNull();
  });

  it("(2) does not fire when the alternative is exactly zero", () => {
    expect(resolveAltKeystone(withAlt(0))).toBeNull();
  });

  it("(2) fires on a hairline-positive alternative once the gap clears", () => {
    // shown -0.5, alt +0.0001 -> gap 0.5001, comfortably over the guard.
    expect(resolveAltKeystone(withAlt(0.0001))).not.toBeNull();
  });

  it("(3) does NOT fire at exactly the minimum gap (strict >)", () => {
    const shown = pick(1, "Shown", -0.02, 100000);
    const builds = [variant(shown, TREE.precision), variant(pick(2, "Alt", -0.02 + ALT_KEYSTONE_MIN_GAP, 50000), TREE.sorcery)];
    expect(resolveAltKeystone(builds)).toBeNull();
  });

  it("(3) fires just above the minimum gap", () => {
    const shown = pick(1, "Shown", -0.02, 100000);
    const builds = [
      variant(shown, TREE.precision),
      variant(pick(2, "Alt", -0.02 + ALT_KEYSTONE_MIN_GAP + 0.0001, 50000), TREE.sorcery),
    ];
    expect(resolveAltKeystone(builds)).not.toBeNull();
  });

  it("(3) guarantees the two rendered 2-decimal numbers can never print the same string", () => {
    // wpaText rounds to 2dp: two values printing identically are within 0.01 of
    // each other, so a gap strictly greater than 0.04 makes that unreachable.
    expect(ALT_KEYSTONE_MIN_GAP).toBeGreaterThan(0.01);
    for (let shownWpa = -0.5; shownWpa < 0; shownWpa += 0.017) {
      const alt = resolveAltKeystone([
        variant(pick(1, "Shown", shownWpa, 100000), TREE.precision),
        variant(pick(2, "Alt", shownWpa + ALT_KEYSTONE_MIN_GAP + 1e-6, 50000), TREE.sorcery),
      ]);
      if (alt) expect(alt.keystone.wpa.toFixed(2)).not.toBe(shownWpa.toFixed(2));
    }
  });

  it("(4) does not fire when the alternative failed the adoption bar", () => {
    expect(resolveAltKeystone(withAlt(2.0, /* lowSample */ true))).toBeNull();
  });

  it("(4) fires on the same numbers once the adoption flag clears", () => {
    expect(resolveAltKeystone(withAlt(2.0, false))).not.toBeNull();
  });
});

// ── Variant scanning and dedup ───────────────────────────────────────────────

describe("resolveAltKeystone — variant scanning", () => {
  it("skips a filler variant that repeats the shown keystone's id", () => {
    const shown = pick(8229, "Arcane Comet", -0.2, 140275);
    const builds = [
      variant(shown, TREE.sorcery),
      // Same rune id, different tree object — the shape a filler page takes.
      variant(pick(8229, "Arcane Comet", -0.2, 140275), TREE.resolve),
    ];
    expect(resolveAltKeystone(builds)).toBeNull();
  });

  it("never returns the keystone already on screen", () => {
    for (const builds of [ZIGGS, JHIN, CAITLYN]) {
      const alt = resolveAltKeystone(builds);
      if (alt) expect(alt.keystone.id).not.toBe(builds[0].runes.keystone.id);
    }
  });

  it("picks the best WPA across variants, not the earliest qualifying one", () => {
    const builds = [
      variant(pick(1, "Shown", -0.3, 100000), TREE.precision),
      variant(pick(2, "Good", 0.4, 60000), TREE.domination),
      variant(pick(3, "Better", 1.9, 30000), TREE.sorcery),
    ];
    expect(resolveAltKeystone(builds)!.keystone.name).toBe("Better");
  });

  it("breaks a WPA tie on the larger sample", () => {
    const builds = [
      variant(pick(1, "Shown", -0.3, 100000), TREE.precision),
      variant(pick(2, "Smaller", 0.5, 10000), TREE.domination),
      variant(pick(3, "Larger", 0.5, 90000), TREE.sorcery),
    ];
    expect(resolveAltKeystone(builds)!.keystone.name).toBe("Larger");
  });

  it("breaks a full tie on the earlier variant, deterministically", () => {
    const builds = [
      variant(pick(1, "Shown", -0.3, 100000), TREE.precision),
      variant(pick(2, "First", 0.5, 50000), TREE.domination),
      variant(pick(3, "Second", 0.5, 50000), TREE.sorcery),
    ];
    expect(resolveAltKeystone(builds)!.variantRank).toBe(2);
  });

  it("reports the ALTERNATIVE's own primary tree, not the shown build's", () => {
    const alt = resolveAltKeystone(JHIN)!;
    expect(alt.tree.name).toBe("Sorcery");
    expect(alt.tree.name).not.toBe(JHIN[0].runes.primaryTree.name);
  });
});

// ── The coupled defect: this surface must not expose secondary rows ──────────

describe("resolveAltKeystone — does not expose lib/recommend.ts's bestAboveFloor fallback", () => {
  // `bestAboveFloor` falls back to the most-played entry when no rune in a row
  // clears `noiseFloor`, which is how a 322-game rune ends up in variant #3's
  // secondary on a 153,475-game champion. That defect only becomes user-visible
  // if something renders a variant's SECONDARY rows. This surface exposes the
  // keystone and nothing else, and the keystone comes from `pickRecommended`
  // over `keystoneData` — a path that never touches `bestAboveFloor`.
  it("returns exactly {keystone, tree, variantRank} and no rune rows", () => {
    const alt = resolveAltKeystone(JHIN)!;
    expect(Object.keys(alt).sort()).toEqual(["keystone", "tree", "variantRank"]);
  });

  it("carries none of the sub-noise-floor secondary runes present in the fixture", () => {
    const alt = resolveAltKeystone(JHIN)!;
    const serialized = JSON.stringify(alt);
    expect(serialized).not.toContain("Bone Plating");
    expect(serialized).not.toContain("Overgrowth");
  });
});

// ── Degenerate input ─────────────────────────────────────────────────────────

describe("resolveAltKeystone — degenerate input", () => {
  it("returns null for an empty array", () => {
    expect(resolveAltKeystone([])).toBeNull();
  });

  it("returns null for a single-variant response", () => {
    expect(resolveAltKeystone([variant(pick(1, "Shown", -0.5, 100), TREE.precision)])).toBeNull();
  });

  it("returns null for a non-array", () => {
    expect(resolveAltKeystone(null as unknown as BuildResponse[])).toBeNull();
    expect(resolveAltKeystone(undefined as unknown as BuildResponse[])).toBeNull();
  });

  it("survives a variant with a missing runes block", () => {
    const builds = [variant(pick(1, "Shown", -0.5, 100000), TREE.precision), {} as BuildResponse];
    expect(resolveAltKeystone(builds)).toBeNull();
  });

  it("survives a malformed keystone on the shown build", () => {
    const builds = [{ runes: {} } as BuildResponse, variant(pick(2, "Alt", 2, 50000), TREE.sorcery)];
    expect(resolveAltKeystone(builds)).toBeNull();
  });
});
