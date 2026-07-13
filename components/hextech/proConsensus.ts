// Pure aggregation over ProGame[] — "what do pros actually build" for the new
// PRO CONSENSUS card (v0.27.0 user request: "pro players seem to build
// Rocketbelt on Viktor — create another builds and runes space based on what
// pro players are often building"). Complements the WPA-ranked recommendation
// (lib/recommend.ts, backend, coachless-sourced) with a plain frequency count
// over the SAME champion-scoped pro-games feed ProBuildsTab/PRO BUILDS already
// lists (GET /api/pros?championId=&role=&source=all) — no backend change.
//
// No JSX in this file (vitest 4's oxc transform can't parse JSX outside its
// default scope — same constraint runesPage.ts documents) so it stays
// importable from a plain .ts test file.

import type { ProGame } from "@/components/proGames.types";
import { CONSUMABLE_ITEM_IDS } from "@/components/proAssets";

export interface ItemFrequency {
  itemId: number;
  count: number;
  share: number; // count / gamesTotal
}

export interface KeystoneFrequency {
  keystoneId: number;
  count: number;
  share: number; // count / runesSampleSize
}

export interface TreeFrequency {
  treeId: number;
  count: number;
  share: number; // count / secondaryTreeSampleSize
}

export interface SpellPairFrequency {
  /** Canonical (ascending-id) pair — the same pick with keys swapped (Flash
   *  on D vs F) must count as one combo, not two. Display order is a render
   *  concern, not this module's. */
  spells: [number, number];
  count: number;
  share: number; // count / spellSampleSize
}

export interface TournamentBreakdown {
  /** Unique prostage `tournament` strings seen in the sample, most-frequent
   *  first (ties broken by first-seen order — stable, no invented ranking). */
  names: string[];
  soloqCount: number;
  prostageCount: number;
}

export interface ProConsensusModel {
  /** Total games the aggregation ran over — the sample-size line's
   *  denominator ("From N pro games"). */
  gamesTotal: number;
  /** Top items by pick rate (present at least once in a game's finalItems),
   *  consumables/trinket-slot noise excluded, boots included (a real build
   *  choice players care about). Deduplicated per game — a game that somehow
   *  lists the same id twice only counts once, so this is a true "N of M
   *  games" pick rate, not a raw occurrence tally. Sorted by count desc, then
   *  itemId asc for a deterministic tie order. */
  items: ItemFrequency[];
  /** Null when no game in the sample carries a resolved keystone (id 0 is
   *  the "unresolved/missing" sentinel — real for prostage rows Leaguepedia
   *  never populated a Runes column for, see lib/prostage/extract.ts). */
  keystone: KeystoneFrequency | null;
  /** Denominator for keystone.share — games with a resolved (non-zero)
   *  keystone, NOT gamesTotal, so a champion with lots of rune-less prostage
   *  rows doesn't silently dilute the fraction shown for the ones that do
   *  have data. */
  runesSampleSize: number;
  secondaryTree: TreeFrequency | null;
  /** Denominator for secondaryTree.share — games with a resolved
   *  (non-zero) secondary tree. Tracked SEPARATELY from runesSampleSize:
   *  Leaguepedia can populate KeystoneRune without PrimaryTree/SecondaryTree
   *  or vice versa (resolveRunes in lib/prostage/extract.ts resolves each
   *  field independently), so a game can count toward one denominator and
   *  not the other — sharing one counter would silently over- or
   *  under-state whichever fraction borrowed the wrong sample size (caught
   *  by this module's own tests before it ever left proConsensus.ts). */
  secondaryTreeSampleSize: number;
  spellPair: SpellPairFrequency | null;
  /** Denominator for spellPair.share — games with BOTH spell slots resolved
   *  (neither id is the 0 sentinel). */
  spellSampleSize: number;
  tournaments: TournamentBreakdown;
}

const TOP_ITEMS_LIMIT = 6;

function bump<K extends string | number>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Sort by count desc, tie-broken by the key itself asc — deterministic
 *  output regardless of Map insertion order (which follows first-seen game,
 *  not id). */
function sortEntries<K extends number>(map: Map<K, number>): [K, number][] {
  return Array.from(map.entries()).sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] - b[0]));
}

export function aggregateProConsensus(games: ProGame[]): ProConsensusModel {
  const gamesTotal = games.length;

  const itemCounts = new Map<number, number>();
  const keystoneCounts = new Map<number, number>();
  const secondaryTreeCounts = new Map<number, number>();
  const spellPairCounts = new Map<string, number>();
  const spellPairValue = new Map<string, [number, number]>();

  let runesSampleSize = 0;
  let secondaryTreeSampleSize = 0;
  let spellSampleSize = 0;

  const tournamentNames: string[] = [];
  const tournamentSeen = new Set<string>();
  let soloqCount = 0;
  let prostageCount = 0;

  for (const game of games) {
    const seenItems = new Set<number>();
    for (const itemId of game.finalItems ?? []) {
      if (!itemId || CONSUMABLE_ITEM_IDS.has(itemId)) continue;
      seenItems.add(itemId);
    }
    seenItems.forEach((itemId) => bump(itemCounts, itemId));

    const keystone = game.runes?.keystone ?? 0;
    if (keystone > 0) {
      runesSampleSize += 1;
      bump(keystoneCounts, keystone);
    }
    const secondaryTree = game.runes?.secondaryTree ?? 0;
    if (secondaryTree > 0) {
      secondaryTreeSampleSize += 1;
      bump(secondaryTreeCounts, secondaryTree);
    }

    const [s1, s2] = game.spells ?? [0, 0];
    if (s1 > 0 && s2 > 0) {
      spellSampleSize += 1;
      const pair: [number, number] = s1 <= s2 ? [s1, s2] : [s2, s1];
      const key = `${pair[0]}-${pair[1]}`;
      bump(spellPairCounts, key);
      spellPairValue.set(key, pair);
    }

    if (game.source === "soloq") {
      soloqCount += 1;
    } else if (game.source === "prostage") {
      prostageCount += 1;
      if (game.tournament && !tournamentSeen.has(game.tournament)) {
        tournamentSeen.add(game.tournament);
        tournamentNames.push(game.tournament);
      }
    }
  }

  const items: ItemFrequency[] = sortEntries(itemCounts)
    .slice(0, TOP_ITEMS_LIMIT)
    .map(([itemId, count]) => ({ itemId, count, share: gamesTotal > 0 ? count / gamesTotal : 0 }));

  const topKeystone = sortEntries(keystoneCounts)[0];
  const keystone: KeystoneFrequency | null = topKeystone
    ? { keystoneId: topKeystone[0], count: topKeystone[1], share: topKeystone[1] / runesSampleSize }
    : null;

  const topSecondary = sortEntries(secondaryTreeCounts)[0];
  const secondaryTree: TreeFrequency | null = topSecondary
    ? { treeId: topSecondary[0], count: topSecondary[1], share: topSecondary[1] / secondaryTreeSampleSize }
    : null;

  const topSpellKey = Array.from(spellPairCounts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const av = spellPairValue.get(a[0])!;
    const bv = spellPairValue.get(b[0])!;
    return av[0] !== bv[0] ? av[0] - bv[0] : av[1] - bv[1];
  })[0];
  const spellPair: SpellPairFrequency | null = topSpellKey
    ? {
        spells: spellPairValue.get(topSpellKey[0])!,
        count: topSpellKey[1],
        share: topSpellKey[1] / spellSampleSize,
      }
    : null;

  return {
    gamesTotal,
    items,
    keystone,
    runesSampleSize,
    secondaryTree,
    secondaryTreeSampleSize,
    spellPair,
    spellSampleSize,
    tournaments: {
      names: tournamentNamesSortedByFrequency(games, tournamentNames),
      soloqCount,
      prostageCount,
    },
  };
}

/** Re-orders tournamentNames (first-seen order) by actual occurrence count
 *  desc, stable on ties (Array.prototype.sort is stable per spec) — so e.g.
 *  a tournament with 6 of the sample's games surfaces before one with 1,
 *  regardless of which game happened to be fetched first. */
function tournamentNamesSortedByFrequency(games: ProGame[], firstSeenOrder: string[]): string[] {
  const freq = new Map<string, number>();
  for (const game of games) {
    if (game.source === "prostage" && game.tournament) {
      freq.set(game.tournament, (freq.get(game.tournament) ?? 0) + 1);
    }
  }
  return [...firstSeenOrder].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));
}
