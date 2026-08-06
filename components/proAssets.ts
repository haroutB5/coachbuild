// ─────────────────────────────────────────────────────────────────────────────
// proAssets.ts — icon URL helpers for the Pro Games section.
//
// Deliberately standalone from lib/staticData.ts (per dispatch brief: derive
// locally, don't edit/import backend-parallel lib/ code). Replicates the SAME
// coachless CDN URL patterns staticData.ts already uses elsewhere in the app
// so Pro Game icons look identical to the build-recommendation icons.
//
// Most icon URLs are pure functions of (id, version) — no fetch needed. Only
// rune PERK icons (keystone/primary/secondary — NOT trees, NOT shards) need a
// name+path lookup from coachless's rune bundle JSON, so that's the one
// lazy/cached fetch this module makes, shared across every ProGameCard on the
// page (module-level cache, fetched once per session).
// ─────────────────────────────────────────────────────────────────────────────

import { difficultyBand, type DifficultyBand } from "@/lib/draft/difficulty";

const CDN_RUNES_URL =
  "https://cdn.coachless.gg/rune-translations-v2/runes-bundled-en_US.json";

const RUNE_ICON_BASE = (ver: string) => `https://cdn.coachless.gg/static-files/${ver}/img/`;
const ITEM_ICON_BASE = (id: number, ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/img/item/${id}.webp`;
const SPELL_ICON_BASE = (spellSuffix: string, ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/img/spell/Summoner${spellSuffix}.webp`;
const TREE_ICON_BASE = (treeName: string) =>
  `https://cdn.coachless.gg/runes/${treeName.toLowerCase()}.png`;
const SHARD_ICON_BASE = (filename: string) => `https://cdn.coachless.gg/stat-icons/${filename}`;

const DEATHFIRE_TOUCH_ID = 8992;
const DEATHFIRE_TOUCH_ICON =
  "perk-images/Styles/Sorcery/DeathfireTouch/DEATHFIRE_TOUCH_KEYSTONE.webp";

// Stormraider's Surge (id 8230) is the reworked/renamed Phase Rush keystone —
// same id, same "PhaseRush" key, but the asset filename changed with the
// rework. The coachless rune bundle (CDN_RUNES_URL below) still has the OLD
// filename ("PhaseRush.png" -> ...PhaseRush.webp), which 403s; verified live
// 2026-07-10 against the current static-files CDN. Same failure shape as
// Deathfire Touch above (a stale Icon path in that specific bundle) — special
// case it the same way rather than trusting the bundle's Icon field.
const STORMRAIDERS_SURGE_ID = 8230;
const STORMRAIDERS_SURGE_ICON =
  "perk-images/Styles/Sorcery/PhaseRush/StormraidersSurgeRuneIcon2.webp";

// Audited the FULL coachless rune bundle against the CDN 2026-07-10 (62
// entries, HEAD-checked at 16.13.1): only these two ids 403 — every other
// rune's bundled Icon path resolves fine. If a future patch renames another
// rune's asset the same way, it'll show as a broken image (now with a
// visible fallback glyph instead of vanishing, see IconWithFallback) rather
// than a silent gap — add its id here when spotted.

/** Static fallback icon/data version — matches staticData.ts's own fallback.
 *  LAST-RESORT ONLY (Fable review 2026-07-17, P3): prostage rows always have
 *  a NULL `patch` (Leaguepedia's Cargo tables don't expose game-length/patch
 *  data the way Riot's match-v5 does — same structural-gap class CLAUDE.md's
 *  gotcha (h) documents), so every prostage-sourced icon used to resolve
 *  against this FROZEN version forever — any item/rune/champion added after
 *  16.11 would glyph-fallback on prostage surfaces only, permanently, no
 *  matter how far the live patch advances. `versionFromPatch` below now
 *  tries `getCachedLiveIconVersion()` first (derived from data already
 *  fetched client-side, see that function's doc comment) and only falls back
 *  to this hardcoded string when nothing live has resolved yet (e.g. the
 *  very first paint, before any component has fetched the champion map). */
const ICON_VERSION_FALLBACK = "16.11.1";

/** Best-effort LIVE icon/data CDN version, derived from `getChampionIconMap()`
 *  (this module's own /api/champions fetch, already shared across every
 *  consumer — TeamComp, ProBuildRow, etc.) rather than a second network call
 *  or a hardcoded constant. /api/champions doesn't expose a raw version
 *  field, but every champion icon URL it returns embeds one
 *  (".../static-files/16.13.1/16.13.1/img/champion/Viktor.webp" — see
 *  lib/staticData.ts's ICON_BASES.champ, the server-side builder for that
 *  exact URL shape), so this extracts it from whichever entry happens to be
 *  first rather than adding a new backend field.
 *
 *  Synchronous + cached: the FIRST successful resolution (anywhere in the
 *  app, since the underlying map is a shared module-level cache) is reused
 *  for the rest of the session — no need to re-derive per call. Kicks off
 *  the champion-map fetch if nothing has resolved yet (so a component that
 *  never itself calls getChampionIconMap still benefits once ANY other
 *  component on the page has), but returns null immediately rather than
 *  blocking — callers treat this as a fallback TIER, not an awaited value;
 *  ICON_VERSION_FALLBACK covers the gap until it resolves, same "never
 *  block on decorative data" posture as resolveRuneDisplay/getChampionIconMap
 *  already use in this module. */
let liveIconVersionCache: string | null = null;

function extractVersionFromIconUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/static-files\/(\d+\.\d+\.\d+)\//);
  return m ? m[1] : null;
}

/** Capture the version embedded in the live champion map as soon as the map
 * resolves. This is intentionally synchronous with the map's own cache write
 * so a parent that is already rerendering from the map fetch sees the live
 * version on that same render. */
function cacheLiveIconVersion(map: ReadonlyMap<number, { icon: string }>): void {
  if (liveIconVersionCache) return;
  map.forEach((entry) => {
    if (liveIconVersionCache) return;
    const v = extractVersionFromIconUrl(entry.icon);
    if (v) liveIconVersionCache = v;
  });
}

export function getCachedLiveIconVersion(): string | null {
  if (liveIconVersionCache) return liveIconVersionCache;
  void getChampionIconMap().then(cacheLiveIconVersion);
  return liveIconVersionCache;
}

/**
 * A ProGame's `patch` field is "16.13" — convert to the CDN's versioned
 * folder format "16.13.1" (matches lib/staticData.ts's versionFolder()).
 * Falls back to the live-resolved icon version (getCachedLiveIconVersion(),
 * see above) when `patch` is missing/unparseable — real for every prostage
 * row — and only to the hardcoded ICON_VERSION_FALLBACK when NEITHER a patch
 * NOR a live version is available.
 */
export function versionFromPatch(patch: string | undefined): string {
  if (!patch) return getCachedLiveIconVersion() ?? ICON_VERSION_FALLBACK;
  const parts = patch.split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return getCachedLiveIconVersion() ?? ICON_VERSION_FALLBACK;
  }
  return `${major}.${minor}.1`;
}

// ── Items (pure — id + version only) ────────────────────────────────────────

export function itemIconUrl(id: number, ver: string): string {
  return ITEM_ICON_BASE(id, ver);
}

/** Consumable/vision item ids — used to power the purchase-timeline's
 *  "hide consumables" toggle (potions, control wards, elixirs). Not
 *  exhaustive, just the common ones that show up as noise in a timeline. */
export const CONSUMABLE_ITEM_IDS = new Set<number>([
  2003, // Health Potion
  2031, // Refillable Potion
  2033, // Corrupting Potion
  2055, // Control Ward
  2052, // Poro-Snax
  2138, // Elixir of Iron
  2139, // Elixir of Sorcery
  2140, // Elixir of Wrath
  2010, // Total Biscuit of Everlasting Will
]);

// ── Summoner spells (pure — small static id→suffix/name map) ───────────────

const SUMMONER_SUFFIX_MAP: Record<number, string> = {
  1: "Boost",
  3: "Exhaust",
  4: "Flash",
  6: "Haste",
  7: "Heal",
  11: "Smite",
  12: "Teleport",
  14: "Dot",
  21: "Barrier",
  32: "Snowball",
};

const SUMMONER_NAME_MAP: Record<number, string> = {
  1: "Cleanse",
  3: "Exhaust",
  4: "Flash",
  6: "Ghost",
  7: "Heal",
  11: "Smite",
  12: "Teleport",
  14: "Ignite",
  21: "Barrier",
  32: "Mark",
};

/** Build a summoner-spell icon URL. Spell art is stable across patches, so
 * prefer the live static-data version when it is already available; old game
 * patches can point at CDN folders that have since been retired. `ver` stays
 * as the synchronous fallback for first paint or when the live map failed.
 * Unknown ids still produce a URL and are deliberately left to
 * IconWithFallback's visible glyph degradation if that asset is absent. */
export function spellIconUrl(id: number, ver: string): string {
  const suffix = SUMMONER_SUFFIX_MAP[id] ?? String(id);
  return SPELL_ICON_BASE(suffix, getCachedLiveIconVersion() ?? ver);
}

export function spellName(id: number): string {
  return SUMMONER_NAME_MAP[id] ?? `Spell #${id}`;
}

// ── Rune trees (pure — small static id→name map, NOT versioned) ────────────

const TREE_NAME_MAP: Record<number, string> = {
  8000: "Precision",
  8100: "Domination",
  8200: "Sorcery",
  8300: "Inspiration",
  8400: "Resolve",
};

export function treeIconUrl(treeId: number): string {
  const name = TREE_NAME_MAP[treeId] ?? String(treeId);
  return TREE_ICON_BASE(name);
}

export function treeName(treeId: number): string {
  return TREE_NAME_MAP[treeId] ?? `Tree #${treeId}`;
}

// ── Stat shards (pure — small static id→filename/name map, NOT versioned) ──

const SHARD_ICON: Record<number, string> = {
  5008: "adaptiveforce.png",
  5005: "as.png",
  5007: "ah.png",
  5010: "ms.png",
  5002: "armor.png",
  5003: "magicresist.png",
  5001: "healthscaling.png",
  5011: "health.png",
  5013: "tenacity.png",
};

const SHARD_NAME: Record<number, string> = {
  5008: "Adaptive Force",
  5005: "Attack Speed",
  5007: "Ability Haste",
  5010: "Move Speed",
  5002: "Armor",
  5003: "Magic Resist",
  5001: "Health (scaling)",
  5011: "Health",
  5013: "Tenacity",
};

export function shardIconUrl(id: number): string {
  return SHARD_ICON_BASE(SHARD_ICON[id] ?? `${id}.png`);
}

export function shardName(id: number): string {
  return SHARD_NAME[id] ?? `Shard #${id}`;
}

// ── Rune perks (keystone/primary/secondary — needs a name+icon-path fetch) ─

interface RuneMapEntry {
  Name: string;
  Icon: string; // e.g. "perk-images/Styles/Sorcery/Arcane/Arcane.png"
}
type RuneMap = Record<string, RuneMapEntry>;

let runeMapCache: RuneMap | null = null;
let runeMapInFlight: Promise<RuneMap> | null = null;

async function loadRuneMap(): Promise<RuneMap> {
  if (runeMapCache) return runeMapCache;
  if (runeMapInFlight) return runeMapInFlight;
  runeMapInFlight = fetch(CDN_RUNES_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`rune map fetch ${res.status}`);
      return res.json() as Promise<RuneMap>;
    })
    .then((map) => {
      runeMapCache = map;
      return map;
    })
    .finally(() => {
      runeMapInFlight = null;
    });
  return runeMapInFlight;
}

export interface ResolvedRuneDisplay {
  id: number;
  name: string;
  icon: string;
}

/** Resolve a rune perk's display name + icon URL. Returns a graceful
 *  placeholder (no throw) if the rune map fetch fails — icons/names on this
 *  section are decorative, never load-bearing, so a failed fetch degrades to
 *  "Rune #id" rather than breaking the card. */
export async function resolveRuneDisplay(id: number, ver: string): Promise<ResolvedRuneDisplay> {
  if (id === DEATHFIRE_TOUCH_ID) {
    return { id, name: "Deathfire Touch", icon: RUNE_ICON_BASE(ver) + DEATHFIRE_TOUCH_ICON };
  }
  if (id === STORMRAIDERS_SURGE_ID) {
    return { id, name: "Stormraider's Surge", icon: RUNE_ICON_BASE(ver) + STORMRAIDERS_SURGE_ICON };
  }
  try {
    const map = await loadRuneMap();
    const entry = map[String(id)];
    if (!entry) return { id, name: `Rune #${id}`, icon: "" };
    const webp = entry.Icon.replace(/\.png$/i, ".webp");
    return { id, name: entry.Name, icon: RUNE_ICON_BASE(ver) + webp };
  } catch {
    return { id, name: `Rune #${id}`, icon: "" };
  }
}

// ── Champion icon map (id -> {name, icon}) ──────────────────────────────────
//
// ProGame only carries championId + championName (a display name, e.g.
// "Lee Sin" with a space — not the CDN's key form "LeeSin"), so it can't
// build an icon URL on its own. /api/champions already returns the full
// ChampionRef[] (id, key, name, icon) that ChampionPicker consumes, so we
// reuse THAT as the source of truth for icons instead of guessing at a
// name->key transform. Module-level cache, fetched once per session —
// same pattern as the rune map above.

export interface ChampionIconEntry {
  name: string;
  icon: string;
  /** Draft redesign plan §2.1 (additive, v0.42.0) — mirrors ChampionRef's own
   *  `difficulty`/`tags` fields (lib/types.ts) as served by /api/champions.
   *  null/undefined when the source entry never carried it (older cached
   *  response, or a ddragon gap-fill entry with no info block) — never a
   *  fabricated value. */
  difficulty?: number | null;
  /** Pre-banded via lib/draft/difficulty.ts's difficultyBand() at map-build
   *  time so every consumer (DraftPicksTable, DraftBansTable, …) reads the
   *  same band without re-deriving it per row. */
  difficultyBand?: DifficultyBand | null;
  tags?: string[];
}

let championIconMapCache: Map<number, ChampionIconEntry> | null = null;
let championIconMapInFlight: Promise<Map<number, ChampionIconEntry>> | null = null;

interface ChampionsApiRow {
  id: number;
  name: string;
  icon: string;
  difficulty?: number | null;
  tags?: string[];
}

export async function getChampionIconMap(): Promise<Map<number, ChampionIconEntry>> {
  if (championIconMapCache) return championIconMapCache;
  if (championIconMapInFlight) return championIconMapInFlight;
  championIconMapInFlight = fetch("/api/champions")
    .then((res) => {
      if (!res.ok) throw new Error(`champions fetch ${res.status}`);
      return res.json() as Promise<ChampionsApiRow[]>;
    })
    .then((list) => {
      const map = new Map<number, ChampionIconEntry>();
      if (Array.isArray(list)) {
        for (const c of list) {
          const difficulty = typeof c.difficulty === "number" ? c.difficulty : null;
          map.set(c.id, {
            name: c.name,
            icon: c.icon,
            difficulty,
            difficultyBand: difficultyBand(difficulty),
            tags: Array.isArray(c.tags) ? c.tags : [],
          });
        }
      }
      championIconMapCache = map;
      cacheLiveIconVersion(map);
      return map;
    })
    .catch((err) => {
      // Icons here are decorative (ProGameCard already falls back to plain
      // text when no icon is available) — never throw into the caller.
      console.error("[proAssets] champion icon map fetch failed:", err);
      const empty = new Map<number, ChampionIconEntry>();
      return empty;
    })
    .finally(() => {
      championIconMapInFlight = null;
    });
  return championIconMapInFlight;
}
