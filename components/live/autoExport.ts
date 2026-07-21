// ─────────────────────────────────────────────────────────────────────────────
// autoExport.ts — champ-select auto-export decision logic + effect body,
// LIFTED to the app-wide companion layer (v0.41.0).
//
// WHY THIS EXISTS (the bug it fixes): auto-export used to be mounted ONLY in
// components/hextech/BuildTabContent.tsx — it fired when the BUILDS PAGE ("/")
// loaded a build. Since companion 1.5.0, follow-capable tabs (/ and /draft)
// suppress opening the Builds page, and a user who drafts from /draft never
// mounts BuildTabContent at all, so NOTHING ever fetched the picked
// champion's build and nothing exported (real user report: picked Viktor in a
// Practice Tool, in-client rune page stayed on a previous game's "CoachBuild
// Nasus Jungle"). The whole champ-select side-effect chain was implicitly
// anchored to the Builds page being open.
//
// This module is the ROUTE-INDEPENDENT replacement: components/live/
// AutoExporter.tsx mounts it inside CompanionProvider (app/layout.tsx), so it
// fires off the SAME app-wide /status poll regardless of which CoachBuild page
// is open. BuildTabContent's own auto-export wiring is REMOVED in the same
// change — exactly one owner, so an open Builds page can never double-push.
//
// Split for testability (repo convention — pure logic in .ts, no JSX/React):
//   - resolveAutoExportTarget(): pure "given the live champ-select snapshot,
//     what champion+role should we consider exporting for."
//   - executeAutoExport(): the async effect BODY (fetch build -> identity
//     guard -> dedup -> apply -> mark -> toast), every collaborator injected
//     via `deps` so the identity-guard / dedup / toggle behavior is unit-
//     testable without mounting React or hitting a network.
//
// It REUSES, never re-implements:
//   - champ-select champion/role resolution (champSelectFollow.ts's
//     resolveCurrentChampSelectChampionId / resolveChampSelectRoleId — the
//     same 3-way cellChampionId->pickIntent->actionChampionId priority the
//     page follow + companion.ps1 use),
//   - the dedup/ownership machinery (champSelectFollowState.ts: latest-wins
//     (championId,laneId) per kind, the v0.34 multi-tab localStorage lock,
//     markAutoExported deferred until AFTER an attempt),
//   - the SAME apply pipelines the manual Apply buttons use
//     (autoApplyItemSetsIfEligible / autoApplyRunesIfEligible).
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse, ChampionRef, RunesBlock } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import { isBuildForLane } from "@/components/hextech/heroContracts";
import { roleIdToLane, type LiveRoleId } from "./deepLink";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "./champSelectFollow";
import type { CompanionChampSelectSnapshot } from "./companionClient";
import type { AutoExportKind } from "./champSelectFollowState";
import type { AutoApplyGateInput } from "@/components/hextech/autoExportShared";
import type { AutoApplyOutcome } from "@/components/hextech/itemSetsApply";
import type { AutoApplyRunesOutcome } from "@/components/hextech/runeAutoApply";

/** The champion+role the live champ-select session currently resolves to —
 *  the LOCAL player's own pick (champSelectFollow.ts's 3-way resolution). */
export interface AutoExportTarget {
  championId: number;
  /** Undefined when champ-select carries no assigned position (Practice Tool,
   *  custom lobby, blind pick, ARAM) — the caller falls back to most-played
   *  lane, same policy the role-less deep-link flow already uses. */
  roleId: LiveRoleId | undefined;
}

/** Pure: what should we consider auto-exporting for THIS status tick? Returns
 *  null outside ChampSelect or before the local player's champion resolves. */
export function resolveAutoExportTarget(
  phase: string | null,
  champSelect: CompanionChampSelectSnapshot | null
): AutoExportTarget | null {
  if (phase !== "ChampSelect") return null;
  const championId = resolveCurrentChampSelectChampionId(champSelect);
  if (championId === null) return null;
  return { championId, roleId: resolveChampSelectRoleId(champSelect) };
}

/** Resolve the lane to export for. Role-bearing (ranked/draft) is instant
 *  (roleIdToLane); role-less (Practice Tool — the exact user case — custom,
 *  ARAM) falls back to the champion's most-played lane, the SAME policy the
 *  role-less deep-link flow uses (Viktor -> mid). Returns null only when even
 *  most-played can't resolve a lane (a brand-new champion with no data
 *  anywhere) — the caller then simply skips, since /api/build would 404 too. */
export async function resolveTargetLane(
  target: AutoExportTarget,
  getMostPlayed: (championId: number) => Promise<LaneId | null>
): Promise<LaneId | null> {
  if (target.roleId !== undefined) return roleIdToLane(target.roleId);
  return getMostPlayed(target.championId);
}

export interface AutoExportToast {
  kind: "success" | "error";
  message: string;
}

/** Per-kind terminal outcome — surfaced for tests/telemetry so the identity
 *  guard ("stale") and dedup ("deduped") vs a real gate refusal
 *  ("gate-refused", slot left open) vs a genuine export are distinguishable. */
export type AutoExportKindResult =
  | "stale" //         superseded before consume-time — NO dedup slot consumed
  | "no-data" //       build fetch returned null/empty, or role/lane mismatch
  | "not-driven" //    championId was never a real companion signal
  | "deduped" //       shouldExportForLane false, or lock claim lost
  | "gate-refused" //  pipeline attempted:false (no session/port, toggle off) — slot left OPEN
  | "exported-ok"
  | "exported-error" // companion reached, returned ok:false
  | "threw"; //        uncaught exception in the attempt — surfaced as a toast, marked done

export interface AutoExportResult {
  items: AutoExportKindResult;
  runes: AutoExportKindResult;
}

export interface AutoExportExecDeps {
  /** Fetch the #1 build for (championId, laneId) — /api/build, [0]. Returns
   *  null on 404 / empty / any failure. Owned by the caller so the identity
   *  guard below runs at CONSUME time (after this resolves), not fetch-start. */
  fetchBuild: (championId: number, laneId: LaneId) => Promise<BuildResponse | null>;
  /** Identity guard (the v0.36 stale-closure lesson, non-negotiable): is
   *  (championId, laneId) STILL the currently-resolved champ-select target at
   *  the moment the fetch resolved? A champion change mid-fetch returns false
   *  here so the stale build is discarded WITHOUT touching any dedup slot. */
  isStillCurrent: (championId: number, laneId: LaneId) => boolean;
  isCompanionDriven: (championId: number) => boolean;
  epoch: number;
  autoItemSetsEnabled: boolean;
  autoRunesEnabled: boolean;
  session: string | null;
  port: number | null;
  shouldExportForLane: (kind: AutoExportKind, championId: number, laneId: LaneId) => boolean;
  claimLock: (kind: AutoExportKind, epoch: number, championId: number, laneId: LaneId) => boolean;
  markExported: (kind: AutoExportKind, championId: number, laneId: LaneId) => void;
  applyItemSets: (
    gate: AutoApplyGateInput,
    build: () => Promise<{ champ: ChampionRef; lane: LaneId; roleLabel: string; build: BuildResponse }>
  ) => Promise<AutoApplyOutcome>;
  applyRunes: (
    gate: AutoApplyGateInput,
    build: () => Promise<{ championName: string; roleLabel: string; runes: RunesBlock }>
  ) => Promise<AutoApplyRunesOutcome>;
  onToast: (kind: AutoExportKind, toast: AutoExportToast) => void;
}

/** The async effect body. fetch -> identity guard -> (items ‖ runes:
 *  dedup -> lock -> apply -> mark -> toast). Mirrors the old BuildTabContent
 *  effect's item/rune blocks 1:1 (including "gate refused leaves the slot
 *  open" and "catch marks-done + error toast"), with the ONE addition the
 *  lift requires: the post-fetch identity guard, since this layer fetches its
 *  own build instead of reading a component's already-guarded state. */
export async function executeAutoExport(
  championId: number,
  laneId: LaneId,
  deps: AutoExportExecDeps
): Promise<AutoExportResult> {
  const build = await deps.fetchBuild(championId, laneId);

  // Identity guard FIRST (consume-time, not fetch-start). A champion (or lane)
  // change mid-fetch discards the stale build here, before any dedup slot or
  // multi-tab lock is ever touched — "stale build discarded, slot not
  // consumed." Keyed on the run's own (champion, lane) identity vs the live
  // champ-select resolution.
  if (!deps.isStillCurrent(championId, laneId)) {
    return { items: "stale", runes: "stale" };
  }
  if (!build) {
    return { items: "no-data", runes: "no-data" };
  }
  // Defense-in-depth: the fetched build's own resolved role must agree with
  // the lane we fetched for (it always should — we built the request from
  // laneId's role — but never export a mismatched pair, same invariant
  // isBuildForLane enforced in the old effect).
  if (!isBuildForLane(build.role, laneId)) {
    return { items: "no-data", runes: "no-data" };
  }
  // Wrong-champion race guard: only export against a champion actually reached
  // via a companion signal (CompanionProvider marks the live champ-select
  // champion every tick), never a transient fallback render.
  if (!deps.isCompanionDriven(championId)) {
    return { items: "not-driven", runes: "not-driven" };
  }

  const [items, runes] = await Promise.all([
    exportItems(championId, laneId, build, deps),
    exportRunes(championId, laneId, build, deps),
  ]);
  return { items, runes };
}

async function exportItems(
  championId: number,
  laneId: LaneId,
  build: BuildResponse,
  deps: AutoExportExecDeps
): Promise<AutoExportKindResult> {
  if (!deps.shouldExportForLane("items", championId, laneId)) return "deduped";
  if (!deps.claimLock("items", deps.epoch, championId, laneId)) return "deduped";
  try {
    const outcome = await deps.applyItemSets(
      {
        isDeepLink: true,
        autoEnabled: deps.autoItemSetsEnabled,
        session: deps.session,
        port: deps.port,
        alreadyFired: false,
      },
      async () => ({ champ: build.champion, lane: laneId, roleLabel: build.roleLabel, build })
    );
    // Gate refused (not yet connected / toggle off) — quiet, no toast, dedup
    // slot LEFT OPEN for a later genuine attempt (matches the old effect).
    if (!outcome.attempted) return "gate-refused";
    deps.markExported("items", championId, laneId);
    if (outcome.result.ok) {
      deps.onToast("items", {
        kind: "success",
        message: `Item build added for ${build.champion.name} — check your shop in game.`,
      });
      return "exported-ok";
    }
    deps.onToast("items", {
      kind: "error",
      message: outcome.result.hint ?? "Couldn't auto-add item builds — add them manually from the Runes & Summoners card.",
    });
    return "exported-error";
  } catch {
    // v0.35 lesson: an uncaught rejection must surface a visible error, never
    // vanish silently. Still counts as a completed attempt (marked done) so it
    // doesn't retry into the same exception every tick.
    deps.markExported("items", championId, laneId);
    deps.onToast("items", {
      kind: "error",
      message: "Couldn't auto-add item builds — add them manually from the Runes & Summoners card.",
    });
    return "threw";
  }
}

async function exportRunes(
  championId: number,
  laneId: LaneId,
  build: BuildResponse,
  deps: AutoExportExecDeps
): Promise<AutoExportKindResult> {
  if (!deps.shouldExportForLane("runes", championId, laneId)) return "deduped";
  if (!deps.claimLock("runes", deps.epoch, championId, laneId)) return "deduped";
  try {
    const outcome = await deps.applyRunes(
      {
        isDeepLink: true,
        autoEnabled: deps.autoRunesEnabled,
        session: deps.session,
        port: deps.port,
        alreadyFired: false,
      },
      async () => ({ championName: build.champion.name, roleLabel: build.roleLabel, runes: build.runes })
    );
    if (!outcome.attempted) return "gate-refused";
    deps.markExported("runes", championId, laneId);
    if (outcome.result.ok) {
      const r = outcome.result;
      deps.onToast("runes", {
        kind: "success",
        message:
          r.selected && r.verified
            ? `Runes applied for ${build.champion.name}.`
            : `Runes saved for ${build.champion.name} — open the client to select the page.`,
      });
      return "exported-ok";
    }
    deps.onToast("runes", {
      kind: "error",
      message: outcome.result.hint ?? "Couldn't auto-apply runes — use the Apply runes button instead.",
    });
    return "exported-error";
  } catch {
    deps.markExported("runes", championId, laneId);
    deps.onToast("runes", {
      kind: "error",
      message: "Couldn't auto-apply runes — use the Apply runes button instead.",
    });
    return "threw";
  }
}
