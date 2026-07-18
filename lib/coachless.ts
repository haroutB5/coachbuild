// ─────────────────────────────────────────────────────────────────────────────
// coachless.ts — typed fetch wrappers for api.coachless.gg
// All calls are server-side only (no CORS header from the API).
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleId } from "./types";

const BASE = "https://api.coachless.gg/api/";
const HIGH_ELO_TIERS = [5, 6, 7];

// ── Shared filter shape ──────────────────────────────────────────────────────

export interface Patch {
  major: number;
  patch: number;
  patchAdditions: number;
}

export interface CommonFilters {
  patch: Patch;
  championIds: number[];
  matchupChampionIds: number[] | null;
  leagueTiers: number[];
  regions: null;
  role: RoleId;
}

/**
 * Cross-cutting filter overrides layered onto the default commonFilters.
 *  - `leagueTiers`  — rank-bracket tier set (Feature 3). Omitted → HIGH_ELO_TIERS
 *     (the app's historical default; preserves every existing request byte-for-byte
 *     and therefore the Next fetch-cache keys). Verified live: tiers 3-8 populated,
 *     0-2 / 9-10 empty (see HANDOFF probe evidence).
 *  - `matchupChampionIds` — lane-opponent conditioning (Feature 1). Omitted/null →
 *     unconditioned. VERIFIED LIVE: any non-empty value currently 403s on EVERY
 *     coachless endpoint (matchup conditioning is not exposed on the public API),
 *     so callers must treat a matchup request as best-effort and degrade — see
 *     recommend.ts's probe-gated matchup path.
 */
export interface FilterOpts {
  matchupChampionIds?: number[] | null;
  leagueTiers?: number[];
}

function buildFilters(
  champId: number,
  role: RoleId,
  patch: Patch,
  opts: FilterOpts = {}
): CommonFilters {
  return {
    patch,
    championIds: [champId],
    matchupChampionIds: opts.matchupChampionIds ?? null,
    leagueTiers: opts.leagueTiers ?? HIGH_ELO_TIERS,
    regions: null,
    role,
  };
}

export { HIGH_ELO_TIERS };

// ── Low-level fetch ──────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Next.js fetch caching: cache for 6 h, allow stale reads for 24 h
    next: { revalidate: 21600 },
    signal,
  });
  if (!res.ok) {
    throw new Error(`coachless ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── Response shapes ──────────────────────────────────────────────────────────

export interface RuneEntry {
  rune: number;
  runeType: number; // 0=keystone, 1=minor, 2=shard
  wpaOverall: number;
  occurrence: number;
  runeEffects?: unknown[];
}

export interface ItemEntry {
  itemId: number;
  wpaOverall: number;
  wpaStandalone: number;
  occurrence: number;
  occurrenceRelative: number;
  winrateExpected: number;
  winrateObserved: number;
  averagePurchaseTime: number;
  bias: number;
  goodPurchaseSituations?: unknown[];
}

export interface SpellEntry {
  summonerSpell: number;
  wpaOverall: number;
  occurrence: number;
  occurrenceRelative: number;
  winrateExpected: number;
  winrateObserved: number;
  averageCasts: number;
}

export interface RuneRowsResponse {
  rowOnes: RuneEntry[];
  rowTwos: RuneEntry[];
  rowThrees: RuneEntry[];
}

export interface ShardsResponse {
  offense: RuneEntry[];
  flex: RuneEntry[];
  defense: RuneEntry[];
}

// ── Endpoint wrappers ────────────────────────────────────────────────────────

/** All keystones across every tree. `signal` is optional — used by
 *  staticData.ts's patch-candidate probe to cap each probe at ~4s so a
 *  hung coachless socket can't stall patch resolution on a cold request. */
export function getKeystoneData(
  champId: number,
  role: RoleId,
  patch: Patch,
  signal?: AbortSignal,
  opts?: FilterOpts
): Promise<RuneEntry[]> {
  return post<RuneEntry[]>(
    "Rune/GetKeystoneData",
    { commonFilters: buildFilters(champId, role, patch, opts) },
    signal
  );
}

/**
 * Minor runes for a given tree combination.
 * mainTree = primary tree ID, treeToLoad = tree whose runes to return.
 */
export function getRunesForKeystoneAndTree(
  champId: number,
  role: RoleId,
  patch: Patch,
  mainTree: number,
  treeToLoad: number,
  keystone: number | null = null,
  opts?: FilterOpts
): Promise<RuneRowsResponse> {
  return post<RuneRowsResponse>("Rune/GetRunesForKeystoneAndTree", {
    keystone,
    mainTree,
    treeToLoad,
    commonFilters: buildFilters(champId, role, patch, opts),
  });
}

/** Stat shards for a given keystone context. */
export function getShardsForKeystoneAndTree(
  champId: number,
  role: RoleId,
  patch: Patch,
  keystone: number | null = null,
  opts?: FilterOpts
): Promise<ShardsResponse> {
  return post<ShardsResponse>("Rune/GetShardsForKeystoneAndTree", {
    keystone,
    commonFilters: buildFilters(champId, role, patch, opts),
  });
}

/**
 * Item statistics for one slot+type combination.
 * itemSlots: [1]=first legendary, [2]=second, [3]=third, [4,5,6]=fourth+
 * itemType: 1=legendary, 2=boots, 6=starter
 */
export function getGlobalItemStatistics(
  champId: number,
  role: RoleId,
  patch: Patch,
  itemSlots: number[] | null,
  itemType: number,
  extras: Record<string, unknown> = {},
  opts?: FilterOpts
): Promise<ItemEntry[]> {
  return post<ItemEntry[]>("ChampionWinprob/GetGlobalItemStatistics", {
    itemSlots,
    itemType,
    keystone: null,
    starterId: null,
    firstPurchaseId: null,
    firstLegendaryId: null,
    secondLegendaryId: null,
    // NOTE: item-CONDITIONING (Feature 2) rides `extras`: firstLegendaryId /
    // secondLegendaryId. VERIFIED LIVE they genuinely subset the pool and shift
    // WPA ordering. `thirdLegendaryId` is IGNORED by the API (max 2 priors) —
    // do not add it expecting effect (see HANDOFF probe evidence).
    ...extras,
    commonFilters: buildFilters(champId, role, patch, opts),
  });
}

/** Summoner spell statistics. */
export function getGlobalSummonerSpellStatistics(
  champId: number,
  role: RoleId,
  patch: Patch,
  opts?: FilterOpts
): Promise<SpellEntry[]> {
  return post<SpellEntry[]>("ChampionWinprob/GetGlobalSummonerSpellStatistics", {
    pairedSpell: null,
    commonFilters: buildFilters(champId, role, patch, opts),
  });
}
