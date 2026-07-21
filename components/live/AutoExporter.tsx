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
  type AutoExportToast,
} from "./autoExport";
import { roleIdToLane } from "./deepLink";
import {
  getMostPlayedLane,
  LANE_TO_ROLE_ID,
  type LaneId,
} from "@/components/hextech/heroContracts";
import { readStoredRankBracketId } from "@/components/hextech/rankBracketStorage";
import { DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";
import {
  getChampSelectPhaseEpoch,
  getCurrentChampSelectChampionId,
  isCompanionDrivenChampion,
  shouldAutoExportForLane,
  markAutoExported,
  tryClaimAutoExportLock,
} from "./champSelectFollowState";
import {
  getStoredSession,
  getStoredPort,
  getAutoItemSetsEnabled,
  getAutoRunesEnabled,
} from "./companionClient";
import { autoApplyItemSetsIfEligible } from "@/components/hextech/itemSetsApply";
import { autoApplyRunesIfEligible } from "@/components/hextech/runeAutoApply";
import type { BuildResponse } from "@/lib/types";

/** The exporter's OWN /api/build fetch — the reference is BuildTabContent's
 *  load(): same endpoint/params, same "rank only appended when non-default so
 *  the historical default request stays byte-identical" rule, honoring the
 *  user's persisted rank-bracket preference so the exported build matches what
 *  they'd see on the Builds page. Returns the #1 build ([0]) or null on
 *  404/empty/any failure (never throws). */
async function fetchBuildFor(championId: number, laneId: LaneId): Promise<BuildResponse | null> {
  try {
    const roleId = LANE_TO_ROLE_ID[laneId];
    const rank = readStoredRankBracketId();
    const rankParam = rank && rank !== DEFAULT_RANK_BRACKET.id ? `&rank=${rank}` : "";
    const res = await fetch(`/api/build?champ=${championId}&role=${roleId}${rankParam}`);
    if (!res.ok) return null; // 404 (no data) or any non-2xx
    const data = (await res.json()) as BuildResponse[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0];
  } catch {
    return null;
  }
}

export default function AutoExporter() {
  const companion = useCompanion();

  // Request-id generation counter (same idiom as app/page.tsx's
  // mostPlayedLaneRequestRef): bumped once per kicked-off run, so a run whose
  // async fetch resolves after a newer run started sees a mismatch and
  // discards itself — this is the mechanism behind the identity guard's
  // isStillCurrent below.
  const genRef = useRef(0);
  // Cheap guard against stacking concurrent runs for the SAME champion (keyed
  // on championId — a DIFFERENT champion is never blocked, so a real
  // champion-change-mid-fetch still kicks off its own run and bumps the gen,
  // discarding the older one).
  const inFlightRef = useRef<Set<number>>(new Set());
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
    const target = resolveAutoExportTarget(companion.phase, companion.champSelect);
    if (!target) return;
    const { championId, roleId } = target;
    // Don't stack a second run for a champion already mid-run.
    if (inFlightRef.current.has(championId)) return;

    // Resolve lane cheaply: role-bearing (ranked/draft) is instant; role-less
    // (Practice Tool / custom / ARAM) uses the memo, falling through to the
    // async most-played lookup inside the run below when not yet cached.
    const knownLane: LaneId | null =
      roleId !== undefined ? roleIdToLane(roleId) : laneCacheRef.current.get(championId) ?? null;

    // Pre-dedup: when we already know the lane and BOTH kinds are already
    // exported for this (champion, lane), skip the whole run — no fetch, no
    // lookup. (When the lane is still unknown we can't pre-check, so we let the
    // run resolve it; executeAutoExport re-checks the real dedup per kind.)
    if (
      knownLane !== null &&
      !shouldAutoExportForLane("items", championId, knownLane) &&
      !shouldAutoExportForLane("runes", championId, knownLane)
    ) {
      return;
    }

    let cancelled = false;
    inFlightRef.current.add(championId);
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

        await executeAutoExport(championId, laneId, {
          fetchBuild: fetchBuildFor,
          // Identity guard: the run is still current iff (a) no newer run has
          // bumped the gen AND (b) the live champ-select champion still matches
          // this run's champion. Either check catches a champion-change-mid-
          // fetch; both are cheap. (Lane changes for the SAME champion are
          // caught by the per-lane dedup keying, not needed here.)
          isStillCurrent: (cid) => genRef.current === myGen && getCurrentChampSelectChampionId() === cid,
          isCompanionDriven: isCompanionDrivenChampion,
          epoch: getChampSelectPhaseEpoch(),
          autoItemSetsEnabled: getAutoItemSetsEnabled(),
          autoRunesEnabled: getAutoRunesEnabled(),
          session: getStoredSession(),
          port: getStoredPort(),
          shouldExportForLane: shouldAutoExportForLane,
          claimLock: tryClaimAutoExportLock,
          markExported: markAutoExported,
          applyItemSets: autoApplyItemSetsIfEligible,
          applyRunes: autoApplyRunesIfEligible,
          onToast: (kind, toast) => {
            if (!cancelled) onToast(kind, toast);
          },
        });
      } finally {
        inFlightRef.current.delete(championId);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-evaluates on every poll tick (companion.tick), same cadence as the
    // page follow effect — champSelectFollowState's own dedup, not the effect
    // deps, decides what actually fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.tick, onToast]);

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
