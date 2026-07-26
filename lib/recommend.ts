// ─────────────────────────────────────────────────────────────────────────────
// recommend.ts — THE ENGINE
// All-trees, confidence-weighted recommendation. Returns the TOP 3 viable setups,
// evaluating every PRIMARY tree (keystone) AND every secondary tree. Variants
// prefer different primary trees; they fall back to secondary variation when one
// primary tree dominates.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  RoleId,
  Pick,
  BuildResponse,
  TreeRef,
  RunesBlock,
  ItemsBlock,
  ShardSet,
  TreeId,
} from "./types";
import {
  getKeystoneData,
  getRunesForKeystoneAndTree,
  getShardsForKeystoneAndTree,
  getGlobalItemStatistics,
  getGlobalSummonerSpellStatistics,
  type RuneEntry,
  type ItemEntry,
  type SpellEntry,
  type FilterOpts,
} from "./coachless";
import {
  buildOptimizedPath,
  resolveMatchupSlot,
  OPTIMIZER_MIN_SAMPLE,
  OPTIMIZER_ADOPT_FRAC,
  MATCHUP_MIN_SAMPLE,
  MATCHUP_MIN_TOTAL,
} from "./buildConditioning";
import { DEFAULT_RANK_BRACKET, type RankBracket } from "./rankBrackets";
import { capExtraFullItems } from "./buildSlotCap";
import { collapseSupportFinalPools } from "./supportFinalGroup";
import {
  getLatestPatch,
  getChampionById,
  resolveRune,
  resolveItem,
  resolveSpell,
  resolveShardSync,
  treeIcon,
  treeName,
  treeIdFromIconPath,
  loadRuneMap,
} from "./staticData";

// ── Tree constants ────────────────────────────────────────────────────────────

const ALL_TREES: number[] = [8000, 8100, 8200, 8300, 8400];

// ── Confidence-weighted ranking ────────────────────────────────────────────────
// A "recommended" pick must be played in at least ADOPT_FRAC of the champion's
// TOTAL games in this role (the global adoption bar). Tiny-sample WPA spikes
// surface only as lower-ranked variants. (User decision 2026-06-14.)
const ADOPT_FRAC = 0.05;
const ADOPT_FLOOR = 500;

function adoptionBar(totalGames: number): number {
  return Math.max(ADOPT_FLOOR, totalGames * ADOPT_FRAC);
}

/** Highest WPA among GLOBALLY-adopted entries (occ >= bar); falls back to the
 *  most-played. Never null for a non-empty list. Used for headline single picks. */
function pickRecommended<T extends { wpaOverall: number; occurrence: number }>(
  entries: T[],
  bar: number
): T | null {
  if (entries.length === 0) return null;
  const adopted = entries.filter((e) => e.occurrence >= bar);
  if (adopted.length > 0) {
    return adopted.slice().sort((a, b) => b.wpaOverall - a.wpaOverall)[0];
  }
  return entries.slice().sort((a, b) => b.occurrence - a.occurrence)[0] ?? null;
}

/** Highest WPA among entries clearing a flat noise floor; falls back to most-played. */
function bestAboveFloor(entries: RuneEntry[], floor: number): RuneEntry | null {
  const ok = entries.filter((e) => e.occurrence >= floor);
  if (ok.length > 0) return ok.slice().sort((a, b) => b.wpaOverall - a.wpaOverall)[0];
  return entries.slice().sort((a, b) => b.occurrence - a.occurrence)[0] ?? null;
}

/** Most-PLAYED positive-WPA entry above the noise floor (reliable pick), or null. */
function bestPositiveByOcc(entries: RuneEntry[], floor: number): RuneEntry | null {
  const ok = entries.filter((e) => e.occurrence >= floor && e.wpaOverall > 0);
  if (ok.length === 0) return null;
  return ok.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}

function isLowSample(entry: { occurrence: number }, bar: number): boolean {
  return entry.occurrence < bar;
}

// ── Converters to the Pick shape ───────────────────────────────────────────────

async function runeEntryToPick(entry: RuneEntry, bar: number): Promise<Pick> {
  const resolved = await resolveRune(entry.rune);
  return {
    id: entry.rune,
    name: resolved.name,
    icon: resolved.icon,
    wpa: entry.wpaOverall,
    winrate: null,
    occurrence: entry.occurrence,
    lowSample: isLowSample(entry, bar),
  };
}

async function itemEntryToPick(entry: ItemEntry, bar: number): Promise<Pick> {
  const resolved = await resolveItem(entry.itemId);
  return {
    id: entry.itemId,
    name: resolved.name,
    icon: resolved.icon,
    wpa: entry.wpaOverall,
    winrate: entry.winrateObserved ?? null,
    occurrence: entry.occurrence,
    lowSample: isLowSample(entry, bar),
  };
}

async function spellEntryToPick(entry: SpellEntry, bar: number): Promise<Pick> {
  const resolved = await resolveSpell(entry.summonerSpell);
  return {
    id: entry.summonerSpell,
    name: resolved.name,
    icon: resolved.icon,
    wpa: entry.wpaOverall,
    winrate: entry.winrateObserved ?? null,
    occurrence: entry.occurrence,
    lowSample: isLowSample(entry, bar),
  };
}

function shardEntryToPick(entry: RuneEntry, bar: number): Pick {
  const { name, icon } = resolveShardSync(entry.rune);
  return {
    id: entry.rune,
    name,
    icon,
    wpa: entry.wpaOverall,
    winrate: null,
    occurrence: entry.occurrence,
    lowSample: isLowSample(entry, bar),
  };
}

// ── Item selection (adoption-aware, with dedup support) ────────────────────────

function bestItem(
  entries: ItemEntry[],
  exclude: Set<number> | undefined,
  bar: number
): ItemEntry | null {
  const pool0 = exclude
    ? entries.filter((e) => !exclude.has(e.itemId))
    : entries;
  if (pool0.length === 0) return null;
  const adopted = pool0.filter((e) => e.occurrence >= bar);
  if (adopted.length > 0) {
    return adopted.sort((a, b) => b.wpaOverall - a.wpaOverall)[0];
  }
  return pool0.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}

function topItems(entries: ItemEntry[], n: number, bar: number): ItemEntry[] {
  const adopted = entries.filter((e) => e.occurrence >= bar);
  const pool = adopted.length > 0 ? adopted : entries;
  return pool.slice().sort((a, b) => b.wpaOverall - a.wpaOverall).slice(0, n);
}

/** Up to 2 DISTINCT summoner spells: adopted (>=bar) by WPA first, then fill from
 *  the rest of the pool by occurrence. Caller strips Smite for non-jungle roles. */
export function pickSpells(spellPool: SpellEntry[], bar: number): SpellEntry[] {
  const picks: SpellEntry[] = [];
  const add = (list: SpellEntry[]) => {
    for (const s of list) {
      if (picks.length >= 2) break;
      if (!picks.some((p) => p.summonerSpell === s.summonerSpell)) picks.push(s);
    }
  };
  add(
    spellPool
      .filter((s) => s.occurrence >= bar)
      .sort((a, b) => b.wpaOverall - a.wpaOverall)
  );
  add(spellPool.slice().sort((a, b) => b.occurrence - a.occurrence));
  return picks.slice(0, 2);
}

// ── Tree helpers ────────────────────────────────────────────────────────────

const TREE_REF = (treeId: number): TreeRef => ({
  id: treeId as TreeId,
  name: treeName(treeId),
  icon: treeIcon(treeId),
});

// A row pick keeps the chosen entry plus its row index (one rune per row).
interface RowPick {
  entry: RuneEntry;
  rowIdx: number;
}

function rowPicks(
  rows: (RuneEntry[] | undefined)[],
  selector: (row: RuneEntry[]) => RuneEntry | null
): RowPick[] {
  const out: RowPick[] = [];
  rows.forEach((row, rowIdx) => {
    if (!row || row.length === 0) return;
    const pick = selector(row);
    if (pick) out.push({ entry: pick, rowIdx });
  });
  return out;
}

function top2ByWpa(picks: RowPick[]): RowPick[] {
  return picks.slice().sort((a, b) => b.entry.wpaOverall - a.entry.wpaOverall).slice(0, 2);
}

function top2ByOcc(picks: RowPick[]): RowPick[] {
  return picks.slice().sort((a, b) => b.entry.occurrence - a.entry.occurrence).slice(0, 2);
}

interface SecondaryCandidate {
  treeId: number;
  reliable: RowPick[]; // top-2 most-played positive runes
  byWpa: RowPick[]; // top-2 best-WPA runes above the noise floor (#1 fill)
  byWpaViable: RowPick[]; // top-2 NON-NEGATIVE best-WPA runes (for alternatives)
  reliableScore: number;
  reliableCount: number;
  wpaScore: number;
  hasTwoViable: boolean;
  displayRunes: RowPick[]; // the 2 runes this candidate actually shows
}

interface PrimaryConfig {
  treeId: number;
  keystone: RuneEntry;
  keystoneOcc: number;
  primaryMinors: RuneEntry[];
  secondaries: SecondaryCandidate[]; // ranked; [0] = reliable winner, rest = viable alts
}

// ── Main: top-3 recommended setups ─────────────────────────────────────────────

export interface BuildOptions {
  /** Feature 1: lane-opponent champion id. Attempts matchup-conditioned picks;
   *  degrades to the standard build per-slot when data is missing/insufficient
   *  (today ALWAYS — the coachless matchup path 403s; see HANDOFF). */
  enemyChampionId?: number | null;
  /** Feature 3: resolved rank bracket. Defaults to High Elo ([5,6,7]) — the
   *  app's historical behaviour — when omitted, keeping request bytes (and the
   *  Next fetch-cache key) identical to pre-feature builds. */
  rankBracket?: RankBracket | null;
}

export async function buildRecommendations(
  champId: number,
  role: RoleId,
  options: BuildOptions = {}
): Promise<BuildResponse[]> {
  const bracket = options.rankBracket ?? DEFAULT_RANK_BRACKET;
  // Only pin leagueTiers when a NON-default bracket is chosen — the default
  // 'all' bracket ([5,6,7]) is exactly buildFilters' own default, so leaving
  // leagueTiers undefined keeps the request byte-identical to legacy builds.
  const filterOpts: FilterOpts =
    bracket.id === DEFAULT_RANK_BRACKET.id ? {} : { leagueTiers: bracket.apiValue };
  const enemyId =
    options.enemyChampionId != null && Number.isFinite(options.enemyChampionId)
      ? options.enemyChampionId
      : null;

  const patchInfo = await getLatestPatch();
  const patch = {
    major: patchInfo.major,
    patch: patchInfo.patch,
    patchAdditions: patchInfo.patchAdditions,
  };

  const champion = await getChampionById(champId);
  if (!champion) {
    // Unknown / invalid champion id → 404, not a 500.
    throw new NotPlayedInRoleError(`Champion ${champId} not found`);
  }

  const [
    keystoneData,
    shardsData,
    rawStarterData,
    rawBootsData,
    rawLeg1Data,
    rawLeg2Data,
    rawLeg3Data,
    rawLeg456Data,
    spellData,
  ] = await Promise.all([
    getKeystoneData(champId, role, patch, undefined, filterOpts),
    getShardsForKeystoneAndTree(champId, role, patch, null, filterOpts),
    getGlobalItemStatistics(champId, role, patch, null, 6, {}, filterOpts),
    getGlobalItemStatistics(champId, role, patch, null, 2, {}, filterOpts),
    getGlobalItemStatistics(champId, role, patch, [1], 1, {}, filterOpts),
    getGlobalItemStatistics(champId, role, patch, [2], 1, {}, filterOpts),
    getGlobalItemStatistics(champId, role, patch, [3], 1, {}, filterOpts),
    getGlobalItemStatistics(champId, role, patch, [4, 5, 6], 1, {}, filterOpts),
    getGlobalSummonerSpellStatistics(champId, role, patch, filterOpts),
  ]);

  if (keystoneData.length === 0) {
    throw new NotPlayedInRoleError(
      `Champion ${champion.name} has no data for role ${role}`
    );
  }

  // ── Mutually-exclusive support-quest finals: one family, one entry ─────────
  // The five support-quest finals (Dream Maker / Zaz'Zak's / Bloodsong /
  // Celestial Opposition / Solstice Sleigh) are ONE choice — Bounty of Worlds
  // upgrades into exactly one — so the engine must never reason over two of
  // them. Every gate below (`usedItems`, `pathItemIds`, `usedM`) dedupes by
  // EXACT ID and cannot see the family, so the invariant is enforced HERE, at
  // the data boundary, once, where every consumer inherits it.
  //
  // This is an identity transform against today's live data and is expected to
  // stay one: the finals are coachless ItemType 3, and nothing here requests
  // type 3 (probe evidence in supportFinalGroup.ts's header). It is the guard
  // for the day that changes — by an added type-3 fetch or an upstream
  // reclassification — not a fix for something currently visible.
  //
  // NOT covered, deliberately (see HANDOFF-engy.md): the optimizer's own
  // conditioned fetches and the matchup-conditioned pools below. Both mix a
  // freshly-fetched pool with an already-committed pick from these pools, so
  // making them correct needs cross-source family state rather than a pool
  // filter, and the matchup path is verified-403 dead code today.
  const [starterData, bootsData, leg1Data, leg2Data, leg3Data, leg456Data] =
    collapseSupportFinalPools([
      rawStarterData,
      rawBootsData,
      rawLeg1Data,
      rawLeg2Data,
      rawLeg3Data,
      rawLeg456Data,
    ]);

  const totalGames = keystoneData.reduce((s, e) => s + e.occurrence, 0);
  const bar = adoptionBar(totalGames);
  // P3(b) fix (2026-07-17 Fable review): the noise floor is supposed to be a
  // LOWER/looser threshold than the headline adoption bar (bar = max(500,
  // total*0.05); see adoptionBar above) — but with the old flat component of
  // 800, bar only exceeds 800 once total > 16,000 (0.05*16000 = 800). Below
  // that (the vast majority of real champ+role combos — most sit well under
  // 16k games), the "noise floor" was HIGHER than the bar it's meant to sit
  // under, i.e. inverted: an item/rune the adoption bar already accepted as
  // reliable could still fail the supposedly-looser noise floor. Decision
  // (exactly this change, nothing else): drop the flat component 800 -> 400.
  // 400 <= bar's own floor (500) always holds, and for total > 10,000 (where
  // bar's 0.05 scaling term overtakes its 500 floor) 400 stays under bar's
  // scaling term too — so noiseFloor <= bar across the ENTIRE small/mid
  // sample regime this was broken in. Once total is large enough that
  // noiseFloor's own 0.002 scaling term exceeds 400 (total > 200,000), that
  // term was already correctly BELOW bar's 0.05 term (0.002 < 0.05) even
  // before this fix — that large-sample regime is untouched. Ran the full
  // suite after this change: no snapshot/recommendation test shifted — no
  // test in this repo exercises buildRecommendations end-to-end against real
  // coachless data (route.test.ts mocks the engine; recommend.test.ts tests
  // pure ranking primitives with a LITERAL floor param, never this constant).
  const noiseFloor = Math.max(400, totalGames * 0.002);

  // ── Shared parts (identical across every variant) ──────────────────────────
  const bestOffense = pickRecommended(shardsData.offense ?? [], bar);
  const bestFlex = pickRecommended(shardsData.flex ?? [], bar);
  const bestDefense = pickRecommended(shardsData.defense ?? [], bar);
  if (!bestOffense || !bestFlex || !bestDefense) {
    // Too little data for this champ in this role → 404, not a 500.
    throw new NotPlayedInRoleError(
      `${champion.name} has no shard data for role ${role}`
    );
  }

  const starterBest = bestItem(starterData, undefined, bar);
  const bootsBest = bestItem(bootsData, undefined, bar);
  // Build the legendary sequence from non-empty slot pools in order (supports buy
  // a support item in slot 1, so the [1] legendary pool is often empty).
  const usedItems = new Set<number>();
  const orderedLegendaries: { entry: ItemEntry; pool: ItemEntry[] }[] = [];
  for (const pool of [leg1Data, leg2Data, leg3Data]) {
    const pick = bestItem(pool, usedItems, bar);
    if (pick) {
      orderedLegendaries.push({ entry: pick, pool });
      usedItems.add(pick.itemId);
    }
  }
  for (const pick of topItems(
    leg456Data.filter((e) => !usedItems.has(e.itemId)),
    4,
    bar
  )) {
    if (!usedItems.has(pick.itemId)) {
      orderedLegendaries.push({ entry: pick, pool: leg456Data });
      usedItems.add(pick.itemId);
    }
  }
  if (!starterBest || !bootsBest || orderedLegendaries.length < 3) {
    // Champion barely/never played in this role (sparse item data) → 404.
    throw new NotPlayedInRoleError(
      `${champion.name} has too little item data for role ${role}`
    );
  }
  const leg1Best = orderedLegendaries[0].entry;
  const leg2Best = orderedLegendaries[1].entry;
  const leg3Best = orderedLegendaries[2].entry;
  // 6-slot game reality (user hard directive, 2026-07-24): first/second/third
  // above are the confirmed core (3 full items, never trimmed); everything
  // beyond that is "extra" and must respect the role's slot budget on top of
  // that fixed-3 prefix + the always-present boots slot (bootsBest, checked
  // below) — see buildSlotCap.ts. orderedLegendaries is already WPA-sorted
  // best-first per slot (topItems), so slicing the tail off here drops the
  // LOWEST-value surplus, preserving relative order — never a reorder.
  const fourthPlusBests = capExtraFullItems(
    orderedLegendaries.slice(3).map((o) => o.entry),
    /* fixedCount = */ 3,
    role
  );

  // Per-slot alternatives (situational swaps): top items in the slot's pool by
  // WPA above the noise floor, excluding the items already in the core path.
  const pathItemIds = new Set(orderedLegendaries.map((o) => o.entry.itemId));
  const itemAlts = (
    pool: ItemEntry[],
    excludeIds: Set<number>,
    n: number
  ): ItemEntry[] =>
    pool
      .filter((e) => !excludeIds.has(e.itemId) && e.occurrence >= noiseFloor)
      .sort((a, b) => b.wpaOverall - a.wpaOverall)
      .slice(0, n);
  const bootsAltEntries = itemAlts(bootsData, new Set([bootsBest.itemId]), 3);
  const firstAltEntries = itemAlts(orderedLegendaries[0].pool, pathItemIds, 3);
  const secondAltEntries = itemAlts(orderedLegendaries[1].pool, pathItemIds, 3);
  const thirdAltEntries = itemAlts(orderedLegendaries[2].pool, pathItemIds, 3);

  const spellPool =
    role === 1 ? spellData : spellData.filter((s) => s.summonerSpell !== 11);
  const spellRanked = pickSpells(spellPool, bar);

  const [
    starterPick,
    bootsPick,
    firstPick,
    secondPick,
    thirdPick,
    fourthPlusPicks,
    spellPicks,
    bootsAlts,
    firstAlts,
    secondAlts,
    thirdAlts,
  ] = await Promise.all([
    itemEntryToPick(starterBest, bar),
    itemEntryToPick(bootsBest, bar),
    itemEntryToPick(leg1Best, bar),
    itemEntryToPick(leg2Best, bar),
    itemEntryToPick(leg3Best, bar),
    Promise.all(fourthPlusBests.map((e) => itemEntryToPick(e, bar))),
    Promise.all(spellRanked.map((e) => spellEntryToPick(e, bar))),
    Promise.all(bootsAltEntries.map((e) => itemEntryToPick(e, bar))),
    Promise.all(firstAltEntries.map((e) => itemEntryToPick(e, bar))),
    Promise.all(secondAltEntries.map((e) => itemEntryToPick(e, bar))),
    Promise.all(thirdAltEntries.map((e) => itemEntryToPick(e, bar))),
  ]);
  while (spellPicks.length < 2) {
    // Distinct fallback: add Flash, or Ignite if Flash is already chosen.
    const fillerId = spellPicks.some((p) => p.id === 4) ? 14 : 4;
    spellPicks.push({
      id: fillerId,
      name: fillerId === 4 ? "Flash" : "Ignite",
      icon: (await resolveSpell(fillerId)).icon,
      wpa: 0,
      winrate: null,
      occurrence: 0,
    });
  }
  const shards: ShardSet = {
    offense: shardEntryToPick(bestOffense, bar),
    flex: shardEntryToPick(bestFlex, bar),
    defense: shardEntryToPick(bestDefense, bar),
  };
  const items: ItemsBlock = {
    starter: starterPick,
    boots: bootsPick,
    first: firstPick,
    second: secondPick,
    third: thirdPick,
    fourthPlus: fourthPlusPicks,
    alts: {
      ...(bootsAlts.length ? { boots: bootsAlts } : {}),
      ...(firstAlts.length ? { first: firstAlts } : {}),
      ...(secondAlts.length ? { second: secondAlts } : {}),
      ...(thirdAlts.length ? { third: thirdAlts } : {}),
    },
  };

  // ── Feature 2: sequential item optimizer (greedy WPA-optimal core chain) ────
  // Seed with the core first legendary, then condition each subsequent slot on
  // OWNING the running prefix (coachless firstLegendaryId/secondLegendaryId,
  // VERIFIED to subset the pool + shift WPA). Truncates when a conditioned slot
  // has no candidate clearing OPTIMIZER_MIN_SAMPLE. Depth 2 beyond the seed =>
  // path length ≤ 3 (the API conditions on ≤ 2 priors). Additive: attached only
  // when the chain has ≥ 2 items (a 1-item "path" carries no sequence info).
  const optimizedRest = await buildOptimizedPath<ItemEntry>(
    async (prefix) => {
      const slot = prefix.length + 1; // seed(len 1) → slot 2; then → slot 3
      if (slot > 3) return [];
      const extras: Record<string, unknown> = { firstLegendaryId: prefix[0] };
      if (prefix.length >= 2) extras.secondLegendaryId = prefix[1];
      return getGlobalItemStatistics(champId, role, patch, [slot], 1, extras, filterOpts);
    },
    2,
    OPTIMIZER_MIN_SAMPLE,
    [leg1Best.itemId],
    OPTIMIZER_ADOPT_FRAC
  );
  // Defensive: the optimizer's own depth cap (buildOptimizedPath's maxDepth=2
  // beyond the seed) already keeps this at <=3 entries today, well under any
  // role's full-item budget (5 or 6) — but route it through the same
  // buildSlotCap choke point so a future depth increase can't reopen the
  // 6-slot violation on this line too (OPTIMIZED ORDER is one of the two
  // surfaces the cap directive explicitly names).
  const optimizedEntries = [leg1Best, ...capExtraFullItems(optimizedRest, 1, role)];
  if (optimizedEntries.length >= 2) {
    items.optimizedPath = await Promise.all(
      optimizedEntries.map((e) => itemEntryToPick(e, bar))
    );
  }

  // ── Feature 1: matchup probe + per-slot conditioning ───────────────────────
  // The coachless matchup path (matchupChampionIds) is VERIFIED to 403 on every
  // endpoint today, so `supported` is effectively always false and the build
  // falls back fully. The probe is real (one keystone call), and the conditioning
  // below is gated on it — so if coachless ever exposes matchup, this activates
  // with no code change. Keystone conditioning happens per-variant in the loop
  // below (reusing this probe's data). `matchupInfo` is attached to every variant.
  let matchupInfo: BuildResponse["matchup"] | undefined;
  let matchupKeystoneData: RuneEntry[] | null = null;
  const mcf = (): FilterOpts => ({ ...filterOpts, matchupChampionIds: [enemyId as number] });
  if (enemyId != null) {
    try {
      const md = await getKeystoneData(champId, role, patch, undefined, mcf());
      const total = Array.isArray(md) ? md.reduce((s, e) => s + e.occurrence, 0) : 0;
      if (Array.isArray(md) && md.length > 0 && total >= MATCHUP_MIN_TOTAL) {
        matchupKeystoneData = md;
        matchupInfo = { enemyChampionId: enemyId, gamesCount: total, supported: true };
      } else {
        matchupInfo = { enemyChampionId: enemyId, gamesCount: total, supported: false };
      }
    } catch {
      matchupInfo = { enemyChampionId: enemyId, gamesCount: 0, supported: false };
    }

    if (matchupInfo.supported) {
      // Condition the shared core items + spells on the matchup, per-slot fallback.
      const [m1, m2, m3, mSpells] = await Promise.all([
        getGlobalItemStatistics(champId, role, patch, [1], 1, {}, mcf()),
        getGlobalItemStatistics(champId, role, patch, [2], 1, {}, mcf()),
        getGlobalItemStatistics(champId, role, patch, [3], 1, {}, mcf()),
        getGlobalSummonerSpellStatistics(champId, role, patch, mcf()),
      ]);
      const usedM = new Set<number>();
      const condSlots: [ItemEntry, ItemEntry[]][] = [
        [leg1Best, m1],
        [leg2Best, m2],
        [leg3Best, m3],
      ];
      const condItemPicks = await Promise.all(
        condSlots.map(async ([fallback, pool]) => {
          const res = resolveMatchupSlot(
            pool, fallback, MATCHUP_MIN_SAMPLE, (e) => usedM.has(e.itemId)
          );
          usedM.add(res.entry.itemId);
          const pick = await itemEntryToPick(res.entry, bar);
          pick.matchupConditioned = res.conditioned;
          return pick;
        })
      );
      items.first = condItemPicks[0];
      items.second = condItemPicks[1];
      items.third = condItemPicks[2];

      const mPool = role === 1 ? mSpells : mSpells.filter((s) => s.summonerSpell !== 11);
      const mRanked = pickSpells(mPool, MATCHUP_MIN_SAMPLE);
      if (mRanked.length >= 1) {
        const condSpells = await Promise.all(
          mRanked.map(async (e) => {
            const p = await spellEntryToPick(e, bar);
            p.matchupConditioned = true;
            return p;
          })
        );
        // Backfill to 2 from the unconditioned spells (flagged not-conditioned).
        for (const s of spellPicks) {
          if (condSpells.length >= 2) break;
          if (!condSpells.some((c) => c.id === s.id)) {
            condSpells.push({ ...s, matchupConditioned: false });
          }
        }
        spellPicks.splice(0, spellPicks.length, ...condSpells.slice(0, 2));
      } else {
        spellPicks.forEach((p) => (p.matchupConditioned = false));
      }
    } else {
      // Unsupported (the live case): stamp the shared slots as fell-back.
      items.first.matchupConditioned = false;
      items.second.matchupConditioned = false;
      items.third.matchupConditioned = false;
      spellPicks.forEach((p) => (p.matchupConditioned = false));
    }
  }

  // ── Map each keystone to its primary tree ──────────────────────────────────
  const runeMap = await loadRuneMap();
  const keystoneTree = (id: number): number | null => {
    const icon = runeMap[String(id)]?.Icon;
    const t = icon ? treeIdFromIconPath(icon) : null;
    if (t) return t;
    if (id === 8992) return 8200; // Deathfire Touch has a custom icon path → Sorcery
    return null;
  };
  const keysByTree = new Map<number, RuneEntry[]>();
  for (const k of keystoneData) {
    const t = keystoneTree(k.rune);
    if (t == null) continue;
    const arr = keysByTree.get(t);
    if (arr) arr.push(k);
    else keysByTree.set(t, [k]);
  }

  // Reliable runes for variant #1's secondary; fill from best-WPA if < 2 positive.
  function displayReliable(c: SecondaryCandidate): RowPick[] {
    const picks = [...c.reliable];
    if (picks.length < 2) {
      for (const rp of c.byWpa) {
        if (picks.length >= 2) break;
        if (!picks.some((p) => p.rowIdx === rp.rowIdx)) picks.push(rp);
      }
    }
    return picks.slice(0, 2);
  }

  // Ranked secondary candidates for a given primary tree.
  async function secondariesFor(primaryTreeId: number): Promise<SecondaryCandidate[]> {
    const cands: SecondaryCandidate[] = await Promise.all(
      ALL_TREES.filter((t) => t !== primaryTreeId).map(async (treeToLoad) => {
        const rows = await getRunesForKeystoneAndTree(
          champId, role, patch, primaryTreeId, treeToLoad, null, filterOpts
        );
        const rowArr = [rows.rowOnes, rows.rowTwos, rows.rowThrees];
        const reliable = top2ByOcc(
          rowPicks(rowArr, (r) => bestPositiveByOcc(r, noiseFloor))
        );
        const wpaRowPicks = rowPicks(rowArr, (r) => bestAboveFloor(r, noiseFloor));
        const byWpa = top2ByWpa(wpaRowPicks);
        const byWpaViable = top2ByWpa(
          wpaRowPicks.filter((p) => p.entry.wpaOverall >= 0)
        );
        return {
          treeId: treeToLoad,
          reliable,
          byWpa,
          byWpaViable,
          reliableScore: reliable.reduce((s, r) => s + r.entry.occurrence, 0),
          reliableCount: reliable.length,
          wpaScore: byWpaViable.reduce((s, r) => s + r.entry.wpaOverall, 0),
          hasTwoViable: byWpaViable.length >= 2,
          displayRunes: [],
        };
      })
    );
    const ranked = cands.slice().sort((a, b) => {
      const aOk = a.reliableCount >= 2 ? 1 : 0;
      const bOk = b.reliableCount >= 2 ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      if (b.reliableScore !== a.reliableScore) return b.reliableScore - a.reliableScore;
      return b.wpaScore - a.wpaScore;
    });
    const winner = ranked[0];
    if (winner) winner.displayRunes = displayReliable(winner);
    const alts = ranked
      .slice(1)
      .filter((c) => c.hasTwoViable)
      .sort((a, b) => b.wpaScore - a.wpaScore);
    for (const a of alts) a.displayRunes = a.byWpaViable;
    return [winner, ...alts].filter((c) => c && c.displayRunes.length >= 2);
  }

  // ── Build a PrimaryConfig per VIABLE primary tree (adopted keystone) ───────
  const primaryConfigs = (
    await Promise.all(
      Array.from(keysByTree.entries()).map(async ([treeId, ks]) => {
        const adopted = ks.filter((k) => k.occurrence >= bar);
        if (adopted.length === 0) return null;
        // Display the best-WPA keystone among the well-adopted ones (confidence-
        // weighted, consistent with every other slot). Tree RANKING still uses raw
        // adoption (below) so the primary tree stays the conventional one.
        const keystone = pickRecommended(adopted, bar) ?? adopted[0];
        const treePopularity = Math.max(...adopted.map((k) => k.occurrence));
        const primRows = await getRunesForKeystoneAndTree(
          champId, role, patch, treeId, treeId, null, filterOpts
        );
        const primaryMinors = rowPicks(
          [primRows.rowOnes, primRows.rowTwos, primRows.rowThrees],
          (r) => pickRecommended(r, bar)
        ).map((rp) => rp.entry);
        const secondaries = await secondariesFor(treeId);
        if (secondaries.length === 0) return null;
        return { treeId, keystone, keystoneOcc: treePopularity, primaryMinors, secondaries };
      })
    )
  ).filter((c): c is PrimaryConfig => c !== null);

  if (primaryConfigs.length === 0) {
    throw new NotPlayedInRoleError(
      `Champion ${champion.name} has no viable keystone for role ${role}`
    );
  }
  // Most-played primary tree first (reliability).
  primaryConfigs.sort((a, b) => b.keystoneOcc - a.keystoneOcc);

  // ── Top-3 pages: prefer DIFFERENT primary trees, then secondary alts of #1 ──
  interface Page { cfg: PrimaryConfig; sec: SecondaryCandidate }
  const pages: Page[] = [];
  for (const cfg of primaryConfigs) {
    if (pages.length >= 3) break;
    pages.push({ cfg, sec: cfg.secondaries[0] });
  }
  if (pages.length < 3) {
    const top = primaryConfigs[0];
    for (const sec of top.secondaries.slice(1)) {
      if (pages.length >= 3) break;
      pages.push({ cfg: top, sec });
    }
  }
  const top3 = pages.slice(0, 3);

  // ── Assemble variants ──────────────────────────────────────────────────────
  const { ROLE_LABEL } = await import("./types");
  const generatedAt = new Date().toISOString();
  const VARIANT_LABELS = ["Top pick", "Alternative", "Alternative"];

  const variants = await Promise.all(
    top3.map(async (pg, idx) => {
      // Feature 1: matchup-condition this variant's keystone using the probe
      // data (filtered to this variant's primary tree). Falls back to the
      // unconditioned keystone per-slot when conditioned support is thin.
      let keystoneEntry = pg.cfg.keystone;
      let keystoneConditioned: boolean | undefined;
      if (enemyId != null) {
        if (matchupInfo?.supported && matchupKeystoneData) {
          const treeKs = matchupKeystoneData.filter(
            (k) => keystoneTree(k.rune) === pg.cfg.treeId
          );
          const res = resolveMatchupSlot(treeKs, pg.cfg.keystone, MATCHUP_MIN_SAMPLE);
          keystoneEntry = res.entry;
          keystoneConditioned = res.conditioned;
        } else {
          keystoneConditioned = false;
        }
      }
      const [keystonePick, primaryMinorPicks, secondaryPicks] = await Promise.all([
        runeEntryToPick(keystoneEntry, bar),
        Promise.all(pg.cfg.primaryMinors.map((e) => runeEntryToPick(e, bar))),
        Promise.all(pg.sec.displayRunes.map((rp) => runeEntryToPick(rp.entry, bar))),
      ]);
      if (keystoneConditioned !== undefined) {
        keystonePick.matchupConditioned = keystoneConditioned;
      }
      const runes: RunesBlock = {
        primaryTree: TREE_REF(pg.cfg.treeId),
        secondaryTree: TREE_REF(pg.sec.treeId),
        keystone: keystonePick,
        primary: primaryMinorPicks,
        secondary: secondaryPicks,
        shards,
      };
      const build: BuildResponse = {
        champion,
        role,
        roleLabel: ROLE_LABEL[role],
        patch: patchInfo.label,
        tierLabel: bracket.label,
        runes,
        spells: spellPicks,
        items,
        generatedAt,
        sources: { provider: "coachless.gg" },
        rank: idx + 1,
        label: VARIANT_LABELS[idx] ?? `Option ${idx + 1}`,
        subtitle: `${treeName(pg.cfg.treeId)} + ${treeName(pg.sec.treeId)}`,
        rankBracket: bracket.id,
        ...(matchupInfo ? { matchup: matchupInfo } : {}),
      };
      return build;
    })
  );

  return variants;
}

/** Back-compat: the single top build. */
export async function buildRecommendation(
  champId: number,
  role: RoleId
): Promise<BuildResponse> {
  const [top] = await buildRecommendations(champId, role);
  if (!top) {
    throw new NotPlayedInRoleError(
      `No build for champion ${champId} role ${role}`
    );
  }
  return top;
}

// ── Custom error ──────────────────────────────────────────────────────────────

export class NotPlayedInRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPlayedInRoleError";
  }
}
