// ─────────────────────────────────────────────────────────────────────────────
// staticData.ts — fetch + in-memory cache CDN maps; id→{name,icon} resolvers
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "./types";

// ── CDN bases ────────────────────────────────────────────────────────────────

// We pin asset URLs to 16.11.1 for runes (matches our API patch) and 16.12.1
// for champion/spell (matches investigate.mjs). Items also use 16.11.1.
const RUNE_VER = "16.11.1";
const ASSET_VER = "16.12.1";

const CDN = {
  runes: `https://cdn.coachless.gg/rune-translations-v2/runes-bundled-en_US.json`,
  items: `https://cdn.coachless.gg/item-base-v2/items-bundled.json`,
  champs: (ver: string) =>
    `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/champion.json`,
  summoners: (ver: string) =>
    `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/summoner.json`,
  versions: `https://ddragon.leagueoflegends.com/api/versions.json`,
};

export const ICON_BASES = {
  // rune perk icon: append the Icon path from the rune map (.png → .webp)
  rune: `https://cdn.coachless.gg/static-files/${RUNE_VER}/img/`,
  // tree icon
  tree: (treeName: string) =>
    `https://cdn.coachless.gg/runes/${treeName.toLowerCase()}.png`,
  // shard icon (stat-icons)
  shard: (filename: string) =>
    `https://cdn.coachless.gg/stat-icons/${filename}`,
  item: (id: number) =>
    `https://cdn.coachless.gg/static-files/${RUNE_VER}/${RUNE_VER}/img/item/${id}.webp`,
  spell: (spellName: string) =>
    `https://cdn.coachless.gg/static-files/${ASSET_VER}/${ASSET_VER}/img/spell/Summoner${spellName}.webp`,
  champ: (key: string) =>
    `https://cdn.coachless.gg/static-files/${ASSET_VER}/${ASSET_VER}/img/champion/${key}.webp`,
};

// ── Shard id → icon filename (static map, no CDN call needed) ───────────────
// The API returns numeric rune IDs for shards (runeType=2).
// Icon filenames observed from the live site / sampleBuild.

export const SHARD_ICON: Record<number, string> = {
  5008: "adaptiveforce.png",
  5005: "as.png", // attack speed
  5007: "ah.png", // ability haste
  5010: "ms.png",
  5002: "armor.png",
  5003: "magicresist.png",
  5001: "healthscaling.png",
  5011: "health.png",
  5013: "tenacity.png",
};

export const SHARD_NAME: Record<number, string> = {
  5008: "Adaptive Force",
  5005: "Attack Speed",
  5007: "Ability Haste",
  5010: "Move Speed",
  5002: "Armor",
  5003: "Magic Resist",
  5001: "Health (scaling)",
  5011: "Health",
  5013: "Tenacity and Slow Resist",
};

// ── Rune icon URL builder ────────────────────────────────────────────────────

const DEATHFIRE_TOUCH_ID = 8992;
const DEATHFIRE_TOUCH_ICON =
  "perk-images/Styles/Sorcery/DeathfireTouch/DEATHFIRE_TOUCH_KEYSTONE.webp";

/**
 * Convert a rune's Icon path (from the CDN map) to an absolute URL.
 * The map may return .png paths but the served files are .webp.
 * Deathfire Touch's Icon path is missing the perk-images/Styles prefix.
 */
export function runeIconUrl(
  runeId: number,
  iconPath: string | undefined
): string {
  if (runeId === DEATHFIRE_TOUCH_ID) {
    return ICON_BASES.rune + DEATHFIRE_TOUCH_ICON;
  }
  if (!iconPath) return "";
  // Replace .png extension with .webp
  const webp = iconPath.replace(/\.png$/i, ".webp");
  return ICON_BASES.rune + webp;
}

// ── Rune map entry ───────────────────────────────────────────────────────────

interface RuneMapEntry {
  Name: string;
  Icon: string; // relative path like "perk-images/Styles/Sorcery/Arcane/Arcane.png"
}

type RuneMap = Record<string, RuneMapEntry>;

// ── Item map entry ───────────────────────────────────────────────────────────

interface ItemEntry {
  name: string;
  // The bundled items JSON can have different shapes; we only need name.
  [key: string]: unknown;
}

type ItemsMap = Record<string, ItemEntry>;

// ── Champ data ────────────────────────────────────────────────────────────────

interface ChampDataEntry {
  id: string; // "Viktor"
  key: string; // "112" (numeric string)
  name: string; // "Viktor"
}

interface SummonerDataEntry {
  id: string; // "SummonerFlash"
  key: string; // "4"
  name: string; // "Flash"
  // spell name suffix for icon URL (e.g. "Flash" → SummonerFlash)
}

// ── In-memory caches (populated once per serverless instance lifetime) ───────

let runeMap: RuneMap | null = null;
let itemsMap: ItemsMap | null = null;
let champsMap: ChampDataEntry[] | null = null;
let summonersMap: SummonerDataEntry[] | null = null;
let resolvedPatch: string | null = null; // "16.11"

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    next: { revalidate: 86400 }, // cache 24 h
  });
  if (!res.ok) throw new Error(`staticData fetch ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Patch resolution ─────────────────────────────────────────────────────────

/**
 * Returns the current data patch string, e.g. "16.11".
 * Uses ddragon versions list. We use 16.11 for the API filter (last known
 * patch with data) as a stable fallback since GetPatches shape is TBD.
 */
export async function getLatestPatch(): Promise<{
  major: number;
  patch: number;
  patchAdditions: number;
  label: string;
}> {
  // We fix to 16.11 as the verified live data patch (matches investigate.mjs).
  // GetPatches request shape is not confirmed, so we use the known-good value.
  return { major: 16, patch: 11, patchAdditions: 0, label: "16.11" };
}

// ── Loader functions (lazy, memoized) ────────────────────────────────────────

export async function loadRuneMap(): Promise<RuneMap> {
  if (!runeMap) {
    runeMap = await fetchJson<RuneMap>(CDN.runes);
  }
  return runeMap;
}

export async function loadItemsMap(): Promise<ItemsMap> {
  if (!itemsMap) {
    itemsMap = await fetchJson<ItemsMap>(CDN.items);
  }
  return itemsMap;
}

export async function loadChampsData(): Promise<ChampDataEntry[]> {
  if (!champsMap) {
    // ddragon champion.json has a wrapper: { type, format, version, data: { Name: {...} } }
    const raw = await fetchJson<{
      data: Record<string, ChampDataEntry>;
    }>(CDN.champs(ASSET_VER));
    champsMap = Object.values(raw.data);
  }
  return champsMap;
}

export async function loadSummonersData(): Promise<SummonerDataEntry[]> {
  if (!summonersMap) {
    const raw = await fetchJson<{
      data: Record<string, SummonerDataEntry>;
    }>(CDN.summoners(ASSET_VER));
    summonersMap = Object.values(raw.data);
  }
  return summonersMap;
}

// ── Public resolvers ─────────────────────────────────────────────────────────

export interface ResolvedRune {
  id: number;
  name: string;
  icon: string;
}

export async function resolveRune(id: number): Promise<ResolvedRune> {
  const map = await loadRuneMap();
  const entry = map[String(id)];
  return {
    id,
    name: entry?.Name ?? `#${id}`,
    icon: runeIconUrl(id, entry?.Icon),
  };
}

export interface ResolvedItem {
  id: number;
  name: string;
  icon: string;
}

export async function resolveItem(id: number): Promise<ResolvedItem> {
  const map = await loadItemsMap();
  const entry = map[String(id)];
  // items-bundled.json entries are shaped { Id, Name, ... } (capital N).
  const name =
    (entry?.Name as string | undefined) ??
    (entry?.name as string | undefined) ??
    `Item #${id}`;
  return {
    id,
    name,
    icon: ICON_BASES.item(id),
  };
}

export interface ResolvedSpell {
  id: number;
  name: string;
  icon: string;
}

// Summoner spell key → icon suffix (the part after "Summoner" in the filename)
// We derive from the spell's id field (e.g. "SummonerFlash" → "Flash").
const SUMMONER_SUFFIX_MAP: Record<number, string> = {
  1: "Boost",   // Cleanse (SummonerBoost)
  3: "Exhaust", // SummonerExhaust
  4: "Flash",   // SummonerFlash
  6: "Haste",   // Ghost = SummonerHaste
  7: "Heal",    // SummonerHeal
  11: "Smite",  // SummonerSmite
  12: "Teleport", // SummonerTeleport
  14: "Dot",    // Ignite = SummonerDot
  21: "Barrier", // SummonerBarrier
  32: "Snowball", // Mark = SummonerSnowball
};

export async function resolveSpell(id: number): Promise<ResolvedSpell> {
  const spells = await loadSummonersData();
  const entry = spells.find((s) => s.key === String(id));
  const suffix = SUMMONER_SUFFIX_MAP[id] ?? entry?.id?.replace(/^Summoner/, "") ?? String(id);
  return {
    id,
    name: entry?.name ?? `Spell #${id}`,
    icon: ICON_BASES.spell(suffix),
  };
}

export function resolveShardSync(id: number): { name: string; icon: string } {
  return {
    name: SHARD_NAME[id] ?? `Shard #${id}`,
    icon: ICON_BASES.shard(SHARD_ICON[id] ?? `${id}.png`),
  };
}

/** All champions as ChampionRef[], sorted by name. */
export async function getAllChampions(): Promise<ChampionRef[]> {
  const champs = await loadChampsData();
  return champs
    .map((c) => ({
      id: parseInt(c.key, 10),
      key: c.id,
      name: c.name,
      icon: ICON_BASES.champ(c.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Find champion by numeric id. */
export async function getChampionById(
  id: number
): Promise<ChampionRef | null> {
  const champs = await loadChampsData();
  const c = champs.find((x) => parseInt(x.key, 10) === id);
  if (!c) return null;
  return {
    id,
    key: c.id,
    name: c.name,
    icon: ICON_BASES.champ(c.id),
  };
}

// ── Tree icon helper ─────────────────────────────────────────────────────────

const TREE_NAME_MAP: Record<number, string> = {
  8000: "precision",
  8100: "domination",
  8200: "sorcery",
  8300: "inspiration",
  8400: "resolve",
};

export function treeIcon(treeId: number): string {
  const name = TREE_NAME_MAP[treeId] ?? String(treeId);
  return ICON_BASES.tree(name);
}

export function treeName(treeId: number): string {
  const MAP: Record<number, string> = {
    8000: "Precision",
    8100: "Domination",
    8200: "Sorcery",
    8300: "Inspiration",
    8400: "Resolve",
  };
  return MAP[treeId] ?? `Tree ${treeId}`;
}

/**
 * Given a rune's Icon path, extract the tree ID.
 * Icon paths look like "perk-images/Styles/Sorcery/..."
 */
export function treeIdFromIconPath(iconPath: string | undefined): number | null {
  if (!iconPath) return null;
  const m = iconPath.match(/Styles\/([A-Za-z]+)\//);
  if (!m) return null;
  const nameToId: Record<string, number> = {
    Precision: 8000,
    Domination: 8100,
    Sorcery: 8200,
    Inspiration: 8300,
    Resolve: 8400,
  };
  return nameToId[m[1]] ?? null;
}
