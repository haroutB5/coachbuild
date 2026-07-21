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
// ── Starters get their OWN slot, never `items` (2026-07-22) ────────────────
// The rule above still decides whether an allowlisted id counts as "a real
// build entry" at all — that part is unchanged. What changed is WHERE it
// lands: previously every id that passed the rule (allowlist or recipe-tree
// leaf alike) was aggregated into ONE `items` list, so Dark Seal/Tear of the
// Goddess sat in the same grid as Blackfire Torch/Rabadon's — a hard user
// directive (screenshot-verified, live Pro Consensus card on Viktor mid:
// "Dark Seal 24% (23/95)" mixed into the ITEMS grid) says a starter must
// NEVER render as a completed item anywhere in the app. Fix: after the same
// aggregation pass, `STARTING_ITEM_ALLOWLIST` ids are partitioned OUT of
// `items` into their own `starters` field — same mechanical pattern v0.28.0
// already used to carve `boots` out of `items` (see that field's own doc
// comment). isBuildItem/the rule above is untouched (still the single source
// of truth for "does this id count at all"); only the aggregateProConsensus
// partition step changed.
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
//
// ── Tree-conditioned rune page (v0.29.0) ────────────────────────────────────
// BUG THIS FIXES (live user report on a champion with a modal-only keystone —
// e.g. Deathfire Touch 16/30): before v0.29.0 primaryMinors/secondaryPicks/
// secondaryTree were FLAT frequency aggregates over ALL games regardless of
// each game's primary tree. When the top keystone is only modal (16 of 30
// games), the OTHER 14 games run different primary trees, so THEIR primary[]
// runes leaked into the minors row and THEIR secondary trees/picks leaked into
// the secondary column — producing an impossible in-game page: minors mixing
// two trees, and a "secondary tree" equal to the primary tree, and a rune
// appearing as BOTH a primary minor AND a secondary pick.
//
// FIX: condition the whole displayed page on the top keystone's TREE.
//   1. Top keystone stays modal over ALL games with a resolved keystone
//      (unchanged — the "16/30" fraction the card shows is honest).
//   2. Resolve the page's PRIMARY TREE from the game data itself — every game
//      carries runes.primaryTree (set by lib/pro/extract.ts from Riot's perk
//      styles, and lib/prostage/extract.ts from Leaguepedia's PrimaryTree
//      column), so NO hardcoded keystone→tree table is needed. We prefer the
//      tree the modal keystone actually ran under (resolvePrimaryTree below).
//   3. PAGE SAMPLE = games whose runes.primaryTree === that tree. Within a
//      game, primary[] is already tree-consistent (both extract paths bucket
//      by parent tree), so the incoherence came ONLY from mixing games with
//      different primary trees — conditioning the sample removes it at the
//      source.
//   4. primaryMinors aggregate primary[] ONLY over the page sample (keystone
//      ids filtered defensively — both extract paths already drop them).
//   5. secondaryTree = modal secondaryTree over the page sample EXCLUDING the
//      primary tree (a page can never run its own primary tree as secondary).
//      secondaryPicks aggregate secondary[] only over page-sample games whose
//      secondaryTree equals that modal tree — so every pick belongs to the
//      displayed secondary tree and, being a different tree from the primary,
//      can never share a rune id with a primary minor.
//   6. Every conditioned breakdown's sampleSize reflects its OWN conditioned
//      sample (the per-slot-denominator honesty pattern is preserved).
//   7. shards + spell pair + items/boots are tree-INDEPENDENT and stay
//      aggregated over every game, exactly as before.
// Residual data-quality edge (documented, not a regression): prostage's
// resolveRunes has a `parentStyleId === 0` best-guess fallback that files a
// bare-id rune of unknown parent into primary[]; if such a rune truly belonged
// to the secondary tree it could, in theory, still cross rows. That path is
// rare (Leaguepedia usually resolves parent styles) and out of scope for a
// per-game tree conditioning fix — the invariant holds for all
// parent-resolved data, which is the overwhelming majority.
//
// ── Fallback-tree/keystone consistency guard (v0.29.1, Fable review 2026-07-17) ──
// BUG THIS FIXES: resolvePrimaryTree's fallback branch fires when EVERY game
// carrying the modal keystone has an unresolved primaryTree (real for prostage
// rows where Leaguepedia's Cargo resolved KeystoneRune but not PrimaryTree) —
// it then returns the SAMPLE-WIDE modal tree, which can belong entirely to a
// DIFFERENT keystone's games. Left unguarded, aggregateProConsensus would
// still show the ORIGINAL modal keystone in the tile while conditioning the
// page (minors/secondaryTree/secondaryPicks) on that foreign tree's games —
// the exact "impossible page" class v0.29.0 closed for the main path,
// reopened on the fallback branch (keystone tile above a tree header/minors
// that keystone never actually ran with).
//
// FIX: after resolving primaryTreeId and its pageSample, check whether the
// pageSample contains ANY game that ran the displayed (phase-A modal)
// keystone. If it does (the common case, including every already-tested
// v0.29.0 path), nothing changes. If it doesn't:
//   (a) Recompute the keystone as the fallback tree's OWN modal keystone
//       (modal over pageSample only) so tile and page agree — "drop the
//       keystone to the fallback tree's modal keystone." Its count/share/
//       runesSampleSize are then scoped to pageSample, not gamesTotal, so
//       the fraction shown stays honest about what population it describes.
//   (b) If pageSample itself has no resolved keystone either (nothing to
//       pair the page with honestly), degrade to the EXISTING tree-less
//       pattern: keep the original global-modal keystone (still an honest
//       fraction on its own) but drop the page (primaryTree -> null, empty
//       minors/secondary) rather than pairing it with a page it never ran.

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
  /** Top NON-boots, NON-starter items by pick rate (present at least once in
   *  a game's finalItems), filtered to completed items via `isBuildItem`
   *  (see module header) — components like Needlessly Large Rod never appear
   *  here. Consumables/trinket-slot noise excluded via the existing
   *  CONSUMABLE_ITEM_IDS. Deduplicated per game — a game that somehow lists
   *  the same id twice only counts once, so this is a true "N of M games"
   *  pick rate, not a raw occurrence tally. Sorted by count desc, then
   *  itemId asc for a deterministic tie order. share is against gamesTotal
   *  (unchanged denominator — filtering removes disqualified items, it
   *  doesn't shrink the sample). Boots are carved out into `boots` below
   *  (v0.28.0 user report: Crimson Lucidity + Spellslinger's Shoes each ate a
   *  full item slot on the same champion — a real item couldn't fit) and
   *  STARTING_ITEM_ALLOWLIST entries (Dark Seal, Tear of the Goddess, etc.)
   *  are carved out into `starters` below (2026-07-22 hard user directive —
   *  "Dark Seal must NEVER appear as a full/completed item ANYWHERE in the
   *  app" — live repro was exactly this list mixing Dark Seal in with
   *  Blackfire Torch/Rabadon's/etc.) so this list is never diluted by either. */
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
  /** 2026-07-22 — top starter-class items (STARTING_ITEM_ALLOWLIST — Dark
   *  Seal, Tear of the Goddess, the Doran's/Cull/support-starter entries),
   *  carved out of `items` for the SAME reason `boots` was in v0.28.0: a
   *  starter is a real build choice worth showing, but it belongs in its own
   *  labeled slot, never mixed into the completed-item grid (hard user
   *  directive, 2026-07-22, screenshot-verified: Pro Consensus's ITEMS grid
   *  on Viktor mid showed "Dark Seal 24%" sitting next to Blackfire Torch/
   *  Rabadon's — this field is what closes that). Partitioned from the SAME
   *  sorted counts `items`/`boots` draw from (via
   *  `STARTING_ITEM_ALLOWLIST.has(itemId)`, checked AFTER the boots check —
   *  no current allowlist entry carries the "Boots" tag, but boots takes
   *  precedence by construction if that ever changed). share is against
   *  gamesTotal, same denominator as `items`/`boots`. Empty when the sample
   *  never built a starter-class item (e.g. matchups where every game
   *  reached a full recipe-tree item instead) — the card renders no slot at
   *  all in that case, same "absent, not empty" convention `boots` already
   *  established. */
  starters: ItemFrequency[];
  /** Null when no game in the sample carries a resolved keystone (id 0 is
   *  the "unresolved/missing" sentinel — real for prostage rows Leaguepedia
   *  never populated a Runes column for, see lib/prostage/extract.ts).
   *  Normally the modal keystone over ALL games with a resolved keystone
   *  (unchanged by tree conditioning). v0.29.1: on the rare degenerate path
   *  where that modal keystone's own games never carried a resolved
   *  primaryTree AND the fallback tree resolvePrimaryTree lands on belongs
   *  to a DIFFERENT keystone, this is overridden to the fallback tree's OWN
   *  modal keystone instead — see the module header's "Fallback-tree/
   *  keystone consistency guard" — so this field and `primaryTree` always
   *  describe one coherent page, never a keystone paired with a tree it
   *  didn't run. */
  keystone: KeystoneFrequency | null;
  /** Denominator for keystone.share — games with a resolved (non-zero)
   *  keystone, NOT gamesTotal, so a champion with lots of rune-less prostage
   *  rows doesn't silently dilute the fraction shown for the ones that do
   *  have data. v0.29.1: scoped down to the fallback tree's own resolved-
   *  keystone count on the degenerate guard path above, so it stays the
   *  correct denominator for whatever `keystone` ends up being. */
  runesSampleSize: number;
  /** v0.29.0 — the page's PRIMARY tree id (8000 Precision … 8400 Resolve),
   *  resolved from the game data itself (each game's runes.primaryTree),
   *  preferring the tree the modal keystone ran under. Null when NO game in
   *  the sample carried resolved tree data (conditioning then yields an empty
   *  page sample — an honest "no tree data" state, not a fabricated page). The
   *  whole rune page (minors + secondaryTree + secondaryPicks) is conditioned
   *  on games that ran THIS tree so it reads as one coherent in-game page. */
  primaryTree: number | null;
  /** v0.29.0 — N_page: how many games ran `primaryTree`. This is the
   *  conditioned page sample every minor / secondary row is aggregated over
   *  (each slot's own sampleSize is a subset of this — games that also
   *  carried a non-empty slot array). */
  primaryTreeSampleSize: number;
  secondaryTree: TreeFrequency | null;
  /** Denominator for secondaryTree.share — v0.29.0: page-sample games (games
   *  that ran `primaryTree`) with a resolved secondary tree that ISN'T the
   *  primary tree. Conditioned on the page sample so a champion whose OTHER
   *  keystones ran different trees can't leak an impossible-in-game secondary
   *  (e.g. the same tree as primary) into this fraction. */
  secondaryTreeSampleSize: number;
  /** v0.29.0 — top 3 primary-tree minor runes, aggregated over the PAGE
   *  SAMPLE only (games whose runes.primaryTree === `primaryTree`), keystone
   *  ids filtered defensively. A real page has exactly 3 minor rows below the
   *  keystone, all in the primary tree — conditioning guarantees these all
   *  belong to `primaryTree` and never mix trees. Flat-aggregated within that
   *  sample per the module header note (row order isn't reliably preserved
   *  across both sources). */
  primaryMinors: RuneSlotBreakdown;
  /** v0.29.0 — top 2 secondary-tree picks, aggregated over page-sample games
   *  whose secondaryTree === the modal `secondaryTree` above. Because that
   *  tree is guaranteed ≠ `primaryTree`, these ids can NEVER duplicate a
   *  primaryMinors id (a rune belongs to exactly one tree). A real page has
   *  exactly 2. */
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
// Mirrors TOP_BOOTS_LIMIT's "one grid slot, both/several choices stacked"
// pattern (v0.28.0) — a champion can have more than one common starter
// (e.g. Doran's Ring vs. Dark Seal), and the card renders them the same
// stacked way BootsStackTile already does. 2 keeps the slot's footprint
// identical to the boots slot it sits beside.
const TOP_STARTERS_LIMIT = 2;
const TOP_PRIMARY_MINORS_LIMIT = 3;
const TOP_SECONDARY_PICKS_LIMIT = 2;
const TOP_SHARDS_LIMIT = 3;

/** Explicit starting-item allowlist (requirement #3) — see the module header
 *  comment for which entries are load-bearing today (Dark Seal, Tear of the
 *  Goddess — both have a real `into` upgrade path) vs. pinned defensively
 *  (everything else here is already empty-into and would pass the general
 *  completed-item rule on its own). */
export const STARTING_ITEM_ALLOWLIST = new Set<number>([
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

/** Resolve the page's primary tree from the game data itself — NO hardcoded
 *  keystone→tree table. Each game carries `runes.primaryTree`, set by
 *  lib/pro/extract.ts (Riot perk styles) and lib/prostage/extract.ts
 *  (Leaguepedia's PrimaryTree column). Prefers the tree the MODAL keystone
 *  actually ran under (games whose keystone === modalKeystoneId) so the tree
 *  matches the keystone the card displays; falls back to the sample-wide modal
 *  primary tree when those games never carried a resolved primaryTree, and
 *  finally 0 when no game has tree data at all (conditioning then yields an
 *  empty page sample — an honest "no tree data" state, not a fabricated page).
 *  Exported for direct unit testing. */
export function resolvePrimaryTree(games: ProGame[], modalKeystoneId: number): number {
  const modalTreeAmong = (predicate: (g: ProGame) => boolean): number => {
    const counts = new Map<number, number>();
    for (const g of games) {
      if (!predicate(g)) continue;
      const pt = g.runes?.primaryTree ?? 0;
      if (pt > 0) bump(counts, pt);
    }
    return sortEntries(counts)[0]?.[0] ?? 0;
  };
  if (modalKeystoneId > 0) {
    const tiedToKeystone = modalTreeAmong((g) => (g.runes?.keystone ?? 0) === modalKeystoneId);
    if (tiedToKeystone > 0) return tiedToKeystone;
  }
  return modalTreeAmong(() => true);
}

export function aggregateProConsensus(
  games: ProGame[],
  itemMeta: Map<number, ItemDetail>
): ProConsensusModel {
  const gamesTotal = games.length;

  const itemCounts = new Map<number, number>();
  const keystoneCounts = new Map<number, number>();
  const spellPairCounts = new Map<string, number>();
  const spellPairValue = new Map<string, [number, number]>();

  // shards are tree-INDEPENDENT (stat runes belong to no tree), so they
  // aggregate over EVERY game — unlike the tree-conditioned minors/picks below.
  const shards = new RuneSlotAccumulator();

  let runesSampleSize = 0;
  let spellSampleSize = 0;

  const tournamentNames: string[] = [];
  const tournamentSeen = new Set<string>();
  let soloqCount = 0;
  let prostageCount = 0;

  // ── Phase A: tree-INDEPENDENT aggregates over every game ───────────────────
  // items, keystone, shards, spells, source/tournament split. The
  // tree-CONDITIONED rune rows (minors, secondary tree, secondary picks) can't
  // be computed until the modal keystone — and therefore the page's primary
  // tree — is known, so they run in Phase B over a filtered page sample.
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
  // 2026-07-22: starters (STARTING_ITEM_ALLOWLIST) partitioned out the same
  // way — checked AFTER boots so a hypothetical future allowlist entry that
  // also carried the "Boots" tag would still land in `boots`, not double up
  // in both lists (no current entry does; see STARTING_ITEM_ALLOWLIST above).
  const sortedItemEntries = sortEntries(itemCounts);
  const toFrequency = ([itemId, count]: [number, number]): ItemFrequency => ({
    itemId,
    count,
    share: gamesTotal > 0 ? count / gamesTotal : 0,
  });
  const items: ItemFrequency[] = sortedItemEntries
    .filter(([itemId]) => !isBootsTag(itemMeta.get(itemId)) && !STARTING_ITEM_ALLOWLIST.has(itemId))
    .slice(0, TOP_ITEMS_LIMIT)
    .map(toFrequency);
  const boots: ItemFrequency[] = sortedItemEntries
    .filter(([itemId]) => isBootsTag(itemMeta.get(itemId)))
    .slice(0, TOP_BOOTS_LIMIT)
    .map(toFrequency);
  const starters: ItemFrequency[] = sortedItemEntries
    .filter(([itemId]) => !isBootsTag(itemMeta.get(itemId)) && STARTING_ITEM_ALLOWLIST.has(itemId))
    .slice(0, TOP_STARTERS_LIMIT)
    .map(toFrequency);

  const topKeystone = sortEntries(keystoneCounts)[0];
  const keystone: KeystoneFrequency | null = topKeystone
    ? { keystoneId: topKeystone[0], count: topKeystone[1], share: topKeystone[1] / runesSampleSize }
    : null;

  // ── Phase B: tree-conditioned rune page (v0.29.0) ─────────────────────────
  // Resolve the page's primary tree from the game data itself, then condition
  // minors + secondary tree + secondary picks on games that actually ran that
  // tree — see the module header for the incoherence bug this fixes.
  const primaryTreeId = resolvePrimaryTree(games, keystone?.keystoneId ?? 0);
  let pageSample =
    primaryTreeId > 0 ? games.filter((g) => (g.runes?.primaryTree ?? 0) === primaryTreeId) : [];

  // v0.29.1 guard — see module header "Fallback-tree/keystone consistency
  // guard" for the bug this closes. Only relevant when resolvePrimaryTree
  // actually fell back to a tree the modal keystone's own games never ran;
  // detected here (rather than threading a flag out of resolvePrimaryTree)
  // by simply checking whether the resolved page sample contains the
  // keystone we're about to display — true for every already-tested v0.29.0
  // path (the tied-to-keystone branch guarantees it by construction), so
  // this is a no-op guard on the main path and only fires on the degenerate
  // fallback case.
  let effectiveKeystone = keystone;
  let effectiveRunesSampleSize = runesSampleSize;
  if (keystone && pageSample.length > 0 && !pageSample.some((g) => (g.runes?.keystone ?? 0) === keystone.keystoneId)) {
    const localCounts = new Map<number, number>();
    let localSampleSize = 0;
    for (const g of pageSample) {
      const k = g.runes?.keystone ?? 0;
      if (k > 0) {
        localSampleSize += 1;
        bump(localCounts, k);
      }
    }
    const localTop = sortEntries(localCounts)[0];
    if (localTop) {
      // (a) Drop the keystone to the fallback tree's OWN modal keystone —
      // tile and page now agree, and the fraction is scoped to the page it
      // actually describes.
      effectiveKeystone = { keystoneId: localTop[0], count: localTop[1], share: localTop[1] / localSampleSize };
      effectiveRunesSampleSize = localSampleSize;
    } else {
      // (b) The fallback tree's games have no resolved keystone either —
      // nothing honest to pair the page with. Degrade to the existing
      // tree-less pattern (keystone tile keeps the honest global fraction,
      // page underneath is dropped).
      pageSample = [];
    }
  }
  const primaryTreeSampleSize = pageSample.length;

  // primaryMinors: primary[] over the page sample only, keystone ids filtered
  // defensively (both extract paths already drop them, but a future data shape
  // shouldn't be able to leak a keystone into the minors row).
  const primaryMinors = new RuneSlotAccumulator();
  for (const game of pageSample) {
    const ownKeystone = game.runes?.keystone ?? 0;
    const minors = (game.runes?.primary ?? []).filter(
      (id) => id > 0 && id !== ownKeystone && id !== effectiveKeystone?.keystoneId
    );
    primaryMinors.add(minors, game.source);
  }

  // secondaryTree: modal secondary tree over the page sample, EXCLUDING the
  // primary tree (impossible in-game). Denominator is page-sample games with a
  // resolved secondary tree that isn't the primary tree.
  const secondaryTreeCounts = new Map<number, number>();
  let secondaryTreeSampleSize = 0;
  for (const game of pageSample) {
    const st = game.runes?.secondaryTree ?? 0;
    if (st > 0 && st !== primaryTreeId) {
      secondaryTreeSampleSize += 1;
      bump(secondaryTreeCounts, st);
    }
  }
  const topSecondary = sortEntries(secondaryTreeCounts)[0];
  const secondaryTree: TreeFrequency | null = topSecondary
    ? { treeId: topSecondary[0], count: topSecondary[1], share: topSecondary[1] / secondaryTreeSampleSize }
    : null;

  // secondaryPicks: secondary[] only from page-sample games whose secondary
  // tree IS the modal secondary tree — every pick then belongs to the
  // displayed secondary tree and can never duplicate a primary minor.
  const secondaryPicks = new RuneSlotAccumulator();
  if (secondaryTree) {
    for (const game of pageSample) {
      if ((game.runes?.secondaryTree ?? 0) !== secondaryTree.treeId) continue;
      const ownKeystone = game.runes?.keystone ?? 0;
      const picks = (game.runes?.secondary ?? []).filter((id) => id > 0 && id !== ownKeystone);
      secondaryPicks.add(picks, game.source);
    }
  }

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
    starters,
    keystone: effectiveKeystone,
    runesSampleSize: effectiveRunesSampleSize,
    // primaryTreeSampleSize (== pageSample.length) is the authority here, not
    // the raw primaryTreeId — case (b) above can force pageSample back to []
    // (degrading to tree-less) while primaryTreeId itself stays nonzero.
    primaryTree: primaryTreeSampleSize > 0 ? primaryTreeId : null,
    primaryTreeSampleSize,
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
