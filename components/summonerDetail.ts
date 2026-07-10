// ─────────────────────────────────────────────────────────────────────────────
// summonerDetail.ts — summoner spell DATA (name + description + cooldown) for
// the tap-to-detail popover in GameDetailSheet. Same coachless CDN mirror,
// same versioned folder, same module-level cache pattern as itemDetail.ts /
// runeDetail.ts.
//
// summoner.json is keyed by spell KEY string ("SummonerFlash"), but ProGame
// only carries the numeric spell id (4 = Flash, per proAssets.ts's own
// SUMMONER_NAME_MAP) — every entry also carries a numeric `key` field
// ("4"), so this module flattens the map to numeric-id -> detail instead.
//
// `description` (not `tooltip`) is used for the body text: ddragon's
// `tooltip` field is riddled with unresolved `{{ placeholder }}` template
// vars and <keyword>/<shield> tags; `description` is a short, already-plain
// marketing-copy line ("Gain a brief Shield.") with no markup to strip.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpellDetail {
  id: number;
  name: string;
  descriptionText: string;
  cooldownSec: number | null;
}

const SUMMONER_DATA_URL = (ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/summoner.json`;

const LOCALSTORAGE_PREFIX = "coachbuild:summonerdata:v1:";

interface RawSpellEntry {
  name?: string;
  description?: string;
  key?: string; // numeric spell id, as a string
  cooldown?: number[];
}

interface RawSummonerJson {
  data?: Record<string, RawSpellEntry>;
}

const memCache = new Map<string, Map<number, SpellDetail>>();
const inFlight = new Map<string, Promise<Map<number, SpellDetail>>>();

function readLocalStorageCache(ver: string): Map<number, SpellDetail> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LOCALSTORAGE_PREFIX + ver);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, SpellDetail>;
    const map = new Map<number, SpellDetail>();
    for (const [id, entry] of Object.entries(parsed)) map.set(Number(id), entry);
    return map;
  } catch {
    return null;
  }
}

function writeLocalStorageCache(ver: string, map: Map<number, SpellDetail>): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const obj: Record<string, SpellDetail> = {};
    map.forEach((entry, id) => {
      obj[id] = entry;
    });
    window.localStorage.setItem(LOCALSTORAGE_PREFIX + ver, JSON.stringify(obj));
  } catch {
    // best-effort only — quota exceeded / storage disabled never breaks the app
  }
}

async function loadSpellDataMap(ver: string): Promise<Map<number, SpellDetail>> {
  const cached = memCache.get(ver);
  if (cached) return cached;
  const pending = inFlight.get(ver);
  if (pending) return pending;

  const promise = (async () => {
    const fromStorage = readLocalStorageCache(ver);
    if (fromStorage && fromStorage.size > 0) {
      memCache.set(ver, fromStorage);
      return fromStorage;
    }
    const res = await fetch(SUMMONER_DATA_URL(ver));
    if (!res.ok) throw new Error(`summoner data fetch ${res.status}`);
    const json = (await res.json()) as RawSummonerJson;
    const map = new Map<number, SpellDetail>();
    for (const entry of Object.values(json.data ?? {})) {
      const id = Number(entry.key);
      if (!Number.isFinite(id)) continue;
      const cd = Array.isArray(entry.cooldown) ? entry.cooldown[0] : undefined;
      map.set(id, {
        id,
        name: entry.name || `Spell #${id}`,
        descriptionText: (entry.description || "").trim(),
        cooldownSec: typeof cd === "number" && Number.isFinite(cd) ? cd : null,
      });
    }
    memCache.set(ver, map);
    writeLocalStorageCache(ver, map);
    return map;
  })();

  inFlight.set(ver, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(ver);
  }
}

/**
 * Resolve a single summoner spell's detail (name, description, cooldown) for
 * the given data version. Never throws — unknown spell id or any fetch
 * failure resolves to `null` so the caller can degrade to "details
 * unavailable" instead of crashing.
 */
export async function getSpellDetail(id: number, ver: string): Promise<SpellDetail | null> {
  try {
    const map = await loadSpellDataMap(ver);
    return map.get(id) ?? null;
  } catch {
    return null;
  }
}
