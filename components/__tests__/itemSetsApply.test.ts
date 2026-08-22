/**
 * Tests for components/hextech/itemSetsApply.ts — the shared code path
 * between the manual "Add item builds" button and the auto-export effect.
 * No jsdom in this repo's harness (same posture heroContracts.test.ts
 * documents) — resolveProConsensusForSets/applyItemSetsForBuild only touch
 * the global `fetch`, stubbed per-test via vi.stubGlobal + a fresh dynamic
 * import (module-level caches elsewhere in the app make this the safe
 * pattern, mirrored from heroContracts.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ChampionRef, BuildResponse, Pick, ItemsBlock, RunesBlock } from "@/lib/types";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

/** v0.36.0 — a realistic ddragon item.json fixture (raw shape, matching
 *  itemDetail.ts's RawItemJson) covering every item id these tests'
 *  baseItems()/baseBuild() reference, all FULL items (empty `into`) except
 *  the boots slot (tagged Boots, built FROM something — passes
 *  itemSetBody.ts's isFullItem boots special case). Needed now that
 *  applyItemSetsForBuild threads real item metadata into buildItemSets for
 *  the full-items-only build-line rule — an empty `data: {}` CDN response
 *  (this file's pre-v0.36.0 fixture) would degrade every build line to
 *  empty, which is correct behavior but not what these wiring tests are
 *  meant to exercise. */
const ITEM_JSON_FIXTURE = {
  type: "item",
  version: "16.13.1",
  data: {
    "1054": { name: "Doran's Shield", into: [], from: [] },
    "3006": { name: "Berserker's Greaves", tags: ["Boots", "AttackSpeed"], into: ["3172"], from: ["1001"] },
    "3031": { name: "Infinity Edge", tags: ["CriticalStrike"], into: [], from: ["1038"] },
    "3036": { name: "Lord Dominik's Regards", tags: ["Damage"], into: [], from: ["3035"] },
    "3095": { name: "Item 3095", tags: ["Damage"], into: [], from: ["1038"] },
    "3072": { name: "Bloodthirster", tags: ["Damage", "LifeSteal"], into: [], from: ["1038"] },
    // Two support-quest FINALS (2026-07-26). Real 16.13.1 shape: built from
    // the quest hub 3867, recipe-tree leaves, purchasable, not Boots-tagged
    // — so isBuildItem counts both, which is exactly how two mutually
    // exclusive items used to reach one 6-item Pro build line.
    "3871": { name: "Zaz'Zak's Realmspike", tags: ["Health", "GoldPer", "Lane"], into: [], from: ["3867"] },
    "3876": { name: "Solstice Sleigh", tags: ["Health", "GoldPer", "Lane"], into: [], from: ["3867"] },
  },
};

function routedFetch(routes: [string, unknown | (() => unknown)][]) {
  return vi.fn(async (url: string) => {
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) {
        const resolved = typeof body === "function" ? (body as () => unknown)() : body;
        return jsonResponse(resolved);
      }
    }
    return jsonResponse({}, false);
  });
}

function pick(id: number): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa: 0.02, winrate: 52, occurrence: 500 };
}

function baseItems(): ItemsBlock {
  return {
    starter: pick(1054),
    boots: pick(3006),
    first: pick(3031),
    second: pick(3036),
    third: pick(3095),
    fourthPlus: [pick(3072)],
  };
}

function baseRunes(): RunesBlock {
  return {
    primaryTree: { id: 8000, name: "Precision", icon: "t" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t" },
    keystone: pick(8005),
    primary: [pick(9111), pick(9104), pick(8014)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5005), flex: pick(5008), defense: pick(5002) },
  };
}

const CHAMP: ChampionRef = { id: 222, key: "Jinx", name: "Jinx", icon: "jinx.png" };

function baseBuild(): BuildResponse {
  return {
    champion: CHAMP,
    role: 3,
    roleLabel: "Bot",
    patch: "16.13",
    tierLabel: "Diamond+",
    runes: baseRunes(),
    spells: [pick(4), pick(7)],
    items: baseItems(),
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
  };
}

const PRO_GAME = (itemId: number) => ({
  id: "g1",
  source: "soloq" as const,
  player: { name: "x", team: null, role: 3, country: null },
  account: { riotId: "x", region: "na" },
  championId: 222,
  championName: "Jinx",
  role: 3,
  patch: "16.13",
  win: true,
  kills: 1,
  deaths: 1,
  assists: 1,
  gameCreation: new Date().toISOString(),
  gameDurationSec: 1800,
  spells: [4, 7] as [number, number],
  finalItems: [itemId, 1054],
  trinket: null,
  purchaseOrder: [],
  skillOrder: [],
  runes: { primaryTree: 8000, keystone: 8005, primary: [], secondaryTree: 8100, secondary: [], shards: [] },
});

describe("resolveProConsensusForSets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns items/boots frequencies when the sample has real build items", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [PRO_GAME(3031), PRO_GAME(3031), PRO_GAME(1054)] }],
        // 2026-07-22: 3031 needs real metadata (isBuildItem excludes unknown
        // ids by default now that the allowlist no longer back-fills 1054
        // into this list — see the dedicated starters regression below).
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    const result = await resolveProConsensusForSets(CHAMP, "bot", "16.13");
    expect(result).not.toBeNull();
    expect(result!.items.some((i) => i.itemId === 3031)).toBe(true);
    expect(result!.items.some((i) => i.itemId === 1054)).toBe(false); // starter -- excluded, not this function's concern
  });

  it("2026-07-22 REGRESSION: a starting-allowlist item (Doran's Shield, 1054) is carved into proConsensus's own `starters` field and never reaches the items/boots this function returns, even with no item.json metadata", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        // Every game here carries ONLY the allowlisted starter (1054) — before
        // the 2026-07-22 fix this counted as "counts even with no item.json
        // metadata" via isBuildItem's allowlist branch and landed in `items`;
        // it must now be entirely absent from what this function returns
        // (itemSetBody's Pro build line has no legitimate use for a starter).
        ["/api/pros", { games: [PRO_GAME(1054), PRO_GAME(1054)] }],
        ["https://cdn.coachless.gg", { type: "item", version: "16.13.1", data: {} }],
      ])
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    // Both boots and items come back empty (every seen id was the allowlisted
    // starter, now partitioned out) -> resolveProConsensusForSets' own
    // "empty sample" contract returns null, same as a genuinely N=0 sample.
    expect(await resolveProConsensusForSets(CHAMP, "bot", "16.13")).toBeNull();
  });

  it("2026-07-26: exactly ONE support-quest final reaches the Pro build line — the modal pick, never both", async () => {
    // Two mutually-exclusive finals in one sample (Zaz'Zak's 2 games, Solstice
    // Sleigh 1). Before the supportFinals partition BOTH flowed through
    // model.items into itemSetBody's 6-item Pro line, which could then
    // recommend two items a player can never own together — the same bug the
    // Pro Consensus card was reported for, on the in-game shop surface.
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [PRO_GAME(3871), PRO_GAME(3871), PRO_GAME(3876)] }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    const result = await resolveProConsensusForSets(CHAMP, "bot", "16.13");
    expect(result).not.toBeNull();
    expect(result!.items.filter((i) => i.itemId === 3871 || i.itemId === 3876)).toEqual([
      { itemId: 3871, share: 2 / 3 },
    ]);
    // NON-REGRESSION half: the top pick must still be PRESENT. Carving the
    // family out of model.items without folding `top` back in here would have
    // dropped the support item from every support champ's Pro line entirely.
    expect(result!.items.some((i) => i.itemId === 3871)).toBe(true);
    // Documented invariant of this shape: share desc, itemId asc.
    const shares = result!.items.map((i) => i.share);
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
  });

  it("returns null when the pro-games sample is empty", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [] }],
        ["https://cdn.coachless.gg", { type: "item", version: "16.13.1", data: {} }],
      ])
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    expect(await resolveProConsensusForSets(CHAMP, "bot", "16.13")).toBeNull();
  });

  it("returns null (never throws) on a fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    await expect(resolveProConsensusForSets(CHAMP, "bot", "16.13")).resolves.toBeNull();
  });
});

describe("applyItemSetsForBuild", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds ONE set (WPA build, pro fetch empty) and POSTs to the bridge", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 1 });
        }
        return jsonResponse({}, false);
      })
    );
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    const result = await applyItemSetsForBuild({
      champ: CHAMP,
      lane: "bot",
      roleLabel: "Bot",
      build: baseBuild(),
      port: 48291,
      session: "sess-1",
    });
    expect(result).toEqual({ ok: true, count: 1 });
    const parsed = JSON.parse(capturedBridgeBody!);
    expect(parsed.championId).toBe(222);
    // v0.34.1: always exactly ONE champ+role set now (Core/Optimized/Pro/
    // Situational are blocks inside it, not separate sets).
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0].title).toBe("CoachBuild Jinx Bot");
    // v0.36.0: "Highest WPA" has no tag requirement, only a ≥4-item pool
    // threshold -- Core alone (5 full items here) already clears it.
    // v0.47.0: this fixture's items are all physical (3031 CriticalStrike,
    // 3036/3095/3072 Damage, boots 3006 AttackSpeed), so the champ resolves to
    // the AD damage FAMILY -- and Jinx carries no sub-lean class tag, so the
    // full AD spread is considered. Bruiser (no durable-AD item) and On-hit
    // (its only AttackSpeed item is boots) stay omitted (empty lines).
    // v0.48.0: Lethality/Assassin (Damage items 3036/3095/3072) and
    // Crit/Marksman (3031 IE + curated-pool fill Lord Dominik's 3036 /
    // Bloodthirster 3072, both crit-marksman staples) resolve to
    // near-identical builds here (they share 3036 + 3072), so the GENERAL
    // de-dup collapses them into ONE block, keeping the higher-priority
    // "Crit/Marksman" name (Jinx IS a crit marksman — the correct survivor).
    // In prod, with the full item catalog, the two lines diverge (distinct
    // crit vs lethality staples) and both would show. NO AP line ever appears
    // (cross-family exclusion). Confirms real ItemDetail tags threaded through
    // applyItemSetsForBuild drive family-scoped archetype emission + de-dup
    // end to end.
    // 2026-07-28 four-category cut: the shop now carries the Starting slot plus
    // at most four SOURCE-named build blocks (WPA / Pro / OTP / Hidden gem).
    // "Highest WPA" and the damage-archetype categories are gone entirely; with
    // no pro data, no OTP data and no qualifying gem, only the WPA build remains.
    expect(parsed.sets[0].blocks.map((b: { type: string }) => b.type)).toEqual([
      "Starting",
      "WPA build",
    ]);
    // v0.35.0: champ-scoped (not role-scoped) stale-removal prefix, so a
    // later lane flip's export cleans up THIS lane's set too.
    expect(parsed.replacePrefix).toBe("CoachBuild Jinx ");
  });

  it("adds a Pro build BLOCK (still one set) when pro-consensus data resolves", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        // 2026-07-22: PRO_GAME(3031) not PRO_GAME(1054) -- 1054 (Doran's
        // Shield) is on STARTING_ITEM_ALLOWLIST and is now carved into
        // proConsensus's `starters` field, never `items`/`boots` (see the
        // resolveProConsensusForSets regression test above), so a sample
        // that ONLY ever carried the allowlisted starter would resolve to
        // null and never produce a Pro build block at all -- this test needs
        // a genuine non-starter item to exercise "Pro build block appears."
        // AUDIT P1-B: the pro item must be one the champ's OWN build does NOT
        // already contain, AND the champ's own build must be long enough not to
        // pad itself with it. With PRO_GAME(3031) the Pro line padded out to the
        // exact same six ids as Core build and the cross-family de-dup
        // (correctly) collapsed it — leaving this wiring test asserting the
        // absence of a block for a reason that had nothing to do with wiring.
        // 3094 is pro-only; the 5th core item (3046, added below) is what stops
        // Core build reaching into the pro pool to fill its last slot.
        // 2026-07-28: TWO pro-only items, not one. The near-duplicate rule
        // (MAX_UNIQUE_ITEMS_FOR_NEAR_DUPLICATE in itemSetBody.ts) now drops a
        // block that adds only a single item the kept block does not have, so a
        // one-item pro fixture would collapse and leave this WIRING test failing
        // for a reason that has nothing to do with wiring — the same trap the
        // note above describes, one notch further along. 6672 is pro-only and
        // absent from baseBuild's core (3006/3031/3036/3095/3072 + 3046).
        if (url.startsWith("/api/pros"))
          return jsonResponse({
            games: [
              { ...PRO_GAME(3094), finalItems: [3094, 6672, 1054] },
              { ...PRO_GAME(3094), finalItems: [3094, 6672, 1054] },
            ],
          });
        if (url.startsWith("https://cdn.coachless.gg"))
          return jsonResponse({
            ...ITEM_JSON_FIXTURE,
            data: {
              ...ITEM_JSON_FIXTURE.data,
              "3046": { name: "Phantom Dancer", tags: ["AttackSpeed"], into: [], from: ["1018"] },
              "3094": { name: "Rapid Firecannon", tags: ["CriticalStrike"], into: [], from: ["1038"] },
              "6672": { name: "Kraken Slayer", tags: ["AttackSpeed"], into: [], from: ["1038"] },
            },
          });
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 1 });
        }
        return jsonResponse({}, false);
      })
    );
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    const build = baseBuild();
    build.items.fourthPlus = [...build.items.fourthPlus, pick(3046)]; // 5th core item — see the fetch stub
    await applyItemSetsForBuild({
      champ: CHAMP,
      lane: "bot",
      roleLabel: "Bot",
      build,
      port: 48291,
      session: "sess-1",
    });
    const parsed = JSON.parse(capturedBridgeBody!);
    expect(parsed.sets).toHaveLength(1);
    const types = parsed.sets[0].blocks.map((b: { type: string }) => b.type);
    expect(types).toContain("Pro build");
    const proBlock = parsed.sets[0].blocks.find((b: { type: string }) => b.type === "Pro build");
    expect(proBlock.items.map((i: { id: string }) => i.id)).toContain("3094");
  });

  it("REGRESSION (Dark Seal reaching a Pro build line via pro-consensus) -- a totally degraded item-metadata fetch degrades build lines to empty rather than shipping an unfiltered item", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse({}, false); // total metadata fetch failure
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 1 });
        }
        return jsonResponse({}, false);
      })
    );
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    await applyItemSetsForBuild({
      champ: CHAMP,
      lane: "bot",
      roleLabel: "Bot",
      build: baseBuild(),
      port: 48291,
      session: "sess-1",
    });
    const parsed = JSON.parse(capturedBridgeBody!);
    const core = parsed.sets[0].blocks.find((b: { type: string }) => b.type === "WPA build");
    expect(core.items).toEqual([]); // every id unknown -- excluded, never an unfiltered/invented item
    expect(parsed.sets[0].blocks.map((b: { type: string }) => b.type)).not.toContain("Hidden gem"); // nothing qualifies
  });

  // ── The overlay deltas, at the POST boundary (v0.114.0) ───────────────────
  // The pairing itself is proven pure in situationalItemSet.test.ts. What is
  // only provable HERE is that it survives the trip: applyItemSetsForBuild
  // destructures buildItemSets' record and spreads the field onto the body, and
  // a body is the last thing anyone can inspect before it is someone else's
  // problem. A dropped spread, an assignment that leaves `undefined`, or a
  // caller that rebuilt the sets and forgot the deltas all look identical from
  // inside the builder and different from out here.

  it("POSTs `situational` alongside the sets, paired with the Situational block's items", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 1 });
        }
        return jsonResponse({}, false);
      })
    );
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    const build = baseBuild();
    // Two alternatives, one positive and one negative, so the sign survives to
    // the wire and the order is observable. Ids deliberately OUTSIDE
    // ITEM_JSON_FIXTURE: an unknown id fails isFullItem and so can never be
    // pulled into a build line as padding, which would then exclude it from the
    // situational row (the WPA-build exclusion) and leave this test asserting
    // over an empty block.
    build.items.alts = {
      first: [
        { ...pick(4645), wpa: 1.5 },
        { ...pick(4646), wpa: -0.25 },
      ],
    };
    const result = await applyItemSetsForBuild({
      champ: CHAMP,
      lane: "bot",
      roleLabel: "Bot",
      build,
      port: 48291,
      session: "sess-1",
    });
    expect(result).toEqual({ ok: true, count: 1 });

    const parsed = JSON.parse(capturedBridgeBody!);
    const sit = parsed.sets[0].blocks.find((b: { type: string }) => b.type === "Situational");
    expect(sit).toBeDefined();
    const blockIds = sit.items.map((i: { id: string }) => Number(i.id));
    expect(blockIds.length).toBeGreaterThan(0);
    // Same ids, same order, same length — read off the wire, not off the
    // builder's return value.
    expect(parsed.situational.map((e: { id: number }) => e.id)).toEqual(blockIds);
    expect(parsed.situational).toHaveLength(blockIds.length);
    // The formatted string is what the overlay draws, verbatim.
    for (const entry of parsed.situational) {
      expect(typeof entry.text).toBe("string");
      expect(entry.text).toBe((entry.wpa > 0 ? "+" : "") + entry.wpa.toFixed(2));
      expect(entry.text.length).toBeGreaterThan(0);
    }
    // ...and the rest of the body is untouched by its presence.
    expect(parsed.championId).toBe(222);
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.replacePrefix).toBe("CoachBuild Jinx ");
  });

  it("OMITS `situational` from the body entirely for a champion with no alternatives", async () => {
    // `baseItems()` carries no `alts`. The key must be absent from the JSON —
    // not present as null, not present as []. An older companion.ps1 / desktop
    // never sees it either way, but "absent" is the only one of the three that
    // is also true of every build before 0.114.0.
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 1 });
        }
        return jsonResponse({}, false);
      })
    );
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    const result = await applyItemSetsForBuild({
      champ: CHAMP,
      lane: "bot",
      roleLabel: "Bot",
      build: baseBuild(),
      port: 48291,
      session: "sess-1",
    });
    expect(result).toEqual({ ok: true, count: 1 });
    const parsed = JSON.parse(capturedBridgeBody!);
    expect(Object.prototype.hasOwnProperty.call(parsed, "situational")).toBe(false);
    expect(capturedBridgeBody).not.toContain("situational");
    // The apply still happened, with the same sets it always sent.
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0].title).toBe("CoachBuild Jinx Bot");
  });

  it("the field changes nothing about the apply — same sets, same result, either way", async () => {
    // "Decoration" as a measurement rather than a promise: run the SAME export
    // with and without alternatives and diff everything except the new key.
    const capture = async (withAlts: boolean) => {
      vi.resetModules();
      vi.unstubAllGlobals();
      let body: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
          if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
          if (url.includes("/apply-itemsets")) {
            body = init?.body as string;
            return jsonResponse({ ok: true, count: 1 });
          }
          return jsonResponse({}, false);
        })
      );
      const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
      const build = baseBuild();
      if (withAlts) build.items.alts = { first: [{ ...pick(4645), wpa: 1.5 }] };
      const result = await applyItemSetsForBuild({
        champ: CHAMP,
        lane: "bot",
        roleLabel: "Bot",
        build,
        port: 48291,
        session: "sess-1",
      });
      return { result, parsed: JSON.parse(body!) };
    };
    const withAlts = await capture(true);
    const without = await capture(false);

    expect(withAlts.result).toEqual(without.result);
    expect(withAlts.parsed.championId).toBe(without.parsed.championId);
    expect(withAlts.parsed.replacePrefix).toBe(without.parsed.replacePrefix);
    // The one legitimate difference in the SETS is the Situational block the
    // alternatives produce; every build line is identical.
    const lines = (p: { sets: { blocks: { type: string }[] }[] }) =>
      p.sets[0].blocks.filter((b) => b.type !== "Situational");
    expect(JSON.stringify(lines(withAlts.parsed))).toBe(JSON.stringify(lines(without.parsed)));
    expect(withAlts.parsed.situational).toBeDefined();
    expect(without.parsed.situational).toBeUndefined();
  });
});

describe("shouldAutoApplyItemSets — pure gate", () => {
  it("fires when deep-link + toggle-on + session/port present + not yet fired", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false })
    ).toBe(true);
  });

  it("never fires without a deep link", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: false, autoEnabled: true, session: "s", port: 48291, alreadyFired: false })
    ).toBe(false);
  });

  it("never fires with the toggle off", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: true, autoEnabled: false, session: "s", port: 48291, alreadyFired: false })
    ).toBe(false);
  });

  it("never fires with no session", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: true, autoEnabled: true, session: null, port: 48291, alreadyFired: false })
    ).toBe(false);
  });

  it("never fires with no port", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: true, autoEnabled: true, session: "s", port: null, alreadyFired: false })
    ).toBe(false);
  });

  it("never fires a second time within the same mount (alreadyFired)", async () => {
    const { shouldAutoApplyItemSets } = await import("../hextech/itemSetsApply");
    expect(
      shouldAutoApplyItemSets({ isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: true })
    ).toBe(false);
  });
});

describe("autoApplyItemSetsIfEligible — probe + apply orchestration", () => {
  it("does not attempt at all when the gate refuses (no fetch call, no build() call)", async () => {
    const { autoApplyItemSetsIfEligible } = await import("../hextech/itemSetsApply");
    const buildFn = vi.fn();
    const getStatusImpl = vi.fn();
    const applyFn = vi.fn();
    const outcome = await autoApplyItemSetsIfEligible(
      { isDeepLink: false, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: false });
    expect(buildFn).not.toHaveBeenCalled();
    expect(getStatusImpl).not.toHaveBeenCalled();
  });

  it("quietly no-ops (attempted:false) when the companion probe fails -- no toast, never calls build()/applyFn", async () => {
    const { autoApplyItemSetsIfEligible } = await import("../hextech/itemSetsApply");
    const buildFn = vi.fn();
    const getStatusImpl = vi.fn(async () => null);
    const applyFn = vi.fn();
    const outcome = await autoApplyItemSetsIfEligible(
      { isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: false });
    expect(buildFn).not.toHaveBeenCalled();
    expect(applyFn).not.toHaveBeenCalled();
  });

  it("attempts + applies via the SAME applyFn the manual button uses, when the probe succeeds", async () => {
    const { autoApplyItemSetsIfEligible } = await import("../hextech/itemSetsApply");
    const params = { champ: CHAMP, lane: "bot" as const, roleLabel: "Bot", build: baseBuild() };
    const buildFn = vi.fn(async () => params);
    const getStatusImpl = vi.fn(async () => ({
      version: "1.2.2",
      port: 48291,
      phase: "InProgress",
      clientConnected: true,
      lastOpen: null,
      champSelect: null,
      lastPollAt: null,
      lastError: null,
    }));
    const applyFn = vi.fn(async () => ({ ok: true as const, count: 2 }));
    const outcome = await autoApplyItemSetsIfEligible(
      { isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: true, result: { ok: true, count: 2 } });
    expect(applyFn).toHaveBeenCalledWith({ ...params, port: 48291, session: "s" });
  });
});

// ── OTP resolution + the query-drift guard (2026-07-28) ─────────────────────
describe("OTP consensus for item sets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolveOtpConsensusForSets reads /api/otp and returns item frequencies", async () => {
    const { OTP_CONSENSUS_MIN_GAMES } = await import("../hextech/consensusArtifact");
    const otpGames = Array.from({ length: OTP_CONSENSUS_MIN_GAMES }, (_, gameIndex) => ({
      ...PRO_GAME(3031),
      id: `otp-${gameIndex}`,
    }));
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/otp", { games: otpGames, players: [], pending: false }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveOtpConsensusForSets } = await import("../hextech/itemSetsApply");
    const result = await resolveOtpConsensusForSets(CHAMP, "bot", "16.13");
    expect(result).not.toBeNull();
    expect(result!.items.some((i) => i.itemId === 3031)).toBe(true);
  });

  it("returns null — never throws — for a champion with no ingested one-tricks", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/otp", { games: [], players: [], pending: true }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveOtpConsensusForSets } = await import("../hextech/itemSetsApply");
    expect(await resolveOtpConsensusForSets(CHAMP, "bot", "16.13")).toBeNull();
  });

  it("QUERY-DRIFT GUARD: the item-set export's /api/pros call carries the pro-play floor", async () => {
    // This module performs a SECOND, independent /api/pros aggregation for the
    // LCU export. In v0.70.0 the card was fixed to limit=200&proMin=100 and
    // this path was not, so the "Pro build" line users got IN THEIR SHOP stayed
    // ~96% solo queue while the card beside it read 88 pro-play games. Pin the
    // parameters here so the two copies cannot silently diverge again.
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string, ...rest: unknown[]) => {
      seen.push(String(url));
      return routedFetch([
        ["/api/pros", { games: [PRO_GAME(3031)] }],
        ["/api/otp", { games: [], players: [], pending: false }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])(url, ...(rest as []));
    });
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    await resolveProConsensusForSets(CHAMP, "bot", "16.13");
    const prosCall = seen.find((u) => u.includes("/api/pros"));
    expect(prosCall).toBeDefined();
    expect(prosCall).toContain("proMin=100");
    expect(prosCall).toContain("limit=200");
  });
});

// ── "no data" vs "the query FAILED" (2026-08-20 Neon outage) ────────────────
//
// WHAT HAPPENED. The shared Neon Free-plan compute quota was exhausted at
// 07:57 UTC by a scheduled walk running at an ~89% duty cycle. Neon started
// answering 402; `/api/pros` and `/api/otp` caught the driver error and
// answered 500; both resolvers here ended in `catch { return null }`;
// `buildItemSets` reads `pro: null` as "this champion has no pro data and the
// block should be omitted". Result: every export silently shipped without its
// Pro and OTP blocks, and the only signal ANYWHERE in the system — no server
// alert, no client log, nothing on the wire — was the user eventually
// noticing two missing blocks in their in-game shop panel.
//
// These tests pin the distinction that was missing. The bar is not "does it
// cope" (it always coped, that was the problem) — it is "can something
// downstream TELL THE TWO CASES APART". Each test below therefore asserts
// both halves: the failure is visible, AND the genuinely-empty case stays
// quiet, because a diagnostic that fires on every unpopulated champion is
// noise and would be tuned out within a day.
describe("consensus failure is distinguishable from consensus absence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `jsonResponse` above models ok/not-ok but carries no status, and the
   *  status is the whole point here — a reader has to be able to see 500
   *  (our API's translation of Neon's 402) rather than a bare "it failed". */
  function statusResponse(status: number) {
    return { ok: false, status, json: async () => ({ error: "Internal server error" }) };
  }

  /** The exact outage: /api/pros and /api/otp both 500, item metadata (a
   *  separate CDN, unaffected) still fine. */
  function outageFetch() {
    return vi.fn(async (url: string) => {
      if (url.startsWith("/api/pros") || url.startsWith("/api/otp")) return statusResponse(500);
      if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
      return jsonResponse({}, false);
    });
  }

  it("THE BUG: a 500 from /api/pros resolves as a FAILURE, not as an empty sample", async () => {
    vi.stubGlobal("fetch", outageFetch());
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveProConsensus(CHAMP, "bot", "16.13");
    expect(res.data).toBeNull();
    expect(res.failure).not.toBeNull();
    expect(res.failure).toMatchObject({ source: "pro", kind: "http", status: 500 });
    // The status must survive into the human-readable message too -- a reader
    // staring at companion.log needs the number, not just "it failed".
    expect(res.failure!.message).toContain("500");
    expect(res.failure!.message).toContain("/api/pros");
  });

  it("THE OTHER HALF: a genuinely empty sample resolves with NO failure", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [] }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveProConsensus(CHAMP, "bot", "16.13");
    expect(res.data).toBeNull();
    // Same `data: null` as the test above, DIFFERENT `failure`. That is the
    // entire fix in one assertion.
    expect(res.failure).toBeNull();
  });

  it("a sample that aggregates to nothing is absence, not failure", async () => {
    // Every game carries only the allowlisted starter, which the support/
    // starter partition carves out -- so items and boots both come back empty
    // from a query that worked perfectly. Must not be reported as an outage.
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [PRO_GAME(1054), PRO_GAME(1054)] }],
        ["https://cdn.coachless.gg", { type: "item", version: "16.13.1", data: {} }],
      ])
    );
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveProConsensus(CHAMP, "bot", "16.13");
    expect(res.data).toBeNull();
    expect(res.failure).toBeNull();
  });

  it("a thrown fetch classifies as `network`, not `http` — offline is not an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const { resolveOtpConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveOtpConsensus(CHAMP, "bot", "16.13");
    expect(res.data).toBeNull();
    expect(res.failure).toMatchObject({ source: "otp", kind: "network" });
    expect(res.failure!.status).toBeUndefined();
    expect(res.failure!.message).toContain("Failed to fetch");
  });

  it("the OTP path is failure-aware too — the outage took BOTH blocks", async () => {
    vi.stubGlobal("fetch", outageFetch());
    const { resolveOtpConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveOtpConsensus(CHAMP, "bot", "16.13");
    expect(res.failure).toMatchObject({ source: "otp", kind: "http", status: 500 });
    expect(res.failure!.message).toContain("/api/otp");
  });

  it("warns to the console on failure, and says WHICH BLOCK the user lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", outageFetch());
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    await resolveProConsensus(CHAMP, "bot", "16.13");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    // Naming the BLOCK, not just the endpoint, is what connects the user's
    // report ("my Pro build block is gone") to the cause ("/api/pros 500").
    expect(line).toContain("Pro build");
    expect(line).toContain("500");
    // And it must say, in words, that this is not an empty champion.
    expect(line).toMatch(/FAILED/);
  });

  it("stays SILENT for a champion that genuinely has no data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      routedFetch([
        ["/api/pros", { games: [] }],
        ["https://cdn.coachless.gg", ITEM_JSON_FIXTURE],
      ])
    );
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    await resolveProConsensus(CHAMP, "bot", "16.13");
    expect(warn).not.toHaveBeenCalled();
  });

  it("records the failure in the /live-setup ring buffer, classified by status", async () => {
    // The channel the user can actually reach from the machine they play on,
    // with no PowerShell and no log files -- the constraint that made the
    // v0.43.0 companion failures so hard to diagnose.
    //
    // Stub `window`, not `localStorage`: companionClient's safeLocalStorage
    // gates on `typeof window === "undefined"` FIRST (it is imported by
    // server-rendered code and must no-op there), so a bare localStorage stub
    // is never even consulted in this node-env harness. Which is itself worth
    // stating: this channel is browser-only by design, and `console.warn` is
    // the one that fires unconditionally.
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", outageFetch());
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    await resolveProConsensus(CHAMP, "bot", "16.13");
    const entries = JSON.parse(store.get("coachbuild:companion:lastErrors:v1") ?? "[]");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("pro-consensus-http-500");
    expect(entries[0].detail).toContain("Pro build");
  });

  it("BACK-COMPAT: the old `...ForSets` wrappers still return null on failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", outageFetch());
    const { resolveProConsensusForSets, resolveOtpConsensusForSets } = await import("../hextech/itemSetsApply");
    expect(await resolveProConsensusForSets(CHAMP, "bot", "16.13")).toBeNull();
    expect(await resolveOtpConsensusForSets(CHAMP, "bot", "16.13")).toBeNull();
  });
});

// ── The signal crosses the wire (so it can reach companion.log) ────────────
describe("applyItemSetsForBuild — outage diagnostics on the apply body", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function bridgeFetch(consensusStatus: number | null, captured: { body?: string }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/pros") || url.startsWith("/api/otp")) {
        return consensusStatus === null
          ? jsonResponse({ games: [PRO_GAME(3031), PRO_GAME(3031)] })
          : { ok: false, status: consensusStatus, json: async () => ({ error: "Internal server error" }) };
      }
      if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
      if (url.includes("/apply-itemsets")) {
        captured.body = init?.body as string;
        return jsonResponse({ ok: true, count: 1 });
      }
      return jsonResponse({}, false);
    });
  }

  const APPLY_ARGS = {
    champ: CHAMP,
    lane: "bot" as const,
    roleLabel: "Bot",
    port: 48291 as const,
    session: "sess-diag",
  };

  it("POSTs a `diagnostics` line per block lost to a failed query", async () => {
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", bridgeFetch(500, captured));
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    await applyItemSetsForBuild({ ...APPLY_ARGS, build: baseBuild() });
    const parsed = JSON.parse(captured.body!);
    // Both consensus queries 500'd, so both blocks are missing for a reason
    // the bridge can now write to companion.log verbatim.
    expect(parsed.diagnostics).toHaveLength(2);
    expect(parsed.diagnostics.join("\n")).toContain("Pro build");
    expect(parsed.diagnostics.join("\n")).toContain("OTP build");
    expect(parsed.diagnostics.join("\n")).toContain("500");
  });

  it("omits the `diagnostics` KEY entirely when nothing failed", async () => {
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", bridgeFetch(null, captured));
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    await applyItemSetsForBuild({ ...APPLY_ARGS, build: baseBuild() });
    const parsed = JSON.parse(captured.body!);
    // Structural absence, same convention as `situational`: the happy path
    // must put NO new key on the wire, so an older bridge sees byte-identical
    // bodies to the ones it has always received.
    expect("diagnostics" in parsed).toBe(false);
  });

  it("GRACEFUL: the export still succeeds during a full consensus outage", async () => {
    // The non-negotiable half. Diagnosability must not have been bought by
    // making an outage fail the apply -- the user still gets their WPA and
    // Situational blocks, they just also get told why the other two are gone.
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", bridgeFetch(500, captured));
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    const result = await applyItemSetsForBuild({ ...APPLY_ARGS, build: baseBuild() });
    expect(result).toEqual({ ok: true, count: 1 });
    const parsed = JSON.parse(captured.body!);
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.championId).toBe(222);
  });

  it("a caller-supplied OTP line is not re-fetched and reports no OTP failure", async () => {
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", bridgeFetch(500, captured));
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    await applyItemSetsForBuild({
      ...APPLY_ARGS,
      build: baseBuild(),
      otp: { items: [{ itemId: 3031, share: 1 }], boots: [] },
    });
    const parsed = JSON.parse(captured.body!);
    // Only the pro query ran and failed. The card that handed us `otp` did its
    // own error handling, so inventing a second diagnostic for it would be a
    // lie about which query failed.
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toContain("Pro build");
    expect(parsed.diagnostics[0]).not.toContain("OTP build");
  });
});

describe("diagnostics - the other side of the wire actually reads it", () => {
  // SOURCE ASSERTIONS, in the pattern situationalItemSet.test.ts established
  // for the same reason: the bridge is C# and is not reachable from vitest,
  // this repo has two ecosystems, and a web-only change need never run
  // `dotnet test`. Without these, the field could go back to being written by
  // one side and dropped by the other with both suites green - which is
  // exactly the state it shipped in between 33785c7 and now.

  const read = (relative: string) =>
    fs.readFileSync(path.join(process.cwd(), relative), "utf8");

  it("the desktop request has somewhere to PUT the field", () => {
    const wire = read("desktop/src/CoachBuild.Core/WireContracts.cs");
    expect(wire).toMatch(/record ApplyItemSetsRequest\(/);
    expect(wire).toMatch(/JsonPropertyName\("diagnostics"\)\] JsonElement\? Diagnostics/);
    // RAW JsonElement, never string[]. A typed model throws inside
    // JsonSerializer.Deserialize on the first non-string member, which turns
    // the WHOLE request into default -- so a malformed diagnostic would fail
    // the item-set write it exists only to describe.
    expect(wire).not.toMatch(/diagnostics"\)\] (IReadOnlyList<string>|string\[\])/);
  });

  it("the desktop WRITES it, after the item-set write has already succeeded", () => {
    const service = read("desktop/src/CoachBuild.Core/ItemSetApplyService.cs");
    expect(service).toMatch(/RecordDiagnostics\(request\);/);
    expect(service).toMatch(/apply-itemsets: \{line\}/);
    // Position, not just presence. The call must sit after the PUT is checked
    // -- a successful export quietly missing a block is the case this exists
    // for, and a failed export is already loud.
    expect(service.indexOf("RecordDiagnostics(request);")).toBeGreaterThan(
      service.indexOf('return new ApplyItemSetsFailure("write-failed"')
    );
  });

  it("neither side may ever gate the field on a version", () => {
    // A diagnostic capable of failing an apply is worse than no diagnostic.
    const client = read("components/live/companionClient.ts");
    expect(client).toMatch(/diagnostics\?: string\[\]/);
    expect(client).not.toMatch(/diagnostics[\s\S]{0,200}companionVersion/);
    const apply = read("components/hextech/itemSetsApply.ts");
    expect(apply).toMatch(/\.\.\.\(diagnostics\.length > 0 \? \{ diagnostics \} : \{\}\)/);
  });

  it("the array is not only about blocks that were LOST, whatever the docs say", () => {
    // 56bbe6a added the precomputed-artifact fallback, so a live query can
    // fail and the block still ship -- and that case emits a line too. Both
    // HANDOFF-marco-neon-usage.md 3a and companionClient.ts's header still
    // describe this array as one line per DROPPED block. Pin the code, since
    // the desktop's log wording follows the sentence verbatim.
    const apply = read("components/hextech/itemSetsApply.ts");
    expect(apply).toMatch(/block SERVED FROM the precomputed patch-/);
    expect(apply).toMatch(/block OMITTED because the query FAILED/);
  });
});
