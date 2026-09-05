/**
 * Tests for components/hextech/builds/applyActions.ts — the shared
 * implementation behind ChampionHero's IMPORT BUILD / APPLY RUNES pair,
 * ItemBuildCard's "Add to client" and the Runes card's "Apply runes".
 *
 * WHY THESE EXIST IN THIS SHAPE. The success path of both actions terminates in
 * the League client over a loopback bridge, so no browser check on a machine
 * without a paired client can observe it. What CAN be pinned here is that the
 * hero's buttons reach the same payload builder and the same companion call the
 * already-working controls reach, with the right arguments — which is exactly
 * the claim the hero fix rests on. Everything external is injected (this repo's
 * vitest harness is `environment: "node"`: no jsdom, no localStorage).
 */
import { describe, it, expect, vi } from "vitest";
import type { BuildResponse, ChampionRef, Pick, RunesBlock, ItemsBlock } from "@/lib/types";
import {
  applyBlockReason,
  applyLabel,
  applyRunesForBuild,
  importItemBuild,
  NOT_PAIRED_MESSAGE,
  type ApplyPhase,
} from "../applyActions";
import { buildRuneApplyBody } from "@/components/hextech/runeApplyBody";

const CHAMP: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "viktor.png" };

function pick(id: number): Pick {
  return { id, name: `Pick ${id}`, icon: `icon-${id}`, wpa: 0.01, winrate: 51, occurrence: 400 };
}

function runes(): RunesBlock {
  return {
    keystone: pick(8112),
    primaryTree: { id: 8100, name: "Domination", icon: "dom.png" },
    primary: [pick(8126), pick(8137), pick(8135)],
    secondaryTree: { id: 8200, name: "Sorcery", icon: "sorc.png" },
    secondary: [pick(8210), pick(8237)],
    shards: { offense: pick(5008), flex: pick(5008), defense: pick(5001) },
  };
}

function items(): ItemsBlock {
  return { starter: pick(1056), boots: pick(3020), first: pick(6653), second: pick(3089), third: pick(3157), fourthPlus: [] };
}

function build(overrides: Partial<BuildResponse> = {}): BuildResponse {
  return {
    champion: CHAMP,
    role: 3,
    roleLabel: "MIDDLE",
    patch: "16.14",
    tierLabel: "Diamond+",
    runes: runes(),
    items: items(),
    spells: [pick(4), pick(14)],
    generatedAt: "2026-08-11T00:00:00.000Z",
    sources: { provider: "coachless.gg" },
    ...overrides,
  } as BuildResponse;
}

/** A real COMPANION_PORTS member — companionClient types the port as that
 *  union, so an arbitrary number would not compile here (which is the point). */
const PAIRED = { getSession: () => "session-abc", getPort: () => 48291 as const };
const UNPAIRED = { getSession: () => null, getPort: () => null };

describe("applyRunesForBuild", () => {
  it("passes buildRuneApplyBody's exact payload to applyRunes, in manual mode", async () => {
    const applyRunesImpl = vi.fn(async () => ({ ok: true as const, selected: true, verified: true, mismatch: [] }));
    const b = build();

    const outcome = await applyRunesForBuild(b, { ...PAIRED, applyRunesImpl });

    expect(outcome).toEqual({ ok: true, message: "Applied in-client." });
    expect(applyRunesImpl).toHaveBeenCalledTimes(1);
    const [port, session, body, mode] = applyRunesImpl.mock.calls[0] as unknown as [number, string, unknown, string];
    expect(port).toBe(48291);
    expect(session).toBe("session-abc");
    expect(mode).toBe("manual");
    // The whole point: the hero's button and the Runes card's button build the
    // SAME LCU body, not two things that merely look alike.
    expect(body).toEqual(buildRuneApplyBody(b.champion.name, b.roleLabel, b.runes));
    expect((body as { selectedPerkIds: number[] }).selectedPerkIds).toEqual([
      8112, 8126, 8137, 8135, 8210, 8237, 5008, 5008, 5001,
    ]);
    expect((body as { name: string }).name).toBe("CoachBuild Viktor MIDDLE");
  });

  it("distinguishes 'created but not selected' from a full apply", async () => {
    const applyRunesImpl = vi.fn(async () => ({ ok: true as const, selected: false, verified: false, mismatch: [] }));
    const outcome = await applyRunesForBuild(build(), { ...PAIRED, applyRunesImpl });
    expect(outcome).toEqual({ ok: true, message: "Saved as a rune page — open the client to select it." });
  });

  it("surfaces the companion's own hint on failure", async () => {
    const applyRunesImpl = vi.fn(async () => ({ ok: false as const, reason: "lcu-down", hint: "League isn't running." }));
    const outcome = await applyRunesForBuild(build(), { ...PAIRED, applyRunesImpl });
    expect(outcome).toEqual({ ok: false, message: "League isn't running." });
  });

  it("never calls the companion when no session is stored", async () => {
    const applyRunesImpl = vi.fn();
    const outcome = await applyRunesForBuild(build(), { ...UNPAIRED, applyRunesImpl });
    expect(outcome).toEqual({ ok: false, message: NOT_PAIRED_MESSAGE });
    expect(applyRunesImpl).not.toHaveBeenCalled();
  });

  it("reports an unbuildable rune page instead of POSTing a malformed one", async () => {
    const applyRunesImpl = vi.fn();
    // buildRuneApplyBody throws on anything but 3 primary + 2 secondary — a
    // silently truncated page would write the WRONG runes in-client.
    const broken = build({ runes: { ...runes(), primary: [pick(8126)] } as RunesBlock });
    const outcome = await applyRunesForBuild(broken, { ...PAIRED, applyRunesImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome).toEqual({ ok: false, message: "Couldn't build a rune page from this build — try refreshing." });
    expect(applyRunesImpl).not.toHaveBeenCalled();
  });
});

describe("importItemBuild", () => {
  it("hands champ, lane, roleLabel, build and credentials to applyItemSetsForBuild", async () => {
    const applyItemSetsImpl = vi.fn(async () => ({ ok: true as const, count: 1 }));
    const b = build();

    const outcome = await importItemBuild({ champ: CHAMP, lane: "mid", build: b }, { ...PAIRED, applyItemSetsImpl });

    expect(outcome).toEqual({ ok: true, message: "Item build added — check your shop in game." });
    expect(applyItemSetsImpl).toHaveBeenCalledWith({
      champ: CHAMP,
      lane: "mid",
      roleLabel: "MIDDLE",
      build: b,
      port: 48291,
      session: "session-abc",
    });
  });

  it("surfaces the companion's hint on failure", async () => {
    const applyItemSetsImpl = vi.fn(async () => ({ ok: false as const, reason: "http-500", hint: "Client refused the set." }));
    const outcome = await importItemBuild({ champ: CHAMP, lane: "mid", build: build() }, { ...PAIRED, applyItemSetsImpl });
    expect(outcome).toEqual({ ok: false, message: "Client refused the set." });
  });

  it("never calls the companion when no session is stored", async () => {
    const applyItemSetsImpl = vi.fn();
    const outcome = await importItemBuild({ champ: CHAMP, lane: "mid", build: build() }, { ...UNPAIRED, applyItemSetsImpl });
    expect(outcome).toEqual({ ok: false, message: NOT_PAIRED_MESSAGE });
    expect(applyItemSetsImpl).not.toHaveBeenCalled();
  });
});

describe("applyBlockReason — the buttons must not claim they can act", () => {
  const base = { championName: "Viktor", laneLabel: "Support" };

  it("returns null only when a companion is paired AND a build resolved", () => {
    expect(applyBlockReason({ ...base, companionPaired: true, build: "ready" })).toBeNull();
  });

  it("blocks with a pairing reason when no companion is paired", () => {
    const reason = applyBlockReason({ ...base, companionPaired: false, build: "ready" });
    expect(reason).toMatch(/pair the coachbuild companion/i);
  });

  it("pairing outranks a missing build, so the actionable reason is the one shown", () => {
    const reason = applyBlockReason({ ...base, companionPaired: false, build: "unavailable" });
    expect(reason).toMatch(/pair the coachbuild companion/i);
  });

  it("names the champion and lane when the lane has no build data", () => {
    // The Viktor SUPPORT case: /api/build 404s, both actions are impossible,
    // and the old buttons responded to clicks by doing nothing at all.
    const reason = applyBlockReason({ ...base, companionPaired: true, build: "unavailable" });
    expect(reason).toBe("No build data for Viktor Support — there is nothing to import or apply.");
  });

  it("blocks while the build is still loading", () => {
    expect(applyBlockReason({ ...base, companionPaired: true, build: "loading" })).toBe("Loading this build…");
  });
});

describe("applyLabel", () => {
  const labels = { idle: "Import build", busy: "Importing…", done: "Imported" };
  const cases: [ApplyPhase, string][] = [
    [{ status: "idle" }, "Import build"],
    [{ status: "applying" }, "Importing…"],
    [{ status: "success", message: "ok" }, "Imported"],
    [{ status: "error", message: "no" }, "Retry"],
  ];
  it.each(cases)("%o -> %s", (phase, expected) => {
    expect(applyLabel(phase, labels)).toBe(expected);
  });
});
