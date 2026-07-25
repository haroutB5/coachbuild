// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/ddragon.ts — resolves Leaguepedia's NAME-based champion/item/
// summoner-spell/rune text into the numeric ids the existing frontend icon
// pipeline expects. ddragon (ddragon.leagueoflegends.com) is free/uncapped —
// no pacing needed, unlike lib/prostage/cargo.ts. Results are memoized
// per-process (module-level singleton promise) since ddragon's data set is
// static for the life of a serverless invocation / script run.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DdragonChampionData,
  DdragonItemData,
  DdragonMaps,
  DdragonRunesReforged,
  DdragonSummonerData,
} from "./types";

const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

/** lowercase, strip everything but a-z0-9 — collapses apostrophes, periods,
 *  spaces, ampersands, hyphens so "Dr. Mundo" / "Kai'Sa" / "Renata Glasc"
 *  compare cleanly against Leaguepedia's freeform text. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ddragon fetch failed: ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchLatestVersion(): Promise<string> {
  const versions = await fetchJson<string[]>(`${DDRAGON_BASE}/api/versions.json`);
  if (!versions.length) throw new Error("ddragon versions.json returned empty list");
  return versions[0];
}

/** A few historical/known name divergences between Leaguepedia prose and
 *  ddragon's `name` field. Extend as unresolved-champion log lines surface
 *  new cases in production — better to grow this table than guess broadly. */
const CHAMPION_ALIASES: Record<string, string> = {
  wukong: "wukong", // ddragon `name` is already "Wukong" (internal id key is MonkeyKing) — kept explicit for clarity
};

function buildDdragonMaps(
  version: string,
  championData: DdragonChampionData,
  itemData: DdragonItemData,
  summonerData: DdragonSummonerData,
  runesData: DdragonRunesReforged
): DdragonMaps {
  const championByName = new Map<string, number>();
  const championNameById = new Map<number, string>();
  for (const [dataKey, entry] of Object.entries(championData.data)) {
    const id = parseInt(entry.key, 10);
    if (Number.isNaN(id)) continue;
    championByName.set(normalizeName(entry.name), id);
    championNameById.set(id, entry.name);
    // ALSO index ddragon's internal data key ("MonkeyKing", "Fiddlesticks"),
    // not just the display name ("Wukong"). The lolesports livestats feed
    // reports championId as the INTERNAL key, so a live-ingested Wukong game
    // was unresolvable until this existed. Display name is set first and never
    // overwritten, so the canonical mapping still wins on any collision.
    const keyNorm = normalizeName(dataKey);
    if (!championByName.has(keyNorm)) championByName.set(keyNorm, id);
  }
  for (const [alias, canonical] of Object.entries(CHAMPION_ALIASES)) {
    const id = championByName.get(normalizeName(canonical));
    if (id !== undefined) championByName.set(normalizeName(alias), id);
  }

  const itemByName = new Map<string, number>();
  for (const [key, entry] of Object.entries(itemData.data)) {
    const id = parseInt(key, 10);
    if (Number.isNaN(id)) continue;
    // Don't overwrite an existing (earlier/lower-id) entry — ddragon's
    // item.json can carry multiple ids for stylistically-identical names
    // across eras; first-seen (lowest key, since Object.entries preserves
    // numeric-key insertion order ascending) wins.
    if (!itemByName.has(normalizeName(entry.name))) {
      itemByName.set(normalizeName(entry.name), id);
    }
  }

  const summonerByName = new Map<string, number>();
  for (const entry of Object.values(summonerData.data)) {
    const id = parseInt(entry.key, 10);
    if (Number.isNaN(id)) continue;
    summonerByName.set(normalizeName(entry.name), id);
  }

  const runeByName = new Map<string, { id: number; parentStyleId: number }>();
  const styleByName = new Map<string, number>();
  for (const style of runesData) {
    styleByName.set(normalizeName(style.name), style.id);
    for (const slot of style.slots) {
      for (const rune of slot.runes) {
        runeByName.set(normalizeName(rune.name), { id: rune.id, parentStyleId: style.id });
      }
    }
  }

  return { version, championByName, championNameById, itemByName, summonerByName, runeByName, styleByName };
}

let cachedMaps: Promise<DdragonMaps> | null = null;

/** Fetches + memoizes champion/item/summoner/rune name->id maps from ddragon.
 *  Call __resetDdragonCacheForTests() between test cases that need a fresh
 *  fetch (e.g. to swap the mock). */
export function getDdragonMaps(): Promise<DdragonMaps> {
  if (!cachedMaps) {
    cachedMaps = (async () => {
      const version = await fetchLatestVersion();
      const [championData, itemData, summonerData, runesData] = await Promise.all([
        fetchJson<DdragonChampionData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/champion.json`),
        fetchJson<DdragonItemData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/item.json`),
        fetchJson<DdragonSummonerData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/summoner.json`),
        fetchJson<DdragonRunesReforged>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/runesReforged.json`),
      ]);
      return buildDdragonMaps(version, championData, itemData, summonerData, runesData);
    })();
  }
  return cachedMaps;
}

export function __resetDdragonCacheForTests(): void {
  cachedMaps = null;
}
