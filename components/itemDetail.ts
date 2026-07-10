// ─────────────────────────────────────────────────────────────────────────────
// itemDetail.ts — item DATA (name / gold / description) for the item-detail
// popover in GameDetailSheet, as opposed to proAssets.ts's icon URL helpers.
//
// Fetches a ddragon-shaped item.json from the SAME coachless CDN mirror that
// proAssets.itemIconUrl() already reads icons from, using the SAME versioned
// folder — `https://cdn.coachless.gg/static-files/{ver}/{ver}/...` — so item
// data always matches the icon set a game was rendered with (ver is derived
// per-game from proAssets.versionFromPatch(game.patch)). Real ddragon.
// leagueoflegends.com is not used: this app's patch labels (e.g. "16.13.1")
// only resolve against coachless's own CDN mirror, not upstream ddragon —
// verified live 2026-07-10 (200 + CORS `*` at both 16.12.1 and 16.13.1, same
// {type,version,data} envelope Riot's ddragon item.json uses).
//
// Cached module-level per version (in-memory) plus a best-effort versioned
// localStorage cache — never load-bearing, just avoids a re-fetch across
// page loads for the same patch.
// ─────────────────────────────────────────────────────────────────────────────

export interface ItemDetail {
  id: number;
  name: string;
  goldTotal: number;
  /** Sanitized, human-readable description — ddragon's HTML-ish markup
   *  (<mainText>, <stats>, <passive>, <attention>, <status>, etc.) stripped,
   *  <br> converted to newlines. Safe to render as plain text (never HTML). */
  descriptionText: string;
}

const ITEM_DATA_URL = (ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/item.json`;

const LOCALSTORAGE_PREFIX = "coachbuild:itemdata:v1:";

interface RawItemEntry {
  name?: string;
  description?: string;
  gold?: { total?: number };
}

interface RawItemJson {
  data?: Record<string, RawItemEntry>;
}

/**
 * Strip ddragon's item description markup down to plain, readable text.
 * `<br>` → newline (preserves the stat-block / passive-block line breaks);
 * every other tag (`<mainText>`, `<stats>`, `<passive>`, `<attention>`,
 * `<physicalDamage>`, `<status>`, `<OnHit>`, ...) is dropped but its text
 * content is kept. A small HTML-entity unescape covers the handful ddragon
 * actually emits. Pure + exported for direct unit testing.
 */
export function stripItemDescriptionHtml(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const memCache = new Map<string, Map<number, ItemDetail>>();
const inFlight = new Map<string, Promise<Map<number, ItemDetail>>>();

function readLocalStorageCache(ver: string): Map<number, ItemDetail> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LOCALSTORAGE_PREFIX + ver);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, ItemDetail>;
    const map = new Map<number, ItemDetail>();
    for (const [id, entry] of Object.entries(parsed)) map.set(Number(id), entry);
    return map;
  } catch {
    return null;
  }
}

function writeLocalStorageCache(ver: string, map: Map<number, ItemDetail>): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const obj: Record<string, ItemDetail> = {};
    map.forEach((entry, id) => {
      obj[id] = entry;
    });
    window.localStorage.setItem(LOCALSTORAGE_PREFIX + ver, JSON.stringify(obj));
  } catch {
    // best-effort only — quota exceeded / storage disabled never breaks the app
  }
}

async function loadItemDataMap(ver: string): Promise<Map<number, ItemDetail>> {
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
    const res = await fetch(ITEM_DATA_URL(ver));
    if (!res.ok) throw new Error(`item data fetch ${res.status}`);
    const json = (await res.json()) as RawItemJson;
    const map = new Map<number, ItemDetail>();
    for (const [idStr, entry] of Object.entries(json.data ?? {})) {
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      map.set(id, {
        id,
        name: entry.name || `Item #${id}`,
        goldTotal: entry.gold?.total ?? 0,
        descriptionText: stripItemDescriptionHtml(entry.description),
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
 * Resolve a single item's detail (name, total gold cost, sanitized
 * description) for the given icon/data version. Never throws — unknown item
 * id or any fetch failure resolves to `null` so the caller can degrade to a
 * "details unavailable" state instead of crashing.
 */
export async function getItemDetail(id: number, ver: string): Promise<ItemDetail | null> {
  try {
    const map = await loadItemDataMap(ver);
    return map.get(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch-resolve every item's name for the given version in one call — used
 * by GameDetailSheet to thread real item names into its build-order/
 * final-build button aria-labels (instead of "item #3152") without a
 * per-button fetch. Reuses `loadItemDataMap`'s same module-level mem +
 * localStorage cache `getItemDetail` already populates — no duplicate
 * fetch/cache machinery. Never throws — any fetch failure resolves to an
 * empty map so callers degrade to the id-based label instead of crashing.
 */
export async function getItemNameMap(ver: string): Promise<Map<number, string>> {
  try {
    const map = await loadItemDataMap(ver);
    const names = new Map<number, string>();
    map.forEach((entry, id) => names.set(id, entry.name));
    return names;
  } catch {
    return new Map();
  }
}
