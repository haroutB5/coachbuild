"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AutoExporter.tsx — the app-wide champ-select auto-exporter (v0.41.0).
//
// Mounted ONCE inside CompanionProvider (app/layout.tsx) so it reacts to the
// single app-wide /status poll on EVERY route — the whole point of the lift
// (see autoExport.ts's header for the bug this fixes: the exporter used to be
// anchored to BuildTabContent, which never mounts on /draft). This component
// owns only the imperative React glue: the per-tick trigger, the request-id
// generation counter that backs the identity guard, a cheap per-champion
// most-played-lane memo, the /api/build fetch, and the app-wide toast surface.
// All the actual decision/dedup/apply logic lives in autoExport.ts (pure,
// unit-tested) and the existing apply pipelines.
//
// Layout persistence is load-bearing: because this sits in the ROOT layout, it
// never unmounts across a client nav (/ <-> /draft), so its refs (gen counter,
// in-flight set, lane memo) survive the whole champ-select — the exact reason
// an app-wide mount works where a per-page one didn't.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { useCompanion } from "./CompanionProvider";
import {
  resolveAutoExportTarget,
  resolveTargetLane,
  executeAutoExport,
  inFlightKey,
  type AutoExportToast,
} from "./autoExport";
import { roleIdToLane } from "./deepLink";
import {
  getMostPlayedLane,
  LANE_TO_ROLE_ID,
  type LaneId,
} from "@/components/hextech/heroContracts";
import { readStoredRankBracketId } from "@/components/hextech/rankBracketStorage";
import { loadBuild } from "@/lib/buildCache";
import {
  getChampSelectPhaseEpoch,
  getCurrentChampSelectChampionId,
  isCompanionDrivenChampion,
  shouldAutoExportForLane,
  markAutoExported,
  tryClaimAutoExportLock,
  getLastAppliedSignalKey,
  observeFinalCompTick,
  decideFinalExport,
  noteFinalExportWritten,
  recordAutoExportDecision,
  formatBaselineExportLine,
  hasWrittenFinalExport,
} from "./champSelectFollowState";
import { resolveForThisGamePlan, forThisGameKey } from "@/lib/enemyComp/forThisGame";
import { MIN_ENEMIES_FOR_PLAN } from "@/lib/enemyComp/scenarios";
import { normalizeDraftEnemyIds } from "./draftLiveSync";
import {
  getStoredSession,
  getStoredPort,
  getAutoItemSetsEnabled,
  getAutoRunesEnabled,
} from "./companionClient";
import { autoApplyItemSetsIfEligible } from "@/components/hextech/itemSetsApply";
import { autoApplyRunesIfEligible } from "@/components/hextech/runeAutoApply";
import type { BuildResponse } from "@/lib/types";

/** The build for the champion being exported.
 *
 *  v0.111.0: this used to be the exporter's OWN /api/build fetch, byte-identical
 *  in URL to the one BuildTabContent fired at the same moment for the same
 *  champion — two requests, one answer. Both now go through lib/buildCache.ts,
 *  which dedupes them in flight and caches the result, so the exporter and the
 *  Builds page share a single round trip and a repeat champion costs none.
 *  Returns the #1 build ([0]) or null on 404/empty/any failure (never throws) —
 *  the exact contract executeAutoExport already depends on. */
async function fetchBuildFor(championId: number, laneId: LaneId): Promise<BuildResponse | null> {
  const outcome = await loadBuild(championId, LANE_TO_ROLE_ID[laneId], readStoredRankBracketId());
  return outcome.status === "ok" ? outcome.builds[0] : null;
}

export default function AutoExporter() {
  const companion = useCompanion();

  // Request-id generation counter (same idiom as app/page.tsx's
  // mostPlayedLaneRequestRef): bumped once per kicked-off run, so a run whose
  // async fetch resolves after a newer run started sees a mismatch and
  // discards itself — this is the mechanism behind the identity guard's
  // isStillCurrent below.
  const genRef = useRef(0);
  // Cheap guard against stacking concurrent runs for the SAME (champion, lane)
  // pair — keyed via inFlightKey(championId, knownLane), NOT championId alone.
  // AUDIT P1 FIX (2026-07-21 pre-ship audit): champion-only keying suppressed
  // the run for a same-champion LANE FLIP mid-fetch (position trade), so the
  // in-flight run's gen was never bumped, isStillCurrent stayed true, and the
  // OLD lane's runes/items were pushed — reaching the live game when the trade
  // landed inside the finalization window. Keying on (champion, lane) lets the
  // flipped lane start its own run, which bumps the gen and makes the stale
  // run discard itself before any push (the guard's documented contract).
  const inFlightRef = useRef<Set<string>>(new Set());
  // Per-champion most-played-lane memo (role-less path only) — the answer is
  // stable for a champion, so we resolve it once instead of running the
  // 5-call lookup on every 3s poll tick while the same champion is hovered.
  const laneCacheRef = useRef<Map<number, LaneId>>(new Map());

  const [itemsToast, setItemsToast] = useState<AutoExportToast | null>(null);
  const [runesToast, setRunesToast] = useState<AutoExportToast | null>(null);

  // Each toast self-clears 6s after it's (re)set. New toasts are fresh objects
  // so identity always changes -> the effect re-runs and the timer resets,
  // even when two consecutive toasts carry the same text.
  useEffect(() => {
    if (!itemsToast) return;
    const t = setTimeout(() => setItemsToast(null), 6000);
    return () => clearTimeout(t);
  }, [itemsToast]);
  useEffect(() => {
    if (!runesToast) return;
    const t = setTimeout(() => setRunesToast(null), 6000);
    return () => clearTimeout(t);
  }, [runesToast]);

  const onToast = useCallback((kind: "items" | "runes", toast: AutoExportToast) => {
    if (kind === "items") setItemsToast(toast);
    else setRunesToast(toast);
  }, []);

  useEffect(() => {
    if (!companion.statusFresh) return;
    const target = resolveAutoExportTarget(companion.phase, companion.champSelect);
    if (!target) return;
    const { championId, roleId } = target;

    // Resolve lane cheaply: role-bearing (ranked/draft) is instant; role-less
    // (Practice Tool / custom / ARAM) uses the memo, falling through to the
    // async most-played lookup inside the run below when not yet cached.
    const knownLane: LaneId | null =
      roleId !== undefined ? roleIdToLane(roleId) : laneCacheRef.current.get(championId) ?? null;

    // Don't stack a second run for the same (champion, lane) pair. Computed
    // AFTER knownLane so a lane flip produces a DIFFERENT key and is never
    // suppressed (see the inFlightRef comment above — audit P1).
    const flightKey = inFlightKey(championId, knownLane);
    if (inFlightRef.current.has(flightKey)) return;

    // Pre-dedup: when we already know the lane and nothing can possibly need
    // writing, skip the whole run - no fetch, no lookup. (When the lane is
    // still unknown we can't pre-check, so we let the run resolve it;
    // executeAutoExport re-checks the real dedup per kind.)
    //
    // 0.119.0 made this condition narrower, and it had to. Items are no longer
    // final once exported: the enemy comp completing can legitimately require a
    // second write. Asking `shouldAutoExportForLane("items", ...)` here would
    // need the signal key, which needs the build, which is the fetch this
    // pre-check exists to avoid. So the items leg skips on the one condition
    // under which no future comp change can matter either: the one permitted
    // comp-driven overwrite has already happened. Everything else falls through
    // to the full run, which is cheap because lib/buildCache.ts serves the
    // build from memory after the first tick.
    const itemsSettled =
      knownLane !== null &&
      getLastAppliedSignalKey("items", championId, knownLane) !== null &&
      hasWrittenFinalExport();
    if (
      knownLane !== null &&
      itemsSettled &&
      !shouldAutoExportForLane("runes", championId, knownLane, "none")
    ) {
      return;
    }

    let cancelled = false;
    inFlightRef.current.add(flightKey);
    const myGen = ++genRef.current;

    (async () => {
      try {
        let laneId = knownLane;
        if (laneId === null) {
          // Role-less with no cached lane — resolve via most-played lane
          // (Viktor -> mid). resolveTargetLane returns roleIdToLane for a
          // role-bearing target, but knownLane is only null when role-less, so
          // this always takes the async most-played path here.
          const best = await resolveTargetLane(target, getMostPlayedLane);
          if (genRef.current !== myGen) return; // superseded during the lookup
          if (!best) return; // no data anywhere -> can't resolve a lane, skip
          laneCacheRef.current.set(championId, best);
          laneId = best;
        }

        // -- The one comp-driven overwrite, and when it is allowed ------------
        // Derived from the build we are about to export, so the key describes
        // the actual export rather than an intention. Three steps, in this
        // order and no other: age the fallback stability window with the
        // CURRENT enemy list on every tick, ask whether the overwrite may
        // happen right now, and only then let the dedup stores see the new key.
        // Handing it straight to the dedup would make every hover a
        // whole-document LCU PUT, which is precisely what the trigger exists to
        // stop.
        const enemies = normalizeDraftEnemyIds(companion.champSelect?.theirTeam ?? []);
        const buildForSignal = await fetchBuildFor(championId, laneId);
        const liveKey = buildForSignal
          ? forThisGameKey(
              resolveForThisGamePlan({
                enemyChampionIds: enemies,
                championId,
                lane: laneId,
                items: buildForSignal.items,
              })
            )
          : "none";
        observeFinalCompTick(enemies);
        const lastKey = getLastAppliedSignalKey("items", championId, laneId);
        const decision = decideFinalExport({
          timerPhase: companion.champSelect?.timerPhase ?? null,
          enemyChampionIds: enemies,
        });
        // The BASELINE export is never gated. `lastKey === null` means nothing
        // has been written for this champion and lane yet, and delaying that
        // until finalization would leave the shop with no CoachBuild set at all
        // for most of the draft -- which is the whole reason the early export
        // exists. Once there IS a baseline, the trigger decides whether a
        // CHANGED key is allowed to be seen; when it refuses we hold the
        // PREVIOUS key, so the dedup store sees "nothing changed" and no write
        // happens. The trigger never forces a write.
        const itemsSignalKey = lastKey === null || decision.allow ? liveKey : lastKey;
        if (lastKey !== null && liveKey !== lastKey) {
          recordAutoExportDecision(
            `${championId}/${laneId}: ${decision.allow ? "FINAL EXPORT" : "hold"} - ${decision.reason}`
          );
        }

        await executeAutoExport(championId, laneId, {
          fetchBuild: fetchBuildFor,
          itemsSignalKey,
          // Identity guard: the run is still current iff (a) no newer run has
          // bumped the gen AND (b) the live champ-select champion still matches
          // this run's champion. A champion change mid-fetch fails (b); a
          // same-champion LANE flip mid-fetch starts its own run (inFlightKey
          // includes the lane) which bumps the gen, so this run fails (a) —
          // that gen bump is load-bearing, it is what discards the wrong-lane
          // build before any push (audit P1). laneId needs no direct check
          // here because every lane change is funnelled through the gen.
          isStillCurrent: (cid) => !cancelled && genRef.current === myGen && getCurrentChampSelectChampionId() === cid,
          isCompanionDriven: isCompanionDrivenChampion,
          epoch: getChampSelectPhaseEpoch(),
          autoItemSetsEnabled: getAutoItemSetsEnabled(),
          autoRunesEnabled: getAutoRunesEnabled(),
          session: getStoredSession(),
          port: getStoredPort(),
          shouldExportForLane: shouldAutoExportForLane,
          claimLock: tryClaimAutoExportLock,
          markExported: (kind, cid, lane, key) => {
            markAutoExported(kind, cid, lane, key);
            // The one permitted overwrite is spent only by a genuine
            // comp-driven RE-export: never by the first export for a champion
            // and lane (which is not gated), and never by runes, which are not
            // comp-conditioned at all.
            if (kind === "items" && lastKey !== null && key !== lastKey) {
              noteFinalExportWritten();
              recordAutoExportDecision(`${championId}/${laneId}: wrote item set with signal ${key}`);
            } else if (kind === "items" && lastKey === null) {
              // The baseline is the one write the trigger never sees. Record
              // what it went out with and what the comp looked like, or a
              // missing second write is undiagnosable from companion.log.
              recordAutoExportDecision(
                formatBaselineExportLine({
                  championId,
                  laneId,
                  signalKey: key,
                  enemyCount: enemies.length,
                  minEnemies: MIN_ENEMIES_FOR_PLAN,
                })
              );
            }
          },
          applyItemSets: autoApplyItemSetsIfEligible,
          applyRunes: autoApplyRunesIfEligible,
          onToast: (kind, toast) => {
            if (!cancelled) onToast(kind, toast);
          },
        });
      } finally {
        inFlightRef.current.delete(flightKey);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-evaluates on every poll tick (companion.tick), same cadence as the
    // page follow effect — champSelectFollowState's own dedup, not the effect
    // deps, decides what actually fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.tick, companion.statusFresh, onToast]);

  if (!itemsToast && !runesToast) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-4 z-[200] flex flex-col items-center gap-2 px-4 pointer-events-none"
      aria-live="polite"
    >
      {runesToast && (
        <p
          role="status"
          className={`pointer-events-auto max-w-md w-full sm:w-auto text-[11.5px] rounded-lg border px-3.5 py-2.5 shadow-lg bg-panel ${
            runesToast.kind === "success" ? "text-teal border-teal-dim" : "text-bad border-bad/40"
          }`}
        >
          {runesToast.message}
        </p>
      )}
      {itemsToast && (
        <p
          role="status"
          className={`pointer-events-auto max-w-md w-full sm:w-auto text-[11.5px] rounded-lg border px-3.5 py-2.5 shadow-lg bg-panel ${
            itemsToast.kind === "success" ? "text-teal border-teal-dim" : "text-bad border-bad/40"
          }`}
        >
          {itemsToast.message}
        </p>
      )}
    </div>
  );
}
