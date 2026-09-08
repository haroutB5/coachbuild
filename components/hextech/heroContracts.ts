import type { ChampionRef } from "@/lib/types";

export type LaneId = "top" | "jungle" | "mid" | "bot" | "support";

export const LANE_ORDER: LaneId[] = ["top", "jungle", "mid", "bot", "support"];

export const LANE_LABEL: Record<LaneId, string> = {
  top: "Top",
  jungle: "Jungle",
  mid: "Mid",
  bot: "Bot",
  support: "Support",
};

/** Lane id -> the RoleId (0-4) BuildResponse/ProGame already use. */
export const LANE_TO_ROLE_ID: Record<LaneId, 0 | 1 | 2 | 3 | 4> = {
  top: 0,
  jungle: 1,
  mid: 2,
  bot: 3,
  support: 4,
};

export function liveVersionFromChampMap(champMap: ReadonlyMap<number, ChampionRef>): string | null {
  // .forEach, not for...of — matches this codebase's Map-iteration
  // convention (see proAssets.ts's getCachedLiveIconVersion) and avoids
  // tsc's TS2802 without a target/downlevelIteration bump.
  let found: string | null = null;
  champMap.forEach((c) => {
    if (found) return;
    const m = c.icon?.match(/\/(?:static-files|cdn)\/(\d+\.\d+\.\d+)\//);
    if (m) found = m[1];
  });
  return found;
}

/** Rebuilds a STATIC_FALLBACK_LANE_CHAMPIONS entry's icon URL against the
 *  live version when one's available (keeps id/key/name — the mockup's exact
 *  pick — untouched, only the icon's version folder moves), so the per-lane
 *  degraded path doesn't glyph-fallback forever on a frozen 16.12.1 the way
 *  it did before. Falls through to the champ unchanged (hardcoded ICON_VER)
 *  when no live version is available. */
export function withLiveIconVersion(champ: ChampionRef, liveVer: string | null): ChampionRef {
  if (!liveVer) return champ;
  return { ...champ, icon: `https://ddragon.leagueoflegends.com/cdn/${liveVer}/img/champion/${champ.key}.png` };
}

let champMapCache: Map<number, ChampionRef> | null = null;
let champMapInFlight: Promise<Map<number, ChampionRef>> | null = null;

export async function getChampionMap(): Promise<Map<number, ChampionRef>> {
  if (champMapCache) return champMapCache;
  if (champMapInFlight) return champMapInFlight;
  champMapInFlight = import("@/lib/ddragonClient").then(m => m.loadDdragon()).then(data => data.champions)
    .then((list) => {
      const map = new Map<number, ChampionRef>();
      if (Array.isArray(list)) for (const c of list) map.set(c.id, c);
      champMapCache = map;
      return map;
    })
    .catch(() => new Map<number, ChampionRef>())
    .finally(() => {
      champMapInFlight = null;
    });
  return champMapInFlight;
}

