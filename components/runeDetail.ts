// ─────────────────────────────────────────────────────────────────────────────
// runeDetail.ts — rune DATA (name + description) for the tap-to-detail popover
// in GameDetailSheet, mirroring itemDetail.ts's pattern one module over.
//
// Fetches runesReforged.json — ddragon-shaped, same coachless CDN mirror and
// same versioned folder itemDetail.ts and proAssets.ts already read from —
// keyed per-game by proAssets.versionFromPatch(game.patch).
//
// This is a SEPARATE dataset from proAssets.ts's rune map (fetched from a
// different bundle, rune-translations-v2, which only carries Name+Icon and no
// description). Icon resolution stays on proAssets.resolveRuneDisplay(); this
// module only adds shortDesc/longDesc text for the detail card body.
// ─────────────────────────────────────────────────────────────────────────────

export interface RuneDetail {
  id: number;
  name: string;
  /** Sanitized, human-readable description — ddragon's rune markup (plain
   *  tags plus League's own <lol-uikit-tooltipped-keyword> wrapper) stripped,
   *  <br> converted to newlines, and unresolved `@Variable@` template
   *  placeholders (ddragon leaves these unsubstituted — there is no per-rank
   *  numeric to fill in) replaced with an ellipsis rather than left as raw
   *  "@HealAmount@" text. Safe to render as plain text (never HTML). */
  descriptionText: string;
}

const RUNES_DATA_URL = (ver: string) =>
  `https://cdn.coachless.gg/static-files/${ver}/${ver}/data/en_US/runesReforged.json`;

const LOCALSTORAGE_PREFIX = "coachbuild:runedata:v1:";

interface RawRuneEntry {
  id: number;
  name?: string;
  shortDesc?: string;
  longDesc?: string;
}

interface RawRuneStyle {
  slots?: { runes?: RawRuneEntry[] }[];
}

/**
 * Strip ddragon's rune description markup down to plain, readable text. Same
 * treatment as itemDetail.ts's stripItemDescriptionHtml, plus the
 * `@Variable@` placeholder pass runes need that items don't. Pure + exported
 * for direct unit testing.
 */
export function stripRuneDescriptionHtml(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/@\w+@/g, "…")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const memCache = new Map<string, Map<number, RuneDetail>>();
const inFlight = new Map<string, Promise<Map<number, RuneDetail>>>();

function readLocalStorageCache(ver: string): Map<number, RuneDetail> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LOCALSTORAGE_PREFIX + ver);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, RuneDetail>;
    const map = new Map<number, RuneDetail>();
    for (const [id, entry] of Object.entries(parsed)) map.set(Number(id), entry);
    return map;
  } catch {
    return null;
  }
}

function writeLocalStorageCache(ver: string, map: Map<number, RuneDetail>): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const obj: Record<string, RuneDetail> = {};
    map.forEach((entry, id) => {
      obj[id] = entry;
    });
    window.localStorage.setItem(LOCALSTORAGE_PREFIX + ver, JSON.stringify(obj));
  } catch {
    // best-effort only — quota exceeded / storage disabled never breaks the app
  }
}

async function loadRuneDataMap(ver: string): Promise<Map<number, RuneDetail>> {
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
    const res = await fetch(RUNES_DATA_URL(ver));
    if (!res.ok) throw new Error(`rune data fetch ${res.status}`);
    const json = (await res.json()) as RawRuneStyle[];
    const map = new Map<number, RuneDetail>();
    for (const style of json ?? []) {
      for (const slot of style.slots ?? []) {
        for (const rune of slot.runes ?? []) {
          if (!Number.isFinite(rune.id)) continue;
          // Prefer shortDesc (cleaner, no changelog/flavor text) — fall back
          // to longDesc when a rune has no shortDesc at all.
          const raw = (rune.shortDesc && rune.shortDesc.trim()) || rune.longDesc || "";
          map.set(rune.id, {
            id: rune.id,
            name: rune.name || `Rune #${rune.id}`,
            descriptionText: stripRuneDescriptionHtml(raw),
          });
        }
      }
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
 * Resolve a single rune's detail (name, sanitized shortDesc/longDesc) for the
 * given data version. Never throws — unknown rune id or any fetch failure
 * resolves to `null` so the caller can degrade to "details unavailable"
 * instead of crashing.
 */
export async function getRuneDetail(id: number, ver: string): Promise<RuneDetail | null> {
  try {
    const map = await loadRuneDataMap(ver);
    return map.get(id) ?? null;
  } catch {
    return null;
  }
}
