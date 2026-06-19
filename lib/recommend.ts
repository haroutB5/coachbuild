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
} from "./coachless";
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

export async function buildRecommendations(
  champId: number,
  role: RoleId
): Promise<BuildResponse[]> {
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
    starterData,
    bootsData,
    leg1Data,
    leg2Data,
    leg3Data,
    leg456Data,
    spellData,
  ] = await Promise.all([
    getKeystoneData(champId, role, patch),
    getShardsForKeystoneAndTree(champId, role, patch, null),
    getGlobalItemStatistics(champId, role, patch, null, 6),
    getGlobalItemStatistics(champId, role, patch, null, 2),
    getGlobalItemStatistics(champId, role, patch, [1], 1),
    getGlobalItemStatistics(champId, role, patch, [2], 1),
    getGlobalItemStatistics(champId, role, patch, [3], 1),
    getGlobalItemStatistics(champId, role, patch, [4, 5, 6], 1),
    getGlobalSummonerSpellStatistics(champId, role, patch),
  ]);

  if (keystoneData.length === 0) {
    throw new NotPlayedInRoleError(
      `Champion ${champion.name} has no data for role ${role}`
    );
  }

  const totalGames = keystoneData.reduce((s, e) => s + e.occurrence, 0);
  const bar = adoptionBar(totalGames);
  const noiseFloor = Math.max(800, totalGames * 0.002);

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
  const fourthPlusBests = orderedLegendaries.slice(3, 6).map((o) => o.entry);

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
          champId, role, patch, primaryTreeId, treeToLoad, null
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
          champId, role, patch, treeId, treeId, null
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
      const [keystonePick, primaryMinorPicks, secondaryPicks] = await Promise.all([
        runeEntryToPick(pg.cfg.keystone, bar),
        Promise.all(pg.cfg.primaryMinors.map((e) => runeEntryToPick(e, bar))),
        Promise.all(pg.sec.displayRunes.map((rp) => runeEntryToPick(rp.entry, bar))),
      ]);
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
        tierLabel: "High Elo",
        runes,
        spells: spellPicks,
        items,
        generatedAt,
        sources: { provider: "coachless.gg" },
        rank: idx + 1,
        label: VARIANT_LABELS[idx] ?? `Option ${idx + 1}`,
        subtitle: `${treeName(pg.cfg.treeId)} + ${treeName(pg.sec.treeId)}`,
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
