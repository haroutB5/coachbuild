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
  /** v0.27.1 — raw ddragon recipe/tag fields, added for
   *  components/hextech/proConsensus.ts's completed-item filter (component
   *  exclusion, e.g. Needlessly Large Rod). `into`: ids this item upgrades
   *  into — non-empty means "not finished yet." `from`: ids it was built
   *  from — empty means a base/starting item with no recipe. `tags`: raw
   *  ddragon tag list, used to special-case "Boots" (see proConsensus.ts's
   *  module comment for why tier-2 boots need their own carve-out).
   *  `purchasable`: false marks non-buyable/quest-root/legacy ids. */
  into: string[];
  from: string[];
  tags: string[];
  purchasable: boolean;
}

const ITEM_DATA_URL = (ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/item.json`;

// v2 (was "coachbuild:itemdata:v1:" through v0.27.0) — bumped because v0.27.1
// added into/from/tags/purchasable to ItemDetail WITHOUT bumping this prefix,
// so a device holding a pre-v0.27.1 v1 cache entry replayed an object missing
// those fields verbatim (readLocalStorageCache trusted the parsed JSON's
// shape blindly). components/hextech/proConsensus.ts's isBuildItem() then hit
// `meta.tags.includes(...)` on an undefined `tags` -> real prod crash ("Pro
// consensus data couldn't load", reported from an iOS PWA holding a stale
// cache). Fixed two ways: (1) this prefix bump so no old-shape entry is ever
// read as v2, (2) readLocalStorageCache below now normalizes every entry
// defensively anyway, so a FUTURE shape change degrades instead of crashing
// the same way. Old v1:* keys are swept best-effort in writeLocalStorageCache.
const LOCALSTORAGE_PREFIX = "coachbuild:itemdata:v2:";
const LEGACY_LOCALSTORAGE_PREFIX = "coachbuild:itemdata:v1:";

interface RawItemEntry {
  name?: string;
  description?: string;
  gold?: { total?: number; purchasable?: boolean };
  into?: string[];
  from?: string[];
  tags?: string[];
}

interface RawItemJson {
  data?: Record<string, RawItemEntry>;
}

/** Coerce one parsed localStorage record into a well-shaped ItemDetail,
 *  defaulting any missing/wrong-typed field instead of trusting the cache
 *  blindly. Cheap insurance against exactly the class of bug the v1->v2
 *  prefix bump above fixed — a stored entry from an older ItemDetail shape
 *  (or any future one) degrades to sane defaults rather than crashing a
 *  consumer like proConsensus.ts's isBuildItem() on `undefined.includes(...)`. */
function normalizeCachedItemDetail(id: number, entry: unknown): ItemDetail {
  const e = (entry && typeof entry === "object" ? entry : {}) as Partial<ItemDetail>;
  return {
    id,
    name: typeof e.name === "string" ? e.name : `Item #${id}`,
    goldTotal: typeof e.goldTotal === "number" ? e.goldTotal : 0,
    descriptionText: typeof e.descriptionText === "string" ? e.descriptionText : "",
    into: Array.isArray(e.into) ? e.into : [],
    from: Array.isArray(e.from) ? e.from : [],
    tags: Array.isArray(e.tags) ? e.tags : [],
    purchasable: typeof e.purchasable === "boolean" ? e.purchasable : true,
  };
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map = new Map<number, ItemDetail>();
    for (const [id, entry] of Object.entries(parsed)) {
      map.set(Number(id), normalizeCachedItemDetail(Number(id), entry));
    }
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
    // Best-effort cleanup of any lingering pre-v2 cache entries — they'll
    // never be read again (readLocalStorageCache only ever looks under the
    // current LOCALSTORAGE_PREFIX) but there's no reason to leave stale data
    // occupying a user's localStorage quota indefinitely.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(LEGACY_LOCALSTORAGE_PREFIX)) {
        window.localStorage.removeItem(key);
      }
    }
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
        into: Array.isArray(entry.into) ? entry.into : [],
        from: Array.isArray(entry.from) ? entry.from : [],
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        purchasable: entry.gold?.purchasable ?? true,
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

/**
 * Full per-item detail map (name + gold + recipe/tag fields) for the given
 * version — same underlying fetch/cache as getItemDetail/getItemNameMap, no
 * extra network cost. v0.27.1: backs components/hextech/proConsensus.ts's
 * completed-item filter, which needs into/from/tags/purchasable alongside
 * the name it already needed. Never throws — a failed fetch resolves to an
 * empty map so callers degrade (proConsensus's aggregator treats an unknown
 * item id as "don't show it," never as "assume it's finished").
 */
export async function getItemDetailMap(ver: string): Promise<Map<number, ItemDetail>> {
  try {
    return await loadItemDataMap(ver);
  } catch {
    return new Map();
  }
}
