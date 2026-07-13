// Pure aggregation over ProGame[] — "what do pros actually build" for the
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
//
// v0.27.1 — three refinements on the live card (user feedback on a Viktor Mid
// screenshot): percentages alongside every fraction, the FULL aggregated rune
// picture (not just keystone + secondary tree name), and a real completed-
// item filter (Needlessly Large Rod, a component, was showing up next to
// Blackfire Torch).
//
// ── Completed-item rule (requirement #3) ────────────────────────────────────
// An item id counts as a real "build" entry — not a discardable mid-build
// component — when EITHER:
//   1. It's in STARTING_ITEM_ALLOWLIST below (a short, explicit list of
//      items pros commonly finish a game holding even though they're not
//      "complete" in the recipe-tree sense — Dark Seal and Tear of the
//      Goddess both have a real `into` upgrade path, so the empty-into rule
//      alone would wrongly exclude them). A few allowlist entries (Doran's
//      x3, Cull, World Atlas, the Guardian's starters) are ALREADY empty-
//      into today and would pass rule 2 on their own — they're pinned here
//      too as an explicit, patch-proof guarantee per the brief's request for
//      "an explicit STARTING-item allowlist," not because today's data needs
//      it for those specific ids.
//   2. Its real ddragon item data (passed in via `itemMeta`, sourced from
//      components/itemDetail.ts's getItemDetailMap — same CDN mirror the
//      icons/tooltips already use) says `purchasable !== false` AND either:
//        (a) it has NO further `into` upgrade (a true recipe-tree leaf —
//            covers Blackfire Torch, Rocketbelt, Zhonya's, tier-3 boot
//            enchants like Swiftmarch, and every other "final" item), OR
//        (b) it carries the "Boots" tag and has a non-empty `from` (the
//            2026 boot-mastery rework added a THIRD boots tier — a tier-2
//            boot like Sorcerer's Shoes still has an `into` pointing at its
//            optional tier-3 enchant, so the plain empty-into rule would
//            wrongly treat a very common real build state — "never bought
//            the enchant" — as an unfinished component. Any boots item built
//            from something (i.e. not the raw tier-1 "Boots") is a
//            legitimate final boots choice regardless of whether a further
//            enchant exists).
// An item id with NO metadata in `itemMeta` (fetch failed, or a genuinely
// unknown/legacy id) is excluded by default UNLESS it's in the allowlist —
// same "never assume, never invent" posture the rest of this module already
// applies to rune sample sizes. Verified against a live 16.13.1 item.json
// pull (2026-07-13): Needlessly Large Rod (1058) has `into` populated (6
// core mage items) and is not allowlisted → excluded, matching the brief.
//
// ── Rune slot aggregation (requirement #2) ──────────────────────────────────
// `ProGameRunes.primary`/`secondary` are NOT reliably row-ordered across both
// sources: lib/pro/extract.ts (soloq, from Riot's perks.styles[n].selections)
// preserves row order, but lib/prostage/extract.ts (pro play, from
// Leaguepedia's free-text "Runes" list) buckets by parent tree with no row
// guarantee — see that module's resolveRunes(). Reconstructing "row 1 pick"
// vs "row 2 pick" would silently overclaim structure the data doesn't
// reliably carry. Instead this aggregates FLAT frequency, same pattern as
// items/keystone: every id that appears anywhere in a game's primary[] (resp.
// secondary[]/shards[]) counts once per game, ranked by count. Each slot
// group gets its OWN sample-size denominator — games where that specific
// array was non-empty — never gamesTotal, so a champion with lots of
// keystone-only prostage rows doesn't dilute the fraction shown for games
// that DID carry a full page. `shards` in particular is structurally
// soloq-only today (lib/prostage/extract.ts's resolveRunes always returns
// `shards: []` — Leaguepedia has no shard data at all), which is why each
// breakdown also reports its own soloq/prostage split, so the UI can render
// an honest "from N solo-queue games" note instead of a bare fraction that
// implies the same coverage a keystone fraction has.

import type { ProGame } from "@/components/proGames.types";
import { CONSUMABLE_ITEM_IDS } from "@/components/proAssets";
import type { ItemDetail } from "@/components/itemDetail";

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

export interface RuneSlotFrequency {
  runeId: number;
  count: number;
  share: number; // count / the owning RuneSlotBreakdown.sampleSize
}

export interface RuneSlotBreakdown {
  /** Top picks for this slot group, sorted count desc then runeId asc. */
  entries: RuneSlotFrequency[];
  /** Denominator for every entry's share — games whose payload carried at
   *  least one id in this slot group, NOT gamesTotal (see module header). */
  sampleSize: number;
  /** Of sampleSize, how many came from each source — lets the UI render an
   *  honest "from N solo-queue games" note when a slot is structurally
   *  soloq-only (shards, today) instead of implying prostage coverage that
   *  was never there. */
  soloqCount: number;
  prostageCount: number;
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
  /** Top NON-boots items by pick rate (present at least once in a game's
   *  finalItems), filtered to completed items + the starting-item allowlist
   *  (see module header) — components like Needlessly Large Rod never appear
   *  here. Consumables/trinket-slot noise excluded via the existing
   *  CONSUMABLE_ITEM_IDS. Deduplicated per game — a game that somehow lists
   *  the same id twice only counts once, so this is a true "N of M games"
   *  pick rate, not a raw occurrence tally. Sorted by count desc, then
   *  itemId asc for a deterministic tie order. share is against gamesTotal
   *  (unchanged denominator — filtering removes disqualified items, it
   *  doesn't shrink the sample). Boots are carved out into `boots` below
   *  (v0.28.0 user report: Crimson Lucidity + Spellslinger's Shoes each ate a
   *  full item slot on the same champion — a real item couldn't fit) so this
   *  list is never diluted by a second boots entry. */
  items: ItemFrequency[];
  /** v0.28.0 — top 2 boots choices by pick rate, carved out of `items` so a
   *  champion with a split boots preference (e.g. Crimson Lucidity 35% vs.
   *  Spellslinger's Shoes 27%) occupies ONE grid slot instead of two,
   *  freeing a slot for an actual non-boots item. Partitioned from the SAME
   *  completed-item counts `items` draws from (via `itemMeta`'s `tags`,
   *  `Array.isArray(meta.tags) && meta.tags.includes("Boots")` — the same
   *  defensive guard `isBootsFinal` uses) — an item with no metadata at all
   *  is never classified as boots (stays out of this list, same "never
   *  assume" posture as the rest of this module). share is against
   *  gamesTotal, same denominator as `items` — these are still two
   *  independent per-boot fractions, not a merged combined stat. */
  boots: ItemFrequency[];
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
  /** v0.27.1 — top 3 primary-tree minor runes by frequency (a real page has
   *  exactly 3 minor rows below the keystone), flat-aggregated per the
   *  module header note. */
  primaryMinors: RuneSlotBreakdown;
  /** v0.27.1 — top 2 secondary-tree picks by frequency (a real page has
   *  exactly 2). */
  secondaryPicks: RuneSlotBreakdown;
  /** v0.27.1 — top 3 stat shards by frequency. Structurally soloq-only
   *  today (see module header) — soloqCount/prostageCount on the breakdown
   *  make that visible rather than asserted. */
  shards: RuneSlotBreakdown;
  spellPair: SpellPairFrequency | null;
  /** Denominator for spellPair.share — games with BOTH spell slots resolved
   *  (neither id is the 0 sentinel). */
  spellSampleSize: number;
  tournaments: TournamentBreakdown;
}

const TOP_ITEMS_LIMIT = 6;
const TOP_BOOTS_LIMIT = 2;
const TOP_PRIMARY_MINORS_LIMIT = 3;
const TOP_SECONDARY_PICKS_LIMIT = 2;
const TOP_SHARDS_LIMIT = 3;

/** Explicit starting-item allowlist (requirement #3) — see the module header
 *  comment for which entries are load-bearing today (Dark Seal, Tear of the
 *  Goddess — both have a real `into` upgrade path) vs. pinned defensively
 *  (everything else here is already empty-into and would pass the general
 *  completed-item rule on its own). */
const STARTING_ITEM_ALLOWLIST = new Set<number>([
  1054, // Doran's Shield
  1055, // Doran's Blade
  1056, // Doran's Ring
  1082, // Dark Seal — upgrades into Mejai's Soulstealer; still a real build choice
  1083, // Cull
  3070, // Tear of the Goddess — upgrades into Manamune/Archangel's/Winter's Approach/Whispering Circlet
  3865, // World Atlas (support starter)
  2049, // Guardian's Amulet (support starter)
  2050, // Guardian's Shroud (support starter)
]);

/** Boots special case — see module header (b). A tier-2 boot (e.g.
 *  Sorcerer's Shoes) still has an `into` pointing at its optional tier-3
 *  enchant, so it fails the plain empty-into check even though "stopped at
 *  tier 2" is a completely normal final build state.
 *
 *  Defensive against a malformed `meta`: this ultimately reads from
 *  JSON.parse'd localStorage (components/itemDetail.ts), and a real prod
 *  incident (v0.27.2 hotfix) showed a stale pre-v0.27.1 cache entry can
 *  arrive here with `tags`/`from` undefined even though ItemDetail's TYPE
 *  says they're always arrays — itemDetail.ts now normalizes on read/write,
 *  but this guards independently so a future shape change degrades instead
 *  of throwing (`Cannot read properties of undefined (reading 'includes')`). */
function isBootsFinal(meta: ItemDetail): boolean {
  return Array.isArray(meta.tags) && meta.tags.includes("Boots") && Array.isArray(meta.from) && meta.from.length > 0;
}

/** v0.28.0 — is this a boots item at all, for the items/boots grid partition
 *  (a lighter check than `isBootsFinal`, which additionally requires a
 *  non-empty `from` to exclude the raw tier-1 Boots). Reused here because a
 *  tier-1 raw Boots never reaches this function in the first place — it's
 *  already excluded by `isBuildItem` upstream — so `tags.includes("Boots")`
 *  alone is sufficient once an id has passed that filter. No metadata at all
 *  -> never classified as boots (same "never assume" default as the rest of
 *  this module). */
function isBootsTag(meta: ItemDetail | undefined): boolean {
  return !!meta && Array.isArray(meta.tags) && meta.tags.includes("Boots");
}

/** True when `itemId` belongs in the aggregated items list — a real build
 *  choice, not a mid-build component. Exported for direct unit testing.
 *
 *  Guards `meta.into` the same defensive way isBootsFinal guards
 *  `tags`/`from` — see that function's comment for why. */
export function isBuildItem(itemId: number, meta: ItemDetail | undefined): boolean {
  if (STARTING_ITEM_ALLOWLIST.has(itemId)) return true;
  if (!meta) return false; // unknown item data — exclude rather than assume
  if (meta.purchasable === false) return false;
  if (isBootsFinal(meta)) return true;
  // Array.isArray guard (not just `meta.into.length === 0`): a malformed/
  // legacy meta with `into` missing entirely is unknown, not "finished" —
  // same "never assume, never invent" posture as the `!meta` branch above,
  // so it's excluded rather than defaulting to true.
  return Array.isArray(meta.into) && meta.into.length === 0;
}

function bump<K extends string | number>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Sort by count desc, tie-broken by the key itself asc — deterministic
 *  output regardless of Map insertion order (which follows first-seen game,
 *  not id). */
function sortEntries<K extends number>(map: Map<K, number>): [K, number][] {
  return Array.from(map.entries()).sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] - b[0]));
}

/** Accumulator for one rune slot group (primary minors / secondary picks /
 *  shards) — bump() once per distinct id seen in a game's slot array, plus
 *  the sample-size + source-split counters, then finalize() into the public
 *  RuneSlotBreakdown shape. */
class RuneSlotAccumulator {
  private counts = new Map<number, number>();
  sampleSize = 0;
  soloqCount = 0;
  prostageCount = 0;

  add(ids: number[], source: ProGame["source"]): void {
    if (ids.length === 0) return;
    this.sampleSize += 1;
    if (source === "soloq") this.soloqCount += 1;
    else this.prostageCount += 1;
    new Set(ids).forEach((id) => bump(this.counts, id));
  }

  finalize(limit: number): RuneSlotBreakdown {
    const entries: RuneSlotFrequency[] = sortEntries(this.counts)
      .slice(0, limit)
      .map(([runeId, count]) => ({
        runeId,
        count,
        share: this.sampleSize > 0 ? count / this.sampleSize : 0,
      }));
    return { entries, sampleSize: this.sampleSize, soloqCount: this.soloqCount, prostageCount: this.prostageCount };
  }
}

export function aggregateProConsensus(
  games: ProGame[],
  itemMeta: Map<number, ItemDetail>
): ProConsensusModel {
  const gamesTotal = games.length;

  const itemCounts = new Map<number, number>();
  const keystoneCounts = new Map<number, number>();
  const secondaryTreeCounts = new Map<number, number>();
  const spellPairCounts = new Map<string, number>();
  const spellPairValue = new Map<string, [number, number]>();

  const primaryMinors = new RuneSlotAccumulator();
  const secondaryPicks = new RuneSlotAccumulator();
  const shards = new RuneSlotAccumulator();

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
      if (!isBuildItem(itemId, itemMeta.get(itemId))) continue;
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

    primaryMinors.add(game.runes?.primary ?? [], game.source);
    secondaryPicks.add(game.runes?.secondary ?? [], game.source);
    shards.add(game.runes?.shards ?? [], game.source);

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

  // v0.28.0: partition the SAME sorted (count desc, itemId asc) entries into
  // boots vs. non-boots, preserving relative order within each subset —
  // simpler and less error-prone than maintaining two separate accumulator
  // maps during the game loop above.
  const sortedItemEntries = sortEntries(itemCounts);
  const toFrequency = ([itemId, count]: [number, number]): ItemFrequency => ({
    itemId,
    count,
    share: gamesTotal > 0 ? count / gamesTotal : 0,
  });
  const items: ItemFrequency[] = sortedItemEntries
    .filter(([itemId]) => !isBootsTag(itemMeta.get(itemId)))
    .slice(0, TOP_ITEMS_LIMIT)
    .map(toFrequency);
  const boots: ItemFrequency[] = sortedItemEntries
    .filter(([itemId]) => isBootsTag(itemMeta.get(itemId)))
    .slice(0, TOP_BOOTS_LIMIT)
    .map(toFrequency);

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
    boots,
    keystone,
    runesSampleSize,
    secondaryTree,
    secondaryTreeSampleSize,
    primaryMinors: primaryMinors.finalize(TOP_PRIMARY_MINORS_LIMIT),
    secondaryPicks: secondaryPicks.finalize(TOP_SECONDARY_PICKS_LIMIT),
    shards: shards.finalize(TOP_SHARDS_LIMIT),
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

/** Formats a 0-1 share as a whole-percent string ("90%") — rounds, never
 *  shows a decimal (fractions here are already low-precision pick-rate
 *  counts, a decimal would imply false precision). Exported so the card
 *  never hand-rolls its own rounding. */
export function formatSharePct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
