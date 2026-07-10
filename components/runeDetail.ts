// ─────────────────────────────────────────────────────────────────────────────
// runeDetail.ts — rune DATA (name + description) for the tap-to-detail popover
// in GameDetailSheet, mirroring itemDetail.ts's pattern one module over.
//
// SOURCE: CommunityDragon's perks.json (the in-client tooltip text feed),
// NOT ddragon's runesReforged.json. Verified live 2026-07-10: ddragon's
// shortDesc/longDesc for many runes never resolve their `@Variable@`
// templates (e.g. Unflinching's shortDesc is literally "Gain Armor and Magic
// Resist when receiving crowd control." — no numbers, ever). CommunityDragon
// bakes the current-patch numeric values directly into the text instead:
//   perks.json id 8242 (Unflinching) longDesc =
//     "Gain 10 Armor and Magic Resist when crowd controlled and for 2
//     seconds after."
// Audited the full 103-entry feed 2026-07-10: only 1 rune (Unsealed
// Spellbook, id 8360) has any leftover `@Variable@` placeholder in longDesc,
// and even that one keeps its OTHER real numbers (25s, 6 mins) intact — the
// placeholder pass below degrades that single value to an ellipsis rather
// than losing the whole description.
//
// perks.json is a flat array (not ddragon's style/slot tree) and is NOT
// versioned per-patch (CDragon serves "latest" only) — so unlike
// itemDetail.ts/proAssets.ts, this module caches ONE global map, not one per
// `ver`. The `ver` parameter on getRuneDetail() is kept for call-site
// compatibility with EntityDetailPopover (which also needs `ver` for
// proAssets.resolveRuneDisplay's icon lookup) but is unused here.
//
// Icon resolution is UNCHANGED — still proAssets.resolveRuneDisplay() against
// the coachless rune-translations bundle. This module only supplies
// description text.
// ─────────────────────────────────────────────────────────────────────────────

export interface RuneDetail {
  id: number;
  name: string;
  /** Sanitized, human-readable description with real numeric values —
   *  CommunityDragon's tooltip markup (`<br>`, `<li>`, `<hr>`, `<b>`,
   *  `<lol-uikit-tooltipped-keyword>`, `<font color=...>`, `<rules>`, `<i>`,
   *  scaling-tag wrappers like `<scaleAD>`) stripped to plain text, list
   *  items (`<li>`) turned into their own bulleted line, and any leftover
   *  unresolved `@Variable@` template (rare — see module header) replaced
   *  with an ellipsis. Safe to render as plain text (never HTML). */
  descriptionText: string;
}

const RUNES_TEXT_URL =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perks.json";

// Bumped from v1 -> v2: the cached shape/source changed (ddragon
// runesReforged.json -> CDragon perks.json flat array), and v1 entries would
// carry the old placeholder-riddled shortDesc text forever otherwise. Still
// v2 for the TTL wrapper below (a wrapped-but-expired v2 entry is just
// another "miss" path, not a shape change) — no key bump needed.
const LOCALSTORAGE_KEY = "coachbuild:runedata:v2";

// CDragon's perks.json serves /latest/ only (see module header) — a cached
// copy can never be patch-keyed, so a returning user would otherwise carry
// stale numeric values across every future patch rebalance forever. ~10 days
// bounds that staleness window to roughly "one patch cycle" without
// re-fetching (a fairly large, static-ish payload) on every single page load.
const CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;

interface RawPerkEntry {
  id: number;
  name?: string;
  shortDesc?: string;
  longDesc?: string;
}

/** On-disk shape written to localStorage: the resolved id->RuneDetail map
 *  plus the timestamp it was fetched at, so a stale copy can be detected
 *  without CDragon ever having to serve a per-patch version. */
interface RuneCachePayload {
  fetchedAt: number;
  entries: Record<string, RuneDetail>;
}

/**
 * Type-guards + freshness-checks a parsed localStorage payload in one pass.
 * Returns false (a cache MISS) for: not an object, missing/non-finite
 * `fetchedAt` (covers the old pre-TTL cache shape — a flat id->entry map has
 * no `fetchedAt` key at all — and any other corrupt/unexpected shape), a
 * missing/non-object `entries`, or a `fetchedAt` older than `CACHE_TTL_MS`.
 * Pure + exported for direct unit testing (no fetch/localStorage needed).
 */
export function isFreshRuneCachePayload(payload: unknown, now: number): payload is RuneCachePayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Partial<RuneCachePayload>;
  if (typeof p.fetchedAt !== "number" || !Number.isFinite(p.fetchedAt)) return false;
  if (!p.entries || typeof p.entries !== "object") return false;
  return now - p.fetchedAt < CACHE_TTL_MS;
}

/**
 * Strip CommunityDragon's rune tooltip markup down to plain, readable text.
 * `<br>`/`<hr>` -> newline, `<li>` -> its own bulleted line, every other tag
 * dropped but its text content kept, unresolved `@Variable@` templates
 * replaced with an ellipsis. Pure + exported for direct unit testing.
 */
export function stripRuneDescriptionHtml(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
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

let memCache: Map<number, RuneDetail> | null = null;
let inFlight: Promise<Map<number, RuneDetail>> | null = null;

function readLocalStorageCache(now: number = Date.now()): Map<number, RuneDetail> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Corrupt JSON shape, missing-timestamp (old pre-TTL cache), or expired
    // -> all treated as a plain miss, never a crash.
    if (!isFreshRuneCachePayload(parsed, now)) return null;
    const map = new Map<number, RuneDetail>();
    for (const [id, entry] of Object.entries(parsed.entries)) map.set(Number(id), entry);
    return map;
  } catch {
    return null;
  }
}

function writeLocalStorageCache(map: Map<number, RuneDetail>, now: number = Date.now()): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const entries: Record<string, RuneDetail> = {};
    map.forEach((entry, id) => {
      entries[id] = entry;
    });
    const payload: RuneCachePayload = { fetchedAt: now, entries };
    window.localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(payload));
  } catch {
    // best-effort only — quota exceeded / storage disabled never breaks the app
  }
}

async function loadRuneDataMap(): Promise<Map<number, RuneDetail>> {
  if (memCache) return memCache;
  if (inFlight) return inFlight;

  const promise = (async () => {
    const fromStorage = readLocalStorageCache();
    if (fromStorage && fromStorage.size > 0) {
      memCache = fromStorage;
      return fromStorage;
    }
    const res = await fetch(RUNES_TEXT_URL);
    if (!res.ok) throw new Error(`rune data fetch ${res.status}`);
    const json = (await res.json()) as RawPerkEntry[];
    const map = new Map<number, RuneDetail>();
    for (const entry of json ?? []) {
      if (!Number.isFinite(entry.id)) continue;
      // Prefer longDesc — CDragon's longDesc has real resolved numbers baked
      // in (see module header); shortDesc is the flavor-only summary ddragon
      // also serves, with no numeric values. Fall back to shortDesc only if
      // a rune has no longDesc at all.
      const raw = (entry.longDesc && entry.longDesc.trim()) || entry.shortDesc || "";
      map.set(entry.id, {
        id: entry.id,
        name: entry.name || `Rune #${entry.id}`,
        descriptionText: stripRuneDescriptionHtml(raw),
      });
    }
    memCache = map;
    writeLocalStorageCache(map);
    return map;
  })();

  inFlight = promise;
  try {
    return await promise;
  } finally {
    inFlight = null;
  }
}

/**
 * Resolve a single rune's detail (name, sanitized value-bearing description)
 * from CommunityDragon's perks.json. `ver` is accepted but unused — kept so
 * EntityDetailPopover's call site (which also needs `ver` for the icon
 * lookup) doesn't need a special case for this one function. Never throws —
 * unknown rune id or any fetch failure resolves to `null` so the caller can
 * degrade to "details unavailable" instead of crashing.
 */
export async function getRuneDetail(id: number, ver: string): Promise<RuneDetail | null> {
  void ver;
  try {
    const map = await loadRuneDataMap();
    return map.get(id) ?? null;
  } catch {
    return null;
  }
}
