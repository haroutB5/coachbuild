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
    tierLabel: "High Elo",
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

  it("builds ONE set (Core build + Highest WPA, pro fetch empty) and POSTs to the bridge", async () => {
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
    // full AD spread is considered. Of it, only Lethality/Assassin (the 3
    // caster-AD Damage items -> MEASURED) and Crit/Marksman (the 1 crit item
    // -> "(low data)" fill) actually resolve; Bruiser (no durable-AD item) and
    // On-hit (its only AttackSpeed item is boots) correctly stay omitted. NO
    // AP line ever appears (cross-family exclusion). Confirms real ItemDetail
    // tags threaded through applyItemSetsForBuild drive family-scoped archetype
    // emission end to end.
    expect(parsed.sets[0].blocks.map((b: { type: string }) => b.type)).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
      "Lethality/Assassin",
      "Crit/Marksman (low data)",
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
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [PRO_GAME(3031), PRO_GAME(3031)] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON_FIXTURE);
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
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0].blocks.map((b: { type: string }) => b.type)).toContain("Pro build");
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
    const core = parsed.sets[0].blocks.find((b: { type: string }) => b.type === "Core build");
    expect(core.items).toEqual([]); // every id unknown -- excluded, never an unfiltered/invented item
    expect(parsed.sets[0].blocks.map((b: { type: string }) => b.type)).not.toContain("Highest WPA"); // pool size 0
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
