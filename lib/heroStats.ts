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
import { getKeystoneData, getGlobalItemStatistics, type FilterOpts } from "./coachless";
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
  /** true ONLY when this result reflects a TRANSIENT UPSTREAM FAILURE
   *  (network/5xx/timeout from coachless), never genuine no-data. Internal
   *  signal for app/api/hero-stats/route.ts's Cache-Control decision —
   *  CLAUDE.md gotcha (b) ("never CDN-cache an empty API response") applies
   *  here just as much as to /api/pros: a degraded blip cached at
   *  s-maxage=21600 would pin a broken win-rate banner for 6h per PoP. The
   *  route strips this field before responding — it never reaches the wire
   *  (winRatePct/gamesCount stay the only response keys, backward-compatible
   *  with every existing consumer). Omitted (undefined) for a genuine-no-data
   *  result, never `false` — callers should treat undefined and false the
   *  same way (falsy), this is just to keep the common case's object literal
   *  shorter. */
  degraded?: boolean;
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
 *
 * `opts` (P1-1 fix, 2026-07-25 audit): OPTIONAL rank-bracket passthrough —
 * `opts.leagueTiers` rides straight into both coachless calls' `buildFilters`
 * exactly like BuildTabContent's `/api/build?rank=` already does. Before this
 * fix, this function always queried the module default regardless of which
 * elo pill was active on the hero, so the WIN%/GAMES/CONFIDENCE line one row
 * above the build panel silently described a different sample than the build
 * shown beneath it — a live probe caught 329,099 games rendered beside an
 * active "Platinum" pill whose own build panel was built from 194,981.
 *
 * 2026-08-11: the elo pills are gone and there is one bracket (Diamond+,
 * tiers [6,7,8,9]). `opts` stays OPTIONAL and still defaults through to
 * coachless's own `buildFilters` (`opts.leagueTiers ?? DIAMOND_PLUS_TIERS`),
 * so `getMostPlayedLane` can keep calling with no third argument. That call
 * used to mean "the WIDEST sample, to compare lanes fairly"; it now means the
 * same Diamond+ sample as everything else, because no wider one is offered.
 * Lane comparison is still internally consistent — every lane gets the
 * identical tier set — but it rests on a narrower base than it used to.
 */
export async function getHeroStats(
  championId: number,
  lane: string,
  opts?: FilterOpts
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
      getKeystoneData(championId, role, patch, undefined, opts),
      getGlobalItemStatistics(championId, role, patch, null, STARTER_ITEM_TYPE, {}, opts),
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
    // `degraded: true` is the signal the route needs to skip its CDN cache —
    // a transient coachless blip must never be pinned at the edge for 6h
    // (see this interface's doc comment / CLAUDE.md gotcha (b)).
    console.error(`[heroStats] getHeroStats(${championId}, ${lane}) failed:`, err);
    return { winRatePct: null, gamesCount: null, degraded: true };
  }
}
