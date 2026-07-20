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
        // 1054 (Doran's Shield) is on the STARTING_ITEM_ALLOWLIST — counts even with no item.json metadata.
        ["https://cdn.coachless.gg", { type: "item", version: "16.13.1", data: {} }],
      ])
    );
    const { resolveProConsensusForSets } = await import("../hextech/itemSetsApply");
    const result = await resolveProConsensusForSets(CHAMP, "bot", "16.13");
    expect(result).not.toBeNull();
    expect(result!.items.some((i) => i.itemId === 1054)).toBe(true);
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

  it("builds sets (Core only, pro fetch empty) and POSTs to the bridge", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse({ type: "item", version: "16.13.1", data: {} });
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
    expect(parsed.sets).toHaveLength(1); // Core only -- pro fetch came back empty
    expect(parsed.sets[0].title).toBe("CoachBuild Jinx Bot — Core");
  });

  it("includes a Pro set when pro-consensus data resolves", async () => {
    let capturedBridgeBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/pros")) return jsonResponse({ games: [PRO_GAME(1054), PRO_GAME(1054)] });
        if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse({ type: "item", version: "16.13.1", data: {} });
        if (url.includes("/apply-itemsets")) {
          capturedBridgeBody = init?.body as string;
          return jsonResponse({ ok: true, count: 2 });
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
    expect(parsed.sets.map((s: { title: string }) => s.title)).toContain("CoachBuild Jinx Bot — Pro");
  });
});

describe("isAutoExportEligibleBuild — wrong-champion race guard (P1, Fable audit 2026-07-20)", () => {
  it("refuses a fallback build (Y) when the deep link names a different champion (X) — do not consume the ref", async () => {
    const { isAutoExportEligibleBuild } = await import("../hextech/itemSetsApply");
    // Deep link says championId=112 (X), but the build in hand is for 64 (Y, the page's fallback).
    expect(isAutoExportEligibleBuild({ championId: 112 }, 64)).toBe(false);
  });

  it("accepts once the build's champion matches the deep link (X) — fires exactly once", async () => {
    const { isAutoExportEligibleBuild } = await import("../hextech/itemSetsApply");
    expect(isAutoExportEligibleBuild({ championId: 112 }, 112)).toBe(true);
  });

  it("accepts any build when there's no deep link at all (nothing to race against)", async () => {
    const { isAutoExportEligibleBuild } = await import("../hextech/itemSetsApply");
    expect(isAutoExportEligibleBuild(null, 64)).toBe(true);
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
