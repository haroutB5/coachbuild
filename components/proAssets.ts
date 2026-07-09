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

/** Static fallback icon/data version — matches staticData.ts's own fallback. */
const ICON_VERSION_FALLBACK = "16.11.1";

/**
 * A ProGame's `patch` field is "16.13" — convert to the CDN's versioned
 * folder format "16.13.1" (matches lib/staticData.ts's versionFolder()).
 * Falls back to the static version if the patch string is unparseable.
 */
export function versionFromPatch(patch: string | undefined): string {
  if (!patch) return ICON_VERSION_FALLBACK;
  const parts = patch.split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return ICON_VERSION_FALLBACK;
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

export function spellIconUrl(id: number, ver: string): string {
  const suffix = SUMMONER_SUFFIX_MAP[id] ?? String(id);
  return SPELL_ICON_BASE(suffix, ver);
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
