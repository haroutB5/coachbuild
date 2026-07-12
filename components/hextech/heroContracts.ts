// ─────────────────────────────────────────────────────────────────────────────
// Wiring for engo's landed contract — lib/heroStats.ts, lib/laneDefaults.ts,
// lib/splash.ts + their app/api/hero-stats + app/api/lane-defaults routes
// (see HANDOFF.md's "Data-layer support for the champion-centric redesign"
// entry, 2026-07-12, for the full derivation notes and known deviations).
// This file is the ONLY place components/hextech/* touch that contract —
// every consumer imports from here, not from lib/ or fetch() directly.
//
// ⚠️ KNOWN DEVIATION (engo's, not mine — see the HANDOFF entry above): the
// mockup's sidebar shows Darius/Lee Sin/Viktor/Jinx/Thresh, but
// getLaneDefaults() genuinely COMPUTES "most played per lane" from live
// coachless data per the brief ("compute, don't hardcode"), and engo's
// shortlist verification found 3 of 5 lanes actually resolve to a different
// champion live (Garen/Ahri/Ezreal instead of Darius/Viktor/Jinx). This is a
// real, flagged product decision, not a bug — the STATIC_FALLBACK below
// (used only for first paint + total-failure degradation) intentionally
// keeps the mockup's exact picks so the page still matches the spec
// screenshot on a cold load / offline, but the live-resolved sidebar may
// diverge once /api/lane-defaults responds. See this file's final report.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import { getSplashUrl as getSplashUrlPure } from "@/lib/splash";

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

export interface HeroStats {
  winRatePct: number | null;
  gamesCount: number | null;
}

/** GET /api/hero-stats?champ=&lane= — thin client fetch wrapper around
 *  engo's lib/heroStats.ts (proxied through the route since coachless has
 *  no CORS header for a direct client call). Never throws — degrades to
 *  nulls, same posture as the route/lib themselves, so ChampionHero never
 *  needs a try/catch of its own. */
export async function getHeroStats(championId: number, lane: LaneId): Promise<HeroStats> {
  try {
    const res = await fetch(`/api/hero-stats?champ=${championId}&lane=${lane}`);
    if (!res.ok) return { winRatePct: null, gamesCount: null };
    const data = (await res.json()) as HeroStats;
    return {
      winRatePct: typeof data.winRatePct === "number" ? data.winRatePct : null,
      gamesCount: typeof data.gamesCount === "number" ? data.gamesCount : null,
    };
  } catch {
    return { winRatePct: null, gamesCount: null };
  }
}

/** lib/splash.ts is pure/sync and explicitly documented as safe to import
 *  directly into a client component (URL used in an <img src>, not fetch()
 *  — no CORS concern). Re-exported here rather than imported ad hoc so every
 *  hextech consumer still goes through this one file. */
export function getSplashUrl(championKey: string): string {
  return getSplashUrlPure(championKey) ?? "";
}

// ── Lane defaults ────────────────────────────────────────────────────────
//
// engo's getLaneDefaults() is async (a live coachless sweep) and only
// returns {championId, championName} — no icon/key, so the sidebar/hero
// still needs the champion map (id -> full ChampionRef) to render anything.
// Reuses the SAME /api/champions endpoint SidebarChampionSearch and
// proAssets.ts's getChampionIconMap() already fetch — a fresh module-level
// cache here (rather than importing proAssets', which returns {name,icon}
// only) since ChampionHero's splash art needs the ddragon `key` too.

const ICON_VER = "16.12.1";
const champIconUrl = (key: string) =>
  `https://cdn.coachless.gg/static-files/${ICON_VER}/${ICON_VER}/img/champion/${key}.webp`;

/** First-paint + total-failure fallback — the mockup's own exact picks
 *  (Darius/Lee Sin/Viktor/Jinx/Thresh), matching engo's own STATIC_FALLBACK
 *  in lib/laneDefaults.ts so a cold/offline load still pixel-matches the
 *  spec screenshot. Superseded by the live /api/lane-defaults result once
 *  it resolves (see app/page.tsx). */
export const STATIC_FALLBACK_LANE_CHAMPIONS: Record<LaneId, ChampionRef> = {
  top: { id: 122, key: "Darius", name: "Darius", icon: champIconUrl("Darius") },
  jungle: { id: 64, key: "LeeSin", name: "Lee Sin", icon: champIconUrl("LeeSin") },
  mid: { id: 112, key: "Viktor", name: "Viktor", icon: champIconUrl("Viktor") },
  bot: { id: 222, key: "Jinx", name: "Jinx", icon: champIconUrl("Jinx") },
  support: { id: 412, key: "Thresh", name: "Thresh", icon: champIconUrl("Thresh") },
};

let champMapCache: Map<number, ChampionRef> | null = null;
let champMapInFlight: Promise<Map<number, ChampionRef>> | null = null;

async function getChampionMap(): Promise<Map<number, ChampionRef>> {
  if (champMapCache) return champMapCache;
  if (champMapInFlight) return champMapInFlight;
  champMapInFlight = fetch("/api/champions")
    .then((res) => {
      if (!res.ok) throw new Error(`champions fetch ${res.status}`);
      return res.json() as Promise<ChampionRef[]>;
    })
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

interface LaneDefaultWire {
  championId: number;
  championName: string;
}

/** Resolves engo's GET /api/lane-defaults into full ChampionRef[] (icon +
 *  key included) via the champion map. Returns null on total failure — the
 *  caller keeps whatever it already has (STATIC_FALLBACK_LANE_CHAMPIONS on
 *  first paint) rather than blanking the sidebar. Per-lane: falls back to
 *  the static pick for any lane whose id isn't in the champion map yet
 *  (shouldn't happen in practice — every returned championId comes from the
 *  same coachless-backed champion pool — but never render a blank lane row). */
export async function getLaneDefaultChampions(): Promise<Record<LaneId, ChampionRef> | null> {
  try {
    const [defaultsRes, champMap] = await Promise.all([
      fetch("/api/lane-defaults").then((r) => (r.ok ? (r.json() as Promise<Record<LaneId, LaneDefaultWire>>) : null)),
      getChampionMap(),
    ]);
    if (!defaultsRes) return null;
    const out = {} as Record<LaneId, ChampionRef>;
    for (const lane of LANE_ORDER) {
      const wire = defaultsRes[lane];
      const resolved = wire ? champMap.get(wire.championId) : undefined;
      out[lane] = resolved ?? STATIC_FALLBACK_LANE_CHAMPIONS[lane];
    }
    return out;
  } catch {
    return null;
  }
}
