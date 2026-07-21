import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveAutoExportTarget,
  resolveTargetLane,
  executeAutoExport,
  type AutoExportExecDeps,
} from "../live/autoExport";
import type { CompanionChampSelectSnapshot } from "../live/companionClient";
import {
  resetChampSelectFollowState,
  noteCompanionPhase,
  markCompanionDriven,
  setCurrentChampSelectChampionId,
  shouldAutoExportForLane,
  markAutoExported,
  tryClaimAutoExportLock,
  getChampSelectPhaseEpoch,
  isCompanionDrivenChampion,
} from "../live/champSelectFollowState";
import type { AutoApplyGateInput } from "../hextech/autoExportShared";
import type { AutoApplyOutcome } from "../hextech/itemSetsApply";
import type { AutoApplyRunesOutcome } from "../hextech/runeAutoApply";
import type { BuildResponse, RunesBlock } from "@/lib/types";

// ── Fixtures ─────────────────────────────────────────────────────────────
const VIKTOR = 112;
const AHRI = 103;

function champSelect(overrides: Partial<CompanionChampSelectSnapshot> = {}): CompanionChampSelectSnapshot {
  return {
    localPlayerCellId: 0,
    cellChampionId: VIKTOR,
    pickIntent: null,
    actionChampionId: null,
    roleId: null,
    theirTeam: [],
    timerPhase: null,
    ...overrides,
  };
}

function runes(): RunesBlock {
  return {
    primaryTree: { id: 8200, name: "Sorcery", icon: "t" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t" },
    keystone: { id: 8214, name: "Aery", icon: "i", wpa: 0.02, winrate: 52, occurrence: 500 },
    primary: [],
    secondary: [],
    shards: {
      offense: { id: 5008, name: "AF", icon: "i", wpa: 0, winrate: 50, occurrence: 1 },
      flex: { id: 5008, name: "AF", icon: "i", wpa: 0, winrate: 50, occurrence: 1 },
      defense: { id: 5001, name: "HP", icon: "i", wpa: 0, winrate: 50, occurrence: 1 },
    },
  };
}

/** A build whose resolved role matches `mid` (role 2) so isBuildForLane passes. */
function buildFor(championId: number, name = "Viktor"): BuildResponse {
  return {
    champion: { id: championId, key: name, name, icon: "icon" },
    role: 2, // mid
    roleLabel: "Mid",
    patch: "16.12",
    tierLabel: "High Elo",
    runes: runes(),
    spells: [],
    items: { starter: [], core: [], situational: [], boots: [] } as unknown as BuildResponse["items"],
    generatedAt: "2026-07-21T00:00:00Z",
    sources: { provider: "coachless.gg" },
  };
}

interface DepsHarness {
  deps: AutoExportExecDeps;
  itemGates: Array<{ autoEnabled: boolean; session: string | null; port: number | null }>;
  runeGates: Array<{ autoEnabled: boolean; session: string | null; port: number | null }>;
  toasts: Array<{ kind: "items" | "runes"; toast: { kind: string; message: string } }>;
  itemApply: ReturnType<typeof vi.fn>;
  runeApply: ReturnType<typeof vi.fn>;
}

/** Builds deps wired to the REAL champSelectFollowState dedup (so slot
 *  consumption is observable) with injectable apply spies + fetch + guard. */
function makeDeps(opts: {
  build?: BuildResponse | null;
  isStillCurrent?: boolean;
  autoItemSetsEnabled?: boolean;
  autoRunesEnabled?: boolean;
  session?: string | null;
  port?: number | null;
  /** apply outcome the spies return (defaults to a successful export). */
  itemOutcome?: AutoApplyOutcome;
  runeOutcome?: AutoApplyRunesOutcome;
  itemThrows?: boolean;
}): DepsHarness {
  const itemGates: DepsHarness["itemGates"] = [];
  const runeGates: DepsHarness["runeGates"] = [];
  const toasts: DepsHarness["toasts"] = [];

  const itemApply = vi.fn(async (gate: AutoApplyGateInput): Promise<AutoApplyOutcome> => {
    itemGates.push({ autoEnabled: gate.autoEnabled, session: gate.session, port: gate.port });
    if (opts.itemThrows) throw new Error("boom");
    return opts.itemOutcome ?? { attempted: true, result: { ok: true, count: 1 } };
  });

  const runeApply = vi.fn(async (gate: AutoApplyGateInput): Promise<AutoApplyRunesOutcome> => {
    runeGates.push({ autoEnabled: gate.autoEnabled, session: gate.session, port: gate.port });
    return opts.runeOutcome ?? { attempted: true, result: { ok: true, selected: true, verified: true, mismatch: [] } };
  });

  const deps: AutoExportExecDeps = {
    fetchBuild: async () => (opts.build === undefined ? buildFor(VIKTOR) : opts.build),
    isStillCurrent: () => opts.isStillCurrent ?? true,
    isCompanionDriven: isCompanionDrivenChampion,
    epoch: getChampSelectPhaseEpoch(),
    autoItemSetsEnabled: opts.autoItemSetsEnabled ?? true,
    autoRunesEnabled: opts.autoRunesEnabled ?? true,
    session: "session" in opts ? opts.session ?? null : "sess",
    port: "port" in opts ? opts.port ?? null : 48291,
    shouldExportForLane: shouldAutoExportForLane,
    claimLock: tryClaimAutoExportLock,
    markExported: markAutoExported,
    applyItemSets: itemApply,
    applyRunes: runeApply,
    onToast: (kind, toast) => toasts.push({ kind, toast }),
  };

  return { deps, itemGates, runeGates, toasts, itemApply, runeApply };
}

/** Puts the shared singleton into a live champ-select for `championId`. */
function enterChampSelect(championId: number) {
  noteCompanionPhase("ChampSelect");
  markCompanionDriven(championId);
  setCurrentChampSelectChampionId(championId);
}

beforeEach(() => {
  resetChampSelectFollowState();
});

// ── resolveAutoExportTarget (pure trigger) ─────────────────────────────────
describe("resolveAutoExportTarget", () => {
  it("returns null outside ChampSelect", () => {
    expect(resolveAutoExportTarget("InProgress", champSelect())).toBeNull();
    expect(resolveAutoExportTarget(null, champSelect())).toBeNull();
  });

  it("returns null when no champion has resolved yet", () => {
    expect(
      resolveAutoExportTarget("ChampSelect", champSelect({ cellChampionId: null, pickIntent: null, actionChampionId: null }))
    ).toBeNull();
  });

  it("resolves championId + roleId from a role-bearing snapshot (draft/ranked)", () => {
    const t = resolveAutoExportTarget("ChampSelect", champSelect({ cellChampionId: AHRI, roleId: 2 }));
    expect(t).toEqual({ championId: AHRI, roleId: 2 });
  });

  it("Practice Tool (null assignedPosition) resolves championId with roleId undefined", () => {
    const t = resolveAutoExportTarget("ChampSelect", champSelect({ cellChampionId: VIKTOR, roleId: null }));
    expect(t).toEqual({ championId: VIKTOR, roleId: undefined });
  });
});

// ── resolveTargetLane (null-role → most-played fallback) ────────────────────
describe("resolveTargetLane", () => {
  it("role-bearing target resolves instantly, never calls most-played", async () => {
    const getMostPlayed = vi.fn(async () => null);
    const lane = await resolveTargetLane({ championId: AHRI, roleId: 2 }, getMostPlayed);
    expect(lane).toBe("mid");
    expect(getMostPlayed).not.toHaveBeenCalled();
  });

  it("Practice-Tool null-role → most-played fallback (Viktor → mid)", async () => {
    const getMostPlayed = vi.fn(async (id: number) => (id === VIKTOR ? ("mid" as const) : null));
    const lane = await resolveTargetLane({ championId: VIKTOR, roleId: undefined }, getMostPlayed);
    expect(lane).toBe("mid");
    expect(getMostPlayed).toHaveBeenCalledWith(VIKTOR);
  });

  it("returns null when most-played can't resolve a lane (no data anywhere)", async () => {
    const lane = await resolveTargetLane({ championId: 9999, roleId: undefined }, async () => null);
    expect(lane).toBeNull();
  });
});

// ── executeAutoExport ──────────────────────────────────────────────────────
describe("executeAutoExport — fires independent of any page/route", () => {
  it("exports items + runes through the injected pipelines and marks the dedup slot", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({});
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);

    expect(res).toEqual({ items: "exported-ok", runes: "exported-ok" });
    expect(h.itemApply).toHaveBeenCalledTimes(1);
    expect(h.runeApply).toHaveBeenCalledTimes(1);
    // Slot consumed both kinds -> a second run for the SAME (champ,lane) dedups.
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(false);
    expect(shouldAutoExportForLane("runes", VIKTOR, "mid")).toBe(false);
    // Success toasts surfaced for both.
    expect(h.toasts.map((t) => t.kind).sort()).toEqual(["items", "runes"]);
  });

  it("skips entirely when the champion was never companion-driven", async () => {
    enterChampSelect(AHRI); // drives AHRI, not VIKTOR
    resetChampSelectFollowState(); // wipe driven set, keep nothing driven
    noteCompanionPhase("ChampSelect");
    const h = makeDeps({});
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);
    expect(res).toEqual({ items: "not-driven", runes: "not-driven" });
    expect(h.itemApply).not.toHaveBeenCalled();
    expect(h.runeApply).not.toHaveBeenCalled();
  });
});

describe("executeAutoExport — identity guard (champion change mid-FETCH)", () => {
  it("discards a stale build WITHOUT consuming any dedup slot", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({ isStillCurrent: false });
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);

    expect(res).toEqual({ items: "stale", runes: "stale" });
    // Never even attempted the apply pipelines.
    expect(h.itemApply).not.toHaveBeenCalled();
    expect(h.runeApply).not.toHaveBeenCalled();
    // CRITICAL: the dedup slot is UNTOUCHED — a later genuine run still fires.
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(true);
    expect(shouldAutoExportForLane("runes", VIKTOR, "mid")).toBe(true);

    // A subsequent run for the same (champ,lane), now current, exports for real.
    const h2 = makeDeps({});
    const res2 = await executeAutoExport(VIKTOR, "mid", h2.deps);
    expect(res2).toEqual({ items: "exported-ok", runes: "exported-ok" });
    expect(h2.itemApply).toHaveBeenCalledTimes(1);
  });
});

describe("executeAutoExport — latest-wins re-export (champion change)", () => {
  it("exports for A, then re-exports for a DIFFERENT champion B", async () => {
    enterChampSelect(VIKTOR);
    const hA = makeDeps({ build: buildFor(VIKTOR, "Viktor") });
    await executeAutoExport(VIKTOR, "mid", hA.deps);
    expect(hA.itemApply).toHaveBeenCalledTimes(1);
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(false);

    // Champion changes to Ahri (still mid) — latest-wins: fires again.
    markCompanionDriven(AHRI);
    setCurrentChampSelectChampionId(AHRI);
    const hB = makeDeps({ build: buildFor(AHRI, "Ahri") });
    const resB = await executeAutoExport(AHRI, "mid", hB.deps);
    expect(resB).toEqual({ items: "exported-ok", runes: "exported-ok" });
    expect(hB.itemApply).toHaveBeenCalledTimes(1);
    expect(shouldAutoExportForLane("items", AHRI, "mid")).toBe(false);
  });
});

describe("executeAutoExport — single-owner (Builds-page-open scenario)", () => {
  it("a second invocation for the SAME (champ,lane) dedups to a single export", async () => {
    enterChampSelect(VIKTOR);
    const h1 = makeDeps({});
    await executeAutoExport(VIKTOR, "mid", h1.deps);
    expect(h1.itemApply).toHaveBeenCalledTimes(1);

    // Second owner/invocation (e.g. an open Builds page in the OLD design) —
    // the shared dedup refuses it. Net: exactly one push.
    const h2 = makeDeps({});
    const res2 = await executeAutoExport(VIKTOR, "mid", h2.deps);
    expect(res2).toEqual({ items: "deduped", runes: "deduped" });
    expect(h2.itemApply).not.toHaveBeenCalled();
    expect(h2.runeApply).not.toHaveBeenCalled();
  });
});

describe("executeAutoExport — toggles respected + gate-refused leaves slot open", () => {
  it("passes the auto-toggle values straight into the pipeline gate", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({
      autoItemSetsEnabled: false,
      autoRunesEnabled: true,
      itemOutcome: { attempted: false },
      runeOutcome: { attempted: true, result: { ok: true, selected: true, verified: true, mismatch: [] } },
    });
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);

    // The item gate saw autoEnabled:false (toggle respected); rune gate true.
    expect(h.itemGates[0].autoEnabled).toBe(false);
    expect(h.runeGates[0].autoEnabled).toBe(true);
    // Item attempt refused by the gate -> slot LEFT OPEN (not marked); runes exported.
    expect(res.items).toBe("gate-refused");
    expect(res.runes).toBe("exported-ok");
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(true); // retryable
    expect(shouldAutoExportForLane("runes", VIKTOR, "mid")).toBe(false); // done
  });

  it("no session/port is plumbed through to the gate", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({ session: null, port: null, itemOutcome: { attempted: false }, runeOutcome: { attempted: false } });
    await executeAutoExport(VIKTOR, "mid", h.deps);
    expect(h.itemGates[0].session).toBeNull();
    expect(h.itemGates[0].port).toBeNull();
  });
});

describe("executeAutoExport — error hardening", () => {
  it("a thrown apply surfaces an error toast and still marks done (no retry storm)", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({ itemThrows: true });
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);
    expect(res.items).toBe("threw");
    const itemToast = h.toasts.find((t) => t.kind === "items");
    expect(itemToast?.toast.kind).toBe("error");
    // Marked done despite the throw — won't retry into the same exception.
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(false);
  });

  it("companion returned ok:false surfaces the hint as an error toast", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({
      runeOutcome: { attempted: true, result: { ok: false, reason: "slots-full", hint: "all rune pages are yours" } },
    });
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);
    expect(res.runes).toBe("exported-error");
    const runeToast = h.toasts.find((t) => t.kind === "runes");
    expect(runeToast?.toast).toEqual({ kind: "error", message: "all rune pages are yours" });
  });

  it("build fetch returning null yields no-data (no attempt)", async () => {
    enterChampSelect(VIKTOR);
    const h = makeDeps({ build: null });
    const res = await executeAutoExport(VIKTOR, "mid", h.deps);
    expect(res).toEqual({ items: "no-data", runes: "no-data" });
    expect(h.itemApply).not.toHaveBeenCalled();
  });
});

// ── Audit P1 regression (2026-07-21 pre-ship audit): same-champion LANE FLIP
// mid-fetch. With inFlightRef keyed on championId alone, the flipped lane's
// run was suppressed, the gen never bumped, and the OLD lane's build was
// pushed (could reach a live game on a late position trade). inFlightKey now
// includes the lane, so the flip starts a superseding run; this suite pins
// the exact wiring semantics: gen bump -> stale discard -> only the new
// lane's build is ever pushed.
import { inFlightKey } from "../live/autoExport";

describe("inFlightKey — lane is part of the in-flight identity (audit P1)", () => {
  it("keys the same champion differently per lane, with 'pending' for null", () => {
    expect(inFlightKey(VIKTOR, "top")).not.toBe(inFlightKey(VIKTOR, "mid"));
    expect(inFlightKey(VIKTOR, null)).toBe(`${VIKTOR}:pending`);
    // Different champions never collide even on the same lane.
    expect(inFlightKey(VIKTOR, "mid")).not.toBe(inFlightKey(AHRI, "mid"));
  });
});

describe("executeAutoExport — same-champion lane flip mid-FETCH (audit P1)", () => {
  it("gen bump from the flipped lane's run discards the old lane's build before any push", async () => {
    enterChampSelect(VIKTOR);

    // Mirror AutoExporter's wiring: one shared gen counter, one closure per run.
    const gen = { current: 0 };

    // Run 1: (Viktor, top) — its fetch is HELD so the flip lands mid-flight.
    const myGen1 = ++gen.current;
    let releaseTopFetch!: (b: BuildResponse | null) => void;
    const heldTopFetch = new Promise<BuildResponse | null>((r) => (releaseTopFetch = r));
    const h1 = makeDeps({});
    h1.deps.fetchBuild = () => heldTopFetch;
    h1.deps.isStillCurrent = (cid) => gen.current === myGen1 && cid === VIKTOR;
    const p1 = executeAutoExport(VIKTOR, "top", h1.deps);

    // Lane flips to mid while run 1's fetch is in flight. Under the NEW
    // keying (inFlightKey includes the lane) this run is NOT suppressed —
    // it starts and bumps the gen. (Champion-only keying would have blocked
    // exactly this, leaving myGen1 current: the bug.)
    const myGen2 = ++gen.current;
    const h2 = makeDeps({ build: { ...buildFor(VIKTOR), role: 2, roleLabel: "Mid" } });
    h2.deps.isStillCurrent = (cid) => gen.current === myGen2 && cid === VIKTOR;
    const p2 = executeAutoExport(VIKTOR, "mid", h2.deps);

    // Run 1's TOP build finally resolves — must be discarded at consume time.
    releaseTopFetch({ ...buildFor(VIKTOR), role: 0, roleLabel: "Top" });
    const res1 = await p1;
    const res2 = await p2;

    expect(res1).toEqual({ items: "stale", runes: "stale" });
    // The old lane's build was never pushed anywhere.
    expect(h1.itemApply).not.toHaveBeenCalled();
    expect(h1.runeApply).not.toHaveBeenCalled();
    // The flipped lane exported exactly once.
    expect(res2).toEqual({ items: "exported-ok", runes: "exported-ok" });
    expect(h2.itemApply).toHaveBeenCalledTimes(1);
    expect(h2.runeApply).toHaveBeenCalledTimes(1);
    // Dedup ledger: top slot untouched (a genuine later top run may fire),
    // mid slot consumed by run 2.
    expect(shouldAutoExportForLane("items", VIKTOR, "top")).toBe(true);
    expect(shouldAutoExportForLane("items", VIKTOR, "mid")).toBe(false);
  });
});
