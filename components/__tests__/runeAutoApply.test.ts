import { describe, it, expect, vi } from "vitest";
import { shouldAutoApplyRunes, applyRunesForBuild, autoApplyRunesIfEligible } from "../hextech/runeAutoApply";
import type { RunesBlock, Pick } from "@/lib/types";

function pick(id: number): Pick {
  return { id, name: `Rune ${id}`, icon: `icon-${id}`, wpa: 0.02, winrate: 52, occurrence: 500 };
}

function baseRunes(): RunesBlock {
  return {
    primaryTree: { id: 8200, name: "Sorcery", icon: "t" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t" },
    keystone: pick(8214),
    primary: [pick(8226), pick(8210), pick(8237)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5008), flex: pick(5008), defense: pick(5001) },
  };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("shouldAutoApplyRunes — pure gate (shared with item-sets via autoExportShared)", () => {
  it("fires when deep-link/live-follow + toggle-on + session/port present + not yet applied", () => {
    expect(shouldAutoApplyRunes({ isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false })).toBe(true);
  });

  it("never fires with the toggle off", () => {
    expect(shouldAutoApplyRunes({ isDeepLink: true, autoEnabled: false, session: "s", port: 48291, alreadyFired: false })).toBe(false);
  });

  it("never fires with no session/port", () => {
    expect(shouldAutoApplyRunes({ isDeepLink: true, autoEnabled: true, session: null, port: 48291, alreadyFired: false })).toBe(false);
    expect(shouldAutoApplyRunes({ isDeepLink: true, autoEnabled: true, session: "s", port: null, alreadyFired: false })).toBe(false);
  });

  it("never fires when already applied for this championId", () => {
    expect(shouldAutoApplyRunes({ isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: true })).toBe(false);
  });
});

describe("applyRunesForBuild", () => {
  it("builds the rune body and POSTs with mode:'auto'", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonResponse({ ok: true, selected: true, verified: true, mismatch: [] });
    }) as unknown as typeof fetch;

    // applyRunesForBuild calls the real companionClient.applyRunes, which
    // uses the global fetch when no deps are injected -- stub it globally
    // for this one call (mirrors the pattern heroContracts.test.ts uses).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await applyRunesForBuild({
        championName: "Viktor",
        roleLabel: "Mid",
        runes: baseRunes(),
        port: 48291,
        session: "sess-1",
      });
      expect(result).toEqual({ ok: true, selected: true, verified: true, mismatch: [] });
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.mode).toBe("auto");
      expect(parsed.name).toBe("CoachBuild Viktor Mid");
      expect(parsed.selectedPerkIds).toHaveLength(9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("autoApplyRunesIfEligible — probe + apply orchestration", () => {
  it("does not attempt at all when the gate refuses (no build()/getStatus call)", async () => {
    const buildFn = vi.fn();
    const getStatusImpl = vi.fn();
    const applyFn = vi.fn();
    const outcome = await autoApplyRunesIfEligible(
      { isDeepLink: false, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: false });
    expect(buildFn).not.toHaveBeenCalled();
    expect(getStatusImpl).not.toHaveBeenCalled();
  });

  it("quietly no-ops when the companion probe fails -- never calls build()/applyFn", async () => {
    const buildFn = vi.fn();
    const getStatusImpl = vi.fn(async () => null);
    const applyFn = vi.fn();
    const outcome = await autoApplyRunesIfEligible(
      { isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: false });
    expect(buildFn).not.toHaveBeenCalled();
    expect(applyFn).not.toHaveBeenCalled();
  });

  it("attempts + applies via the SAME applyFn the manual button's path uses, when the probe succeeds", async () => {
    const params = { championName: "Viktor", roleLabel: "Mid", runes: baseRunes() };
    const buildFn = vi.fn(async () => params);
    const getStatusImpl = vi.fn(async () => ({
      version: "1.3.0",
      port: 48291,
      phase: "ChampSelect",
      clientConnected: true,
      lastOpen: null,
      champSelect: null,
      lastPollAt: null,
      lastError: null,
    }));
    const applyFn = vi.fn(async () => ({ ok: true as const, selected: true, verified: true, mismatch: [] as string[] }));
    const outcome = await autoApplyRunesIfEligible(
      { isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome).toEqual({ attempted: true, result: { ok: true, selected: true, verified: true, mismatch: [] } });
    expect(applyFn).toHaveBeenCalledWith({ ...params, port: 48291, session: "s" });
  });

  it("surfaces a slots-full result honestly (attempted:true, ok:false)", async () => {
    const buildFn = vi.fn(async () => ({ championName: "Viktor", roleLabel: "Mid", runes: baseRunes() }));
    const getStatusImpl = vi.fn(async () => ({
      version: "1.3.0",
      port: 48291,
      phase: "ChampSelect",
      clientConnected: true,
      lastOpen: null,
      champSelect: null,
      lastPollAt: null,
      lastError: null,
    }));
    const applyFn = vi.fn(async () => ({
      ok: false as const,
      reason: "slots-full",
      hint: "all rune pages are yours -- click Apply runes to replace the current one",
    }));
    const outcome = await autoApplyRunesIfEligible(
      { isDeepLink: true, autoEnabled: true, session: "s", port: 48291, alreadyFired: false },
      buildFn,
      { getStatusImpl, applyFn }
    );
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.reason).toBe("slots-full");
    }
  });
});
