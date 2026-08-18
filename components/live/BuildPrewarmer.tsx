"use client";

// ─────────────────────────────────────────────────────────────────────────────
// BuildPrewarmer.tsx — fetch the champ-select champion's build the moment champ
// select resolves it, not the moment the user opens the Builds page.
//
// WHY. Measured 2026-08-18 (scripts/bench-champselect.mjs): every champion
// change cost the user a full /api/build round trip AFTER they were already
// looking at the page, because nothing asked for the build until BuildTabContent
// mounted or re-keyed. The champion is known well before that — the same
// /status poll that drives the follow already carries it — so the request can
// start early and be finished by the time it is needed.
//
// Mounted app-wide (app/layout.tsx, inside CompanionProvider) for the same
// reason AutoExporter is: it must react to the ONE app-wide status poll on every
// route, including /draft, which is where the user actually is during champ
// select. A per-page mount would warm nothing for the page they are about to
// open, which is the entire point.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//  - It never renders anything and never touches page state. A prewarm that can
//    change what is on screen is not a prewarm.
//  - It does not resolve a most-played lane. A ROLE-LESS champ select (custom /
//    ARAM / blind pick) would need five /api/hero-stats calls to guess a lane,
//    and guessing wrong warms the wrong build; those modes simply are not
//    prewarmed. AutoExporter still does that lookup when the user has auto-export
//    on, and its build request lands in the same cache.
//  - It does not hammer anything. A hover flicker is absorbed by the debounce
//    below, and everything past it is deduped and cached by lib/buildCache.ts:
//    at most one request per (champion, lane, rank) for the whole session,
//    shared with BuildTabContent and AutoExporter.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useCompanion } from "./CompanionProvider";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "./champSelectFollow";
import { roleIdToLane } from "./deepLink";
import { LANE_TO_ROLE_ID } from "@/components/hextech/heroContracts";
import { readStoredRankBracketId } from "@/components/hextech/rankBracketStorage";
import { loadBuild } from "@/lib/buildCache";

/** Hovers in champ select can flicker several champions in under a second while
 *  the user scans the grid. Waiting this long before warming means a scan costs
 *  one request instead of one per champion passed over. Short enough that a
 *  deliberate hover is still warm long before the user can act on it. */
export const PREWARM_DEBOUNCE_MS = 300;

export default function BuildPrewarmer() {
  const companion = useCompanion();
  const championId = resolveCurrentChampSelectChampionId(companion.champSelect);
  const roleId = resolveChampSelectRoleId(companion.champSelect);
  const { phase, statusFresh } = companion;

  useEffect(() => {
    if (!statusFresh || phase !== "ChampSelect") return;
    if (championId === null || roleId === undefined) return;
    const lane = roleIdToLane(roleId);
    const timer = setTimeout(() => {
      // Fire and forget: the value is the CACHE ENTRY, never this call's result.
      // A failure is not cached (see lib/buildCache.ts), so the real consumer
      // simply requests it again and surfaces its own error state.
      void loadBuild(championId, LANE_TO_ROLE_ID[lane], readStoredRankBracketId());
    }, PREWARM_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Keyed on the champion/role themselves rather than the poll tick: a tick
    // that reports the same champion must not restart the debounce, or a steady
    // stream of ticks would postpone the warm indefinitely.
  }, [championId, roleId, phase, statusFresh]);

  return null;
}
