// ─────────────────────────────────────────────────────────────────────────────
// staticData.ts — fetch + in-memory cache CDN maps; id→{name,icon} resolvers
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, RoleId } from "./types";
import { getKeystoneData } from "./coachless";

// ── CDN bases ────────────────────────────────────────────────────────────────
//
// Icon/data version folders are DERIVED from the resolved data patch (see
// "Icon CDN version" below, next to the patch-resolution code it depends on)
// instead of hardcoded — the old RUNE_VER="16.11.1"/ASSET_VER="16.12.1" split
// silently drifted further from reality every time the patch probe advanced.

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
  // tree icon — NOT versioned (this path has no per-patch folder at all)
  tree: (treeName: string) =>
    `https://cdn.coachless.gg/runes/${treeName.toLowerCase()}.png`,
  // shard icon (stat-icons) — NOT versioned
  shard: (filename: string) =>
    `https://cdn.coachless.gg/stat-icons/${filename}`,
  // rune perk icon base: append the Icon path from the rune map (.png → .webp)
  rune: (ver: string) => `https://cdn.coachless.gg/static-files/${ver}/img/`,
  item: (id: number, ver: string) =>
    `https://cdn.coachless.gg/static-files/${ver}/${ver}/img/item/${id}.webp`,
  spell: (spellName: string, ver: string) =>
    `https://cdn.coachless.gg/static-files/${ver}/${ver}/img/spell/Summoner${spellName}.webp`,
  champ: (key: string, ver: string) =>
    `https://cdn.coachless.gg/static-files/${ver}/${ver}/img/champion/${key}.webp`,
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

// Stormraider's Surge (id 8230) — reworked/renamed Phase Rush: same id, same
// "PhaseRush" key, new asset filename. The coachless rune bundle still carries
// the OLD path (…/PhaseRush/PhaseRush.png → .webp), which 403s on the CDN.
// components/proAssets.ts has carried this same special case since v0.13.0;
// this builder (used by the BUILD tab's rune card) was missed then and the
// stale path surfaced as a fallback glyph (user-reported 2026-07-21).
const STORMRAIDERS_SURGE_ID = 8230;
const STORMRAIDERS_SURGE_ICON =
  "perk-images/Styles/Sorcery/PhaseRush/StormraidersSurgeRuneIcon2.webp";

/**
 * Convert a rune's Icon path (from the CDN map) to an absolute URL.
 * The map may return .png paths but the served files are .webp.
 * Deathfire Touch's Icon path is missing the perk-images/Styles prefix.
 * `ver` is the resolved-patch version folder (e.g. "16.12.1") — see
 * getIconVersion() below.
 */
export function runeIconUrl(
  runeId: number,
  iconPath: string | undefined,
  ver: string
): string {
  if (runeId === DEATHFIRE_TOUCH_ID) {
    return ICON_BASES.rune(ver) + DEATHFIRE_TOUCH_ICON;
  }
  if (runeId === STORMRAIDERS_SURGE_ID) {
    return ICON_BASES.rune(ver) + STORMRAIDERS_SURGE_ICON;
  }
  if (!iconPath) return "";
  // Replace .png extension with .webp
  const webp = iconPath.replace(/\.png$/i, ".webp");
  return ICON_BASES.rune(ver) + webp;
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

/** ddragon champion.json's `info` block (1-10 scale per axis). Draft redesign
 *  plan §2.1/§2.3 — carried through for the Difficulty column
 *  (info.difficulty) and, server-side only (see getChampionMeta below), the
 *  Suggested Defense derivation (info.attack vs info.magic). */
interface ChampInfoRaw {
  attack: number;
  defense: number;
  magic: number;
  difficulty: number;
}

interface ChampDataEntry {
  id: string; // "Viktor"
  key: string; // "112" (numeric string)
  name: string; // "Viktor"
  /** Present ONLY for entries gap-filled from ddragon (coachless's static
   *  bundle doesn't have this champion yet — see "Champion gap-fill from
   *  ddragon" below). When set, icon resolution uses THIS absolute ddragon
   *  CDN URL directly instead of the coachless-derived ICON_BASES.champ()
   *  path, since coachless has no asset for this key at all. */
  ddragonIconUrl?: string;
  /** Draft redesign plan §2.1 (additive, v0.42.0) — both coachless's bundle
   *  (mirrors ddragon's summary champion.json, see plan §1's investigation)
   *  and ddragon's own champion.json used by the gap-fill path already carry
   *  these fields on the wire; this was just never captured in the TYPE
   *  before now, so no fetch/shape change is needed beyond widening it. */
  info?: ChampInfoRaw;
  tags?: string[];
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

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    next: { revalidate: 86400 }, // cache 24 h
  });
  if (!res.ok) throw new Error(`staticData fetch ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Patch resolution ─────────────────────────────────────────────────────────
//
// GetPatches' request shape is still unconfirmed (see HANDOFF history), so we
// can't ask coachless "what's the current patch" directly. Instead we treat
// ddragon's versions.json as the source of CANDIDATE patches (newest first)
// and probe coachless itself to find which one actually has populated data:
// coachless lags a patch or two behind live release, and some brand-new
// patches return empty rows for every endpoint until their backend catches up.
//
// "Populated" is checked with a single cheap GetKeystoneData call against a
// stable, always-played champ/role (Viktor mid — matches sampleBuild.ts and
// the route tests). First candidate with >=1 keystone row wins.

export interface ResolvedPatch {
  major: number;
  patch: number;
  patchAdditions: number;
  label: string;
}

/** Ultimate static fallback — verified-good data patch. Never remove: this is
 *  what keeps the app from ever going patchless if ddragon AND every probe fail. */
const STATIC_FALLBACK_PATCH: ResolvedPatch = {
  major: 16,
  patch: 11,
  patchAdditions: 0,
  label: "16.11",
};

// Champ/role used to probe candidate patches for live data. Viktor mid is
// played in every patch at high volume, so an empty result reliably means
// "coachless has no data for this patch yet", not "no one plays this combo".
const PROBE_CHAMP_ID = 112; // Viktor
const PROBE_ROLE: RoleId = 2; // Mid

const MAX_PATCH_CANDIDATES = 4;
const PATCH_CACHE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// Failures (ddragon down / every candidate probe failed) get a much shorter
// retry window than a confirmed-good resolution, so a transient coachless
// blip doesn't wedge the app on the static fallback for 6h once it recovers.
const PATCH_CACHE_FAILURE_TTL_MS = 5 * 60 * 1000; // 5m
// Per-candidate probe timeout — caps a single hung coachless socket so it
// can't stall the whole walk (and every request behind it) on a cold start.
const PROBE_TIMEOUT_MS = 4000;

let patchCache: { patch: ResolvedPatch; resolvedAt: number; ok: boolean } | null = null;
// Single-flight guard: while a resolution is in progress, concurrent callers
// (e.g. N requests landing on a cold serverless instance at once, all
// missing the cache) await the SAME walk instead of each launching their own
// ddragon fetch + probe fan-out.
let inFlight: Promise<ResolvedPatch> | null = null;

/** Test-only: clear the module-level patch cache + in-flight guard between test cases. */
export function __resetPatchCacheForTests(): void {
  patchCache = null;
  inFlight = null;
}

/**
 * Parse ddragon's versions.json (newest first, one entry per hotfix) down to
 * distinct major.patch candidates, newest first, capped at MAX_PATCH_CANDIDATES.
 * Pure + exported for direct unit testing.
 */
export function parseDdragonVersions(versions: string[]): ResolvedPatch[] {
  const seen = new Set<string>();
  const out: ResolvedPatch[] = [];
  for (const v of versions) {
    const parts = v.split(".");
    if (parts.length < 2) continue;
    const major = parseInt(parts[0], 10);
    const patch = parseInt(parts[1], 10);
    if (!Number.isFinite(major) || !Number.isFinite(patch)) continue;
    const label = `${major}.${patch}`;
    if (seen.has(label)) continue;
    seen.add(label);
    // patchAdditions has no known ddragon source (GetPatches shape unconfirmed);
    // every verified-working call so far used 0, so we assume 0 for candidates too.
    out.push({ major, patch, patchAdditions: 0, label });
    if (out.length >= MAX_PATCH_CANDIDATES) break;
  }
  return out;
}

/** Probe one candidate patch against coachless; true iff it has keystone data.
 *  Bounded by PROBE_TIMEOUT_MS so a hung socket can't stall the whole walk. */
async function candidateHasData(candidate: ResolvedPatch): Promise<boolean> {
  try {
    const rows = await getKeystoneData(
      PROBE_CHAMP_ID,
      PROBE_ROLE,
      {
        major: candidate.major,
        patch: candidate.patch,
        patchAdditions: candidate.patchAdditions,
      },
      AbortSignal.timeout(PROBE_TIMEOUT_MS)
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    // This candidate's probe failed (network hiccup, timeout, 403/5xx, etc) —
    // not proof the patch is unpopulated, but we can't confirm it either.
    // Move to the next candidate rather than aborting the whole walk (this
    // is exactly what happened live on 2026-07-06: 16.13 403'd, 16.12 had data).
    return false;
  }
}

/** Walk candidates newest→oldest, return the first with live coachless data. */
async function resolveViaProbe(): Promise<ResolvedPatch | null> {
  let candidates: ResolvedPatch[];
  try {
    const versions = await fetchJson<string[]>(CDN.versions);
    candidates = parseDdragonVersions(versions);
  } catch {
    return null; // ddragon unreachable — caller falls back to last-known-good
  }
  for (const candidate of candidates) {
    if (await candidateHasData(candidate)) return candidate;
  }
  return null; // nothing populated yet (or every probe failed)
}

/**
 * Returns the current data patch, e.g. { major:16, patch:12, label:"16.12" }.
 * Resolves to the NEWEST ddragon patch that coachless actually has populated
 * data for (walks up to MAX_PATCH_CANDIDATES candidates newest-first, each
 * probe capped at PROBE_TIMEOUT_MS), hard-caches the result in-memory, and
 * falls back to the last known-good patch (or the static 16.11 default, if
 * this is the very first resolution) on any failure. Concurrent callers that
 * land on a cold/expired cache share a single in-flight resolution (see
 * `inFlight`) rather than each triggering their own ddragon fetch + probe
 * fan-out. `now` is injectable for tests; defaults to the real clock.
 */
export async function getLatestPatch(
  now: () => number = Date.now
): Promise<ResolvedPatch> {
  const t = now();
  if (patchCache) {
    const ttl = patchCache.ok ? PATCH_CACHE_SUCCESS_TTL_MS : PATCH_CACHE_FAILURE_TTL_MS;
    if (t - patchCache.resolvedAt < ttl) return patchCache.patch;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const resolved = await resolveViaProbe();
      if (resolved) {
        patchCache = { patch: resolved, resolvedAt: t, ok: true };
        return resolved;
      }
      const fallback = patchCache?.patch ?? STATIC_FALLBACK_PATCH;
      patchCache = { patch: fallback, resolvedAt: t, ok: false };
      return fallback;
    } finally {
      // Clear regardless of outcome so the NEXT cache-miss (post-TTL) starts
      // a fresh walk instead of permanently reusing this one's result.
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Feature 4 (patch movers): the newest coachless-populated patch STRICTLY OLDER
 * than `current`. Walks the same ddragon candidate list newest→oldest, skipping
 * anything ≥ current, and returns the first older candidate with live keystone
 * data (coachless keeps prior-patch data — VERIFIED: 16.12/16.11/16.10 all
 * populated while 16.13 is current). Returns null if ddragon is unreachable or
 * no older candidate has data (→ caller reports the movers feature unsupported).
 * Not cached: called only by the aggressively-CDN-cached patch-movers route.
 */
export async function getPreviousPopulatedPatch(
  current: ResolvedPatch
): Promise<ResolvedPatch | null> {
  let candidates: ResolvedPatch[];
  try {
    const versions = await fetchJson<string[]>(CDN.versions);
    candidates = parseDdragonVersions(versions);
  } catch {
    return null;
  }
  const older = candidates.filter(
    (c) =>
      c.major < current.major ||
      (c.major === current.major && c.patch < current.patch)
  );
  for (const c of older) {
    if (await candidateHasData(c)) return c;
  }
  return null;
}

// ── Icon CDN version (derived from the resolved data patch) ─────────────────
//
// PROBE EVIDENCE (2026-07-06): coachless's static-files CDN mirrors ddragon's
// per-patch asset bundle and is NOT gated behind WPA-data availability. Curled
// directly against api.coachless.gg's CDN: rune icons, champion/item icons,
// and champion.json/summoner.json data ALL returned 200 under 16.11.1,
// 16.12.1, AND 16.13.1 — even though the coachless STATS API
// (GetKeystoneData) 403'd for 16.13 (WPA not computed yet for that patch).
// So icon/data assets are safe to key off the same RESOLVED patch used for
// stats (today: 16.12), formatted "<major>.<patch>.1". The old split
// (RUNE_VER pinned to 16.11.1, ASSET_VER to 16.12.1) was an artifact of when
// each happened to be manually verified during investigation, not a real
// technical constraint — one version now covers both, and it self-advances
// with getLatestPatch() instead of drifting further every patch.

/** Static fallback version folder, mirrors STATIC_FALLBACK_PATCH. Used only
 *  if getLatestPatch() itself somehow throws (it currently never does — its
 *  own fallback chain always resolves — this is defense in depth so an icon
 *  URL can never come back undefined). */
const ICON_VERSION_FALLBACK = "16.11.1";

/** Pure + exported for direct unit testing. */
export function versionFolder(p: ResolvedPatch): string {
  return `${p.major}.${p.patch}.1`;
}

/** Resolves the CDN folder version string for icons/data JSON. Reuses
 *  getLatestPatch()'s own cache/probe/fallback chain — no separate network
 *  hit or separate cache layer needed. */
async function getIconVersion(): Promise<string> {
  try {
    return versionFolder(await getLatestPatch());
  } catch {
    return ICON_VERSION_FALLBACK;
  }
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
    const ver = await getIconVersion();
    // ddragon champion.json has a wrapper: { type, format, version, data: { Name: {...} } }
    const raw = await fetchJson<{
      data: Record<string, ChampDataEntry>;
    }>(CDN.champs(ver));
    const coachless = Object.values(raw.data);
    const existingIds = new Set(coachless.map((c) => parseInt(c.key, 10)));
    // Gap-fill any champion coachless's bundle doesn't have yet — see
    // "Champion gap-fill from ddragon" below. Coachless stays primary: this
    // only ADDS entries for ids coachless is missing, never overrides one it
    // already has.
    const gaps = await loadDdragonChampionGaps(existingIds);
    champsMap = gaps.length ? [...coachless, ...gaps] : coachless;
  }
  return champsMap;
}

/** Test-only: clear the module-level champion cache between test cases. */
export function __resetChampsCacheForTests(): void {
  champsMap = null;
}

// ── Champion gap-fill from ddragon ───────────────────────────────────────────
//
// coachless's static-files bundle is pinned to whatever data patch got
// resolved for stats (see "Patch resolution" above) and does NOT necessarily
// carry every champion that's live in real games on that patch — a
// brand-new champion (e.g. Locke, id 805, shipped 16.13.1) can appear in
// real match data before coachless's champion.json bundle has a row for it.
// Verified live 2026-07-11/12: Bwipo's Locke games reference id 805, which
// coachless's 172-champion 16.12.1 bundle doesn't have, so the comp
// strips/Teams boxes fell back to a grey "Champion #805" tile and Locke's
// OWN card showed the name (from game.championName) but no portrait.
//
// Fix: after loading coachless's champion list, fetch ddragon's OWN latest
// champion.json (independent of the coachless-resolved patch — ddragon
// ships new champions same-day, coachless lags) and fill in any numeric id
// coachless doesn't have, sourcing name + an absolute ddragon icon URL.
// Coachless stays authoritative for every id it already has; ddragon only
// plugs genuine gaps. Degrades to zero gap-fill (today's exact behavior) on
// any ddragon failure — this is decorative, never load-bearing.

const DDRAGON_CHAMPION_JSON = (ver: string) =>
  `https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`;
const DDRAGON_CHAMPION_ICON = (ver: string, key: string) =>
  `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${key}.png`;

interface DdragonChampionRaw {
  key: string; // numeric string, e.g. "805"
  id: string; // "Locke" (CDN key form)
  name: string; // "Locke" (display name)
  /** Draft redesign plan §2.1 (additive) — ddragon's own champion.json
   *  (this gap-fill path's source) carries the same info/tags shape as
   *  coachless's mirrored bundle. */
  info?: ChampInfoRaw;
  tags?: string[];
}

/** Pure merge logic — given the set of champion ids coachless already has,
 *  plus raw ddragon champion.json data + the ddragon version it came from,
 *  returns ChampDataEntry rows ONLY for ids missing from `existingIds`.
 *  Directly unit-testable against injected fixtures, no network. */
export function findChampionGaps(
  existingIds: Set<number>,
  ddragonVersion: string,
  ddragonChampions: Record<string, DdragonChampionRaw>
): ChampDataEntry[] {
  const gaps: ChampDataEntry[] = [];
  for (const entry of Object.values(ddragonChampions)) {
    const id = parseInt(entry.key, 10);
    if (!Number.isFinite(id) || existingIds.has(id)) continue;
    gaps.push({
      id: entry.id,
      key: entry.key,
      name: entry.name,
      ddragonIconUrl: DDRAGON_CHAMPION_ICON(ddragonVersion, entry.id),
      // Draft redesign plan §2.1: gap-filled champions carry difficulty/tags
      // too (via `info`/`tags` below, undefined when the source entry never
      // had them — never fabricated). Omitted entirely rather than set to
      // undefined-valued keys when absent, so a fixture without these
      // fields still deep-equals a pre-this-change gap entry exactly.
      ...(entry.info ? { info: entry.info } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    });
  }
  return gaps;
}

/** Network wrapper around findChampionGaps: fetches ddragon's latest version
 *  + champion.json. Swallows ANY failure (ddragon down, malformed response,
 *  empty versions list) and returns [] — the caller then behaves exactly as
 *  it did before this feature existed (coachless-only list, grey fallback
 *  tile for an unresolved id). Not memoized separately: it only runs at all
 *  when loadChampsData's own champsMap cache is cold, so it already inherits
 *  that once-per-instance cadence. */
async function loadDdragonChampionGaps(existingIds: Set<number>): Promise<ChampDataEntry[]> {
  try {
    const versions = await fetchJson<string[]>(CDN.versions);
    const ver = versions[0];
    if (!ver) return [];
    const raw = await fetchJson<{ data: Record<string, DdragonChampionRaw> }>(
      DDRAGON_CHAMPION_JSON(ver)
    );
    return findChampionGaps(existingIds, ver, raw.data);
  } catch {
    return [];
  }
}

export async function loadSummonersData(): Promise<SummonerDataEntry[]> {
  if (!summonersMap) {
    const ver = await getIconVersion();
    const raw = await fetchJson<{
      data: Record<string, SummonerDataEntry>;
    }>(CDN.summoners(ver));
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
  const [map, ver] = await Promise.all([loadRuneMap(), getIconVersion()]);
  const entry = map[String(id)];
  return {
    id,
    name: entry?.Name ?? `#${id}`,
    icon: runeIconUrl(id, entry?.Icon, ver),
  };
}

export interface ResolvedItem {
  id: number;
  name: string;
  icon: string;
}

export async function resolveItem(id: number): Promise<ResolvedItem> {
  const [map, ver] = await Promise.all([loadItemsMap(), getIconVersion()]);
  const entry = map[String(id)];
  // items-bundled.json entries are shaped { Id, Name, ... } (capital N).
  const name =
    (entry?.Name as string | undefined) ??
    (entry?.name as string | undefined) ??
    `Item #${id}`;
  return {
    id,
    name,
    icon: ICON_BASES.item(id, ver),
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
  const [spells, ver] = await Promise.all([loadSummonersData(), getIconVersion()]);
  const entry = spells.find((s) => s.key === String(id));
  const suffix = SUMMONER_SUFFIX_MAP[id] ?? entry?.id?.replace(/^Summoner/, "") ?? String(id);
  return {
    id,
    name: entry?.name ?? `Spell #${id}`,
    icon: ICON_BASES.spell(suffix, ver),
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
  const [champs, ver] = await Promise.all([loadChampsData(), getIconVersion()]);
  return champs
    .map((c) => ({
      id: parseInt(c.key, 10),
      key: c.id,
      name: c.name,
      // ddragon-sourced gap-fill entries carry their own absolute icon URL
      // (coachless has no asset for them at all); every coachless-sourced
      // entry keeps using the coachless CDN as before.
      icon: c.ddragonIconUrl ?? ICON_BASES.champ(c.id, ver),
      // Draft redesign plan §2.1 (additive): null/[] when info/tags are
      // genuinely absent (e.g. a malformed upstream entry) -- never a
      // fabricated difficulty number.
      difficulty: c.info?.difficulty ?? null,
      tags: c.tags ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Find champion by numeric id. */
export async function getChampionById(
  id: number
): Promise<ChampionRef | null> {
  const [champs, ver] = await Promise.all([loadChampsData(), getIconVersion()]);
  const c = champs.find((x) => parseInt(x.key, 10) === id);
  if (!c) return null;
  return {
    id,
    key: c.id,
    name: c.name,
    icon: c.ddragonIconUrl ?? ICON_BASES.champ(c.id, ver),
    difficulty: c.info?.difficulty ?? null,
    tags: c.tags ?? [],
  };
}

/** Draft redesign plan §2.3 — server-side-only accessor for the "Suggested
 *  Defense" derivation (lib/draft/damageProfile.ts's suggestedDefense, called
 *  from lib/draft/recommend.ts). Deliberately SEPARATE from
 *  getChampionById/getAllChampions (the public /api/champions contract):
 *  attack/defense/magic are NOT part of ChampionRef's wire shape (keeps the
 *  client contract lean — only difficulty/tags are exposed there, per §2.1's
 *  "join is client-side" design for the Difficulty column). This is the one
 *  place recommend.ts genuinely needs a ddragon-derived value beyond what
 *  ChampionRef exposes. Returns null when the champion isn't found or its
 *  `info` block is missing -- callers (suggestedDefense) already treat a
 *  null info as "nothing to derive a damage-type lean from". */
export interface ChampionMeta {
  tags: string[];
  difficulty: number | null;
  info: { attack: number; defense: number; magic: number } | null;
}

export async function getChampionMeta(id: number): Promise<ChampionMeta | null> {
  const champs = await loadChampsData();
  const c = champs.find((x) => parseInt(x.key, 10) === id);
  if (!c) return null;
  return {
    tags: c.tags ?? [],
    difficulty: c.info?.difficulty ?? null,
    info: c.info ? { attack: c.info.attack, defense: c.info.defense, magic: c.info.magic } : null,
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
