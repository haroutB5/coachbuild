// ─────────────────────────────────────────────────────────────────────────────
// heroStats.ts — champion+lane hero-banner stats ("52.4% WIN · 18,402 GAMES")
// ─────────────────────────────────────────────────────────────────────────────
//
// coachless's API has NO champion-level "winrate" field anywhere (verified
// live 2026-07-12): `RuneEntry` (Rune/GetKeystoneData — what recommend.ts
// uses for `totalGames`) only carries `wpaOverall`+`occurrence`, no observed
// winrate at all. `ItemEntry`/`SpellEntry` carry `winrateObserved`, but it's
// PER-ITEM — the win rate of games where that specific item/spell was
// bought, not the champion's overall win rate. There is also no
// champion-overview/tier-list style endpoint (probed ~12 plausible endpoint
// names live — GetChampionOverview, GetChampionsTierList, GetChampionPool,
// etc. — all 404; `championIds: []` doesn't give a per-champion breakdown
// either, it just returns one ROLE-WIDE aggregate across every champion).
//
// DERIVATION (documented deviation — there is no literal "champion winrate"
// field to read, so this is the most defensible number the payload exposes):
// `winRatePct` is the occurrence-weighted average of `winrateObserved` across
// every STARTER item (itemType=6) for this champ+lane. This works as a
// genuine champion-overall-winrate proxy because virtually every game buys
// exactly one starter item, so summing starter-row occurrence reproduces the
// champion's total game count almost exactly — verified live:
//   Viktor  MID     : keystone-occurrence sum 246,675 vs. starter-occurrence
//                     sum 246,447 (99.9% match) → weighted WR 50.30%
//   Lee Sin JUNGLE   : keystone-occurrence sum 338,433 vs. starter-occurrence
//                     sum 338,811 (100.1% match) → weighted WR 48.87%
// `gamesCount` uses the keystone-occurrence sum — the SAME "total games in
// this role" definition recommend.ts's `totalGames` already uses for the
// adoption bar, so this stays internally consistent with the Builds page
// rather than introducing a second definition of "games".
//
// Both null when the champ+lane combo has no coachless data yet (brand-new
// champion whose data patch hasn't landed — see staticData.ts's champion
// gap-fill gotcha for the general shape of this lag). Verified live: Locke
// (id 805, shipped 16.13.1) TOP returns `[]` from both endpoints under
// 16.12.1 — coachless has zero WPA rows for it yet.

import type { RoleId } from "./types";
import { getKeystoneData, getGlobalItemStatistics } from "./coachless";
import { getLatestPatch } from "./staticData";

export type LaneKey = "top" | "jungle" | "mid" | "bot" | "support";

const LANE_ROLE: Record<LaneKey, RoleId> = {
  top: 0,
  jungle: 1,
  mid: 2,
  bot: 3,
  support: 4,
};

export interface HeroStats {
  winRatePct: number | null;
  gamesCount: number | null;
}

/** itemType 6 = starter (see coachless.ts's getGlobalItemStatistics doc). */
const STARTER_ITEM_TYPE = 6;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Champion+lane hero-banner stats. `lane` is a free-form string (route-param
 * shaped) rather than the narrower `LaneKey` so an invalid/unknown lane
 * degrades to nulls instead of a type error at the API boundary — the UI
 * hides the banner gracefully either way.
 */
export async function getHeroStats(
  championId: number,
  lane: string
): Promise<HeroStats> {
  const role = LANE_ROLE[lane as LaneKey];
  if (role === undefined) {
    return { winRatePct: null, gamesCount: null };
  }

  const patchInfo = await getLatestPatch();
  const patch = {
    major: patchInfo.major,
    patch: patchInfo.patch,
    patchAdditions: patchInfo.patchAdditions,
  };

  try {
    const [keystoneData, starterData] = await Promise.all([
      getKeystoneData(championId, role, patch),
      getGlobalItemStatistics(championId, role, patch, null, STARTER_ITEM_TYPE),
    ]);

    const gamesCount = keystoneData.reduce((s, e) => s + e.occurrence, 0);
    if (gamesCount === 0) {
      // No data for this champ+lane yet (new champ, or a lane it's never
      // played in this data patch) — null, not 0, so the UI can hide the
      // banner cleanly rather than showing "0.0% WIN · 0 GAMES".
      return { winRatePct: null, gamesCount: null };
    }

    const starterTotal = starterData.reduce((s, e) => s + e.occurrence, 0);
    if (starterTotal === 0) {
      // Games exist but no starter-item rows (shouldn't happen in practice,
      // but the two endpoints are independent calls) — games count is known,
      // win rate isn't.
      return { winRatePct: null, gamesCount };
    }

    const weightedWinrate =
      starterData.reduce((s, e) => s + e.winrateObserved * e.occurrence, 0) /
      starterTotal;

    return { winRatePct: round1(weightedWinrate), gamesCount };
  } catch (err) {
    // Upstream failure (network/5xx/timeout) — degrade to null, never throw;
    // this feeds a decorative hero banner, not a page-blocking data path.
    console.error(`[heroStats] getHeroStats(${championId}, ${lane}) failed:`, err);
    return { winRatePct: null, gamesCount: null };
  }
}
