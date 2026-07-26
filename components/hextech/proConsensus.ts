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
//
// ── Per-slot PRO shards, not WPA fallback shards (2026-07-24) ──────────────
// USER BUG (confirmed, Senna Pro page): "Apply pro runes" wrote the WPA
// build's shard for Senna's offense slot (Adaptive Force) even though the
// PRO consensus for that slot is actually Attack Speed. Root cause: the
// `shards: RuneSlotBreakdown` field below is a FLAT top-3-by-frequency count
// with no offense/flex/defense label -- real ids overlap between slots (5008
// Adaptive Force is valid in both offense AND flex), so a bare id from that
// list can't be safely assigned to a slot. `proConsensusRuneApplyInput`
// therefore always used the caller's `fallbackShards` (the on-screen
// WPA-recommended ShardSet) unconditionally -- see
// `ProConsensusRuneApplyResult.shardsFromFallback`'s doc comment (now
// superseded by this fix).
//
// The flat aggregate was never the only option, though: the RAW per-game
// field `game.runes.shards` (`ProGameRunes.shards`, `components/
// proGames.types.ts`) IS positional -- `[offenseShardId, flexShardId,
// defenseShardId]`, 1:1 with Riot's `perks.statPerks` order, preserved
// verbatim by `lib/pro/extract.ts` for soloq rows. Shards are structurally
// SOLOQ-ONLY (module header above, "Rune slot aggregation" -- Leaguepedia's
// `resolveRunes` always returns `shards: []`), so a 3-element array is both
// "this game carries positional shard data" and, trivially, "this game is
// soloq" -- checking length is sufficient, no separate source check needed.
//
// FIX: `buildProShardPage` (below) resolves the per-slot MODAL id at each of
// the 3 positions independently, over every game with a 3-element shards
// array (shards are tree-independent -- same posture the flat `shards`
// aggregate above already takes -- so this runs over the full sample, not
// the tree-conditioned page sample). Each position's modal is restricted to
// ids KNOWN VALID for that slot (`OFFENSE_SHARD_IDS`/`FLEX_SHARD_IDS`/
// `DEFENSE_SHARD_IDS`) so a corrupted/misaligned id can never be crowned
// "the pro pick" for a slot it doesn't belong to -- same "never assume,
// never invent" posture as `isBuildItem`'s unknown-item handling. A slot
// with no valid id anywhere in the sample resolves to `null`.
//
// `proConsensusRuneApplyInput` then fills each slot from the pro pick when
// present, falling back to the caller's `fallbackShards.<slot>` ONLY for a
// slot that resolved `null` -- a per-slot fallback, not an all-or-nothing
// one. `shardsFromFallback` is true only in the genuine "no pro shard data
// at all" case (all 3 slots null, e.g. an all-prostage sample).
//
// -- itemsSampleSize: items/boots/starters get their OWN denominator too
// (2026-07-25, P1-2 audit fix) --------------------------------------------
// BUG THIS FIXES: `gamesTotal = games.length` was ALSO the denominator for
// every `ItemFrequency.share` (items, boots, starters alike). Rune slots
// deliberately never made this mistake -- each `RuneSlotBreakdown` carries
// its own `sampleSize` precisely "so keystone-only prostage rows don't
// dilute the fraction" (see the "Rune slot aggregation" section above).
// Items never got the same treatment because, until v0.54.0, every prostage
// row genuinely carried Cargo's `Items` column -- but live-ingested rows
// (lib/prostage/liveIngest.ts) write `final_items = '[]'` before a human
// opens that game's detail sheet to resolve it. A live row is real pro data
// for keystone/spells/tournament purposes but structurally has NO item data
// yet, same as a rune-less prostage row has no rune data -- diluting
// `items`/`boots`/`starters` with it is the exact class of bug the rune
// denominators already avoid.
// FIX: `itemsSampleSize` counts only games whose RAW `finalItems` array is
// non-empty (mirrors `RuneSlotAccumulator.add`'s own gate), and every
// `ItemFrequency.share` divides by it instead of `gamesTotal`. Concretely:
// 100 games, 15 of them itemless -> an item in 40 of the 85 item-bearing
// games now renders the honest "47%" instead of the understated "40%".
//
// -- Support-quest finals get ONE slot, never several (2026-07-26) ----------
// USER BUG (screenshot-confirmed, Builds page): the ITEMS grid rendered
// Zaz'Zak's Realmspike 80% AND Solstice Sleigh 20% at once. Both are
// support-quest FINALS, and a player can only ever own ONE of the five --
// Bounty of Worlds (3867) has `into: [3869,3870,3871,3876,3877]` and upgrades
// into exactly one of them (live 16.13.1 item.json, re-verified 2026-07-26).
// Two of the six item slots were therefore spent on ONE choice split across
// the sample, pushing a real item out of the grid.
//
// This is the same failure the v0.28.0 boots carve-out fixed (a split boots
// preference eating two slots) and gets the same fix: `SUPPORT_FINAL_ITEMS`
// ids are partitioned OUT of `items` into their own `supportFinals` field --
// top pick plus the runners-up it beat, ONE grid slot -- via the pure
// `rankSupportFinals` helper (components/hextech/supportFinalGroup.ts). The
// runners-up keep their OWN honest per-item percentages; the fractions are
// never merged or re-normalised into a combined "the family was built X%"
// stat, which would describe a choice nobody made.
//
// Partition ORDER is boots -> starters -> support finals, and that order is a
// construction guarantee rather than luck: none of the five finals carries
// the "Boots" tag or sits in STARTING_ITEM_ALLOWLIST (all five are
// `tags: [Health, HealthRegen, ManaRegen, Vision, GoldPer, Lane]`,
// `from: ["3867"]`), so the earlier checks cannot claim one. World Atlas
// (3865) is allowlisted and still lands in `starters`, unaffected.
//
// The intermediate tiers never reach this partition at all, but NOT for the
// reason you would guess (verified, do not "simplify" this): Bounty of Worlds
// (3867) is excluded by `isBuildItem` because it is BOTH non-purchasable and
// has a populated `into`, whereas Runic Compass (3866) has NO `into` field in
// ddragon at all -- itemDetail.ts normalizes that to `[]`, which the
// empty-into leaf rule would happily accept. The ONLY thing holding 3866 out
// is `purchasable === false`. Both are also `specialRecipe` upgrades rather
// than `from`-recipe ones, so nothing else in this module's filter chain
// would have caught them either.

import type { ProGame } from "@/components/proGames.types";
import { CONSUMABLE_ITEM_IDS, treeIconUrl, treeName, shardIconUrl, shardName } from "@/components/proAssets";
import type { ItemDetail } from "@/components/itemDetail";
import { primaryMinorRow } from "./perkSlots";
import { isSupportFinalItem, rankSupportFinals, type SupportFinalRanking } from "./supportFinalGroup";
import { TREE_NAME } from "@/lib/types";
import type { Pick as PickType, RunesBlock, ShardSet, TreeId } from "@/lib/types";

export interface ItemFrequency {
  itemId: number;
  count: number;
  share: number; // count / itemsSampleSize (NOT gamesTotal — see that field's doc comment)
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

/** One resolved rune-page SLOT (a primary minor row, or a secondary tree row)
 *  — the single modal rune for that slot over the conditioned page sample.
 *  Unlike a `RuneSlotFrequency` (which ranks every rune seen in a FLAT slot
 *  GROUP by frequency, with no per-row structure), this is the winner of ONE
 *  specific row, so a page assembled from these can never put two runes in the
 *  same slot. See the module header's "Slot-coherent apply page" section. */
export interface RunePageSlotPick {
  runeId: number;
  /** 0-based minor-row index within the owning tree (perkSlots.ts). */
  row: 0 | 1 | 2;
  /** Page-sample games that ran THIS rune in THIS row. */
  count: number;
  /** Page-sample games that ran ANY resolved rune in this row — the honest
   *  denominator for this slot (a row absent from a game doesn't dilute it). */
  sampleSize: number;
}

/** The slot-coherent rune page the "Apply pro runes" button writes — exactly
 *  one rune per required slot, derived by resolving each sampled rune to its
 *  perkstyles row and taking the per-row modal, NOT a flat frequency ranking.
 *  This is the apply path's source of truth; the FLAT primaryMinors/
 *  secondaryPicks below remain the CARD DISPLAY's source (unchanged), which is
 *  why both coexist on the model. */
export interface SlotCoherentRunePage {
  /** Page primary tree (null when no tree data — same condition as
   *  `ProConsensusModel.primaryTree`). */
  primaryTreeId: number | null;
  /** Modal secondary tree (null when none resolved). */
  secondaryTreeId: number | null;
  /** Displayed modal keystone id (null when no keystone data). */
  keystoneId: number | null;
  /** length 3, index = primary minor row. `null` = that row had NO resolvable
   *  rune anywhere in the page sample (genuinely uncoverable) — the apply
   *  button disables rather than writing a page with an empty slot. */
  primaryRows: (RunePageSlotPick | null)[];
  /** length 3, index = secondary tree row. A real page picks 2 of these 3;
   *  `null` = no data for that row. */
  secondaryRows: (RunePageSlotPick | null)[];
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
   *  itemId asc for a deterministic tie order. share is against
   *  `itemsSampleSize` (see that field's doc comment — 2026-07-25 fix; it
   *  used to be gamesTotal, which understated every share by the sample's
   *  itemless-row fraction). Boots are carved out into `boots` below
   *  (v0.28.0 user report: Crimson Lucidity + Spellslinger's Shoes each ate a
   *  full item slot on the same champion — a real item couldn't fit) and
   *  STARTING_ITEM_ALLOWLIST entries (Dark Seal, Tear of the Goddess, etc.)
   *  are carved out into `starters` below (2026-07-22 hard user directive —
   *  "Dark Seal must NEVER appear as a full/completed item ANYWHERE in the
   *  app" — live repro was exactly this list mixing Dark Seal in with
   *  Blackfire Torch/Rabadon's/etc.) so this list is never diluted by either.
   *  2026-07-26: the five support-quest FINALS are likewise carved out into
   *  `supportFinals` below — they are mutually exclusive, so listing more
   *  than one of them here spent multiple slots on a single choice. */
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
   *  `itemsSampleSize`, same denominator as `items` — these are still two
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
   *  `itemsSampleSize`, same denominator as `items`/`boots`. Empty when the
   *  sample never built a starter-class item (e.g. matchups where every
   *  game reached a full recipe-tree item instead) — the card renders no
   *  slot at all in that case, same "absent, not empty" convention `boots`
   *  already established. */
  starters: ItemFrequency[];
  /** 2026-07-26 — the support-quest FINAL family (Dream Maker / Zaz'Zak's /
   *  Bloodsong / Celestial Opposition / Solstice Sleigh), carved out of
   *  `items` for the same reason `boots` was in v0.28.0 and `starters` were
   *  on 2026-07-22: it is ONE choice, so it gets ONE grid slot. The five are
   *  MUTUALLY EXCLUSIVE by construction (Bounty of Worlds upgrades into
   *  exactly one — see the module header), so a grid listing two of them was
   *  never showing two things a pro built; it was showing one choice split
   *  across the sample while burning two of six slots. Live user report
   *  (screenshot-confirmed): "Zaz'Zak's Realmspike 80%" next to "Solstice
   *  Sleigh 20%".
   *
   *  `null` — not an empty object — when the sample never built a support
   *  final, so the card renders no slot at all: the same "absent, not empty"
   *  convention `boots`/`starters` already established. `top` is the modal
   *  pick; `alternatives` are the other finals the sample actually observed,
   *  each keeping its OWN count and share. Those shares are deliberately NOT
   *  merged or re-normalised into a combined family percentage — that number
   *  would describe a choice nobody made. Both ranked count desc, itemId asc
   *  (the same deterministic tie-break the rest of this module uses), and
   *  both divide by `itemsSampleSize`, the same denominator as `items`/
   *  `boots`/`starters`. Capped at `TOP_SUPPORT_FINALS_LIMIT` total entries
   *  so the slot's footprint matches the boots/starters stacks beside it. */
  supportFinals: SupportFinalRanking<ItemFrequency> | null;
  /** 2026-07-25 (P1-2 audit fix) — denominator for `items`/`boots`/
   *  `starters` shares: games whose `finalItems` array is non-empty, NOT
   *  `gamesTotal`. Before this field existed, every item-family share was
   *  `count / gamesTotal`, but live-ingested prostage rows (lib/prostage/
   *  liveIngest.ts) write `final_items = '[]'` — a real prostage row with
   *  no item data yet, not "this champion has fewer builds." Mixing those
   *  itemless rows into `gamesTotal` understated every single item/boots/
   *  starter percentage by exactly the itemless share (100 games, 15 of them
   *  itemless, an item in 40 of the 85 item-bearing games rendered "40%"
   *  instead of the honest 47%). Rune slots already avoid this exact trap —
   *  each `RuneSlotBreakdown` carries its own `sampleSize` — items never did
   *  because until v0.54.0 every prostage row carried Cargo `Items`. Same
   *  fix, same shape: count only games that COULD have supplied an item,
   *  same "never dilute a fraction with rows that structurally can't
   *  contribute to it" posture as the rune-slot denominators above. */
  itemsSampleSize: number;
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
  /** v0.27.1 — top 3 stat shards by frequency. FLAT, unlabeled (no offense/
   *  flex/defense slot structure) — this is the CARD DISPLAY's source only.
   *  Structurally soloq-only today (see module header) — soloqCount/
   *  prostageCount on the breakdown make that visible rather than asserted.
   *  2026-07-24: the apply path no longer reads this — see `shardPage`. */
  shards: RuneSlotBreakdown;
  /** 2026-07-24 — the per-SLOT resolved pro shards (offense/flex/defense),
   *  each the modal id at that positional row over every game with a
   *  3-element `runes.shards` array, restricted to ids valid for that slot.
   *  `null` for a slot with no valid pro data. This — NOT the flat `shards`
   *  above — is what `proConsensusRuneApplyInput` uses, so "Apply pro runes"
   *  writes the actual pro pick per slot (e.g. Attack Speed offense) instead
   *  of always falling back to the on-screen WPA build's shards. See the
   *  module header's "Per-slot PRO shards, not WPA fallback shards" section. */
  shardPage: ProShardPage;
  spellPair: SpellPairFrequency | null;
  /** Denominator for spellPair.share — games with BOTH spell slots resolved
   *  (neither id is the 0 sentinel). */
  spellSampleSize: number;
  tournaments: TournamentBreakdown;
  /** 2026-07-22 — the slot-coherent page the "Apply pro runes" button writes
   *  (one modal rune per perkstyles slot). Computed over the SAME conditioned
   *  page sample as primaryMinors/secondaryPicks, but resolved PER ROW so no
   *  two ids can share a slot. `proConsensusRuneApplyInput` /
   *  `missingRunePageReason` read exclusively off this; the flat
   *  primaryMinors/secondaryPicks above stay the card DISPLAY's source. */
  runePage: SlotCoherentRunePage;
}

const TOP_ITEMS_LIMIT = 6;
const TOP_BOOTS_LIMIT = 2;
// Mirrors TOP_BOOTS_LIMIT's "one grid slot, both/several choices stacked"
// pattern (v0.28.0) — a champion can have more than one common starter
// (e.g. Doran's Ring vs. Dark Seal), and the card renders them the same
// stacked way BootsStackTile already does. 2 keeps the slot's footprint
// identical to the boots slot it sits beside.
const TOP_STARTERS_LIMIT = 2;
/** DISPLAY cap on the support-final slot — the top pick plus at most 2
 *  alternatives. The family has 5 members, but a sample split 4-5 ways across
 *  a set of mutually-exclusive items is long-tail noise, and an uncapped
 *  stack would grow the slot to 5 tiles against the boots/starters stacks'
 *  2 sitting beside it. Applied HERE, at the model boundary, not inside
 *  `rankSupportFinals` — that helper reports what the sample genuinely
 *  contained; capping is a rendering decision (same split of concerns as
 *  TOP_ITEMS_LIMIT/TOP_BOOTS_LIMIT slicing an otherwise-complete sorted
 *  list). */
const TOP_SUPPORT_FINALS_LIMIT = 3;
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
  1086, // Doran's Bow — MISSING until 2026-07-25; see the note below
  1120, // Doran's Helm — MISSING until 2026-07-25; see the note below
  3070, // Tear of the Goddess — upgrades into Manamune/Archangel's/Winter's Approach/Whispering Circlet
  3865, // World Atlas (support starter)
  2049, // Guardian's Amulet (support starter)
  2050, // Guardian's Shroud (support starter)
]);

/* WHY 1086/1120 WERE MISSING FOR SO LONG, AND WHY THIS LIST IS NO LONGER THE
 * ONLY GUARD. Both are `into: []`, so `isFullItem` in itemSetBody.ts passed
 * them as genuine recipe-tree leaves, and this list was the only thing that
 * would have held them out — except neither was on it. They shipped inside
 * completed 6-item build lines in production: Doran's Bow in Ashe/Jinx/
 * Caitlyn/Lucian/Ezreal "Pro build", Doran's Helm in Ornn/Darius/Malphite,
 * and ProConsensusCard rendered "Doran's Bow 43%" in its completed-items grid
 * — exactly the display the 2026-07-22 Dark Seal directive banned.
 *
 * An enumeration that must be updated by hand every time Riot ships an item is
 * a guard that will rot again, and this one now has twice. `isFullItem` grew a
 * STRUCTURAL lane-starter rule (from-nothing + cheap + "Lane"-tagged) so the
 * class is caught without anyone maintaining a list; this stays as
 * belt-and-braces and as the partition key for the `starters` field. Add new
 * ids here when you notice them, but do not rely on that being sufficient. */

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

// ── Slot-coherent page assembly (2026-07-22 pro-rune slot-coherence fix) ──────
// The flat primaryMinors/secondaryPicks aggregates rank runes by frequency with
// NO per-row structure, so a thin/split sample can rank two runes from the same
// perkstyles row above a third row's rune — a page assembled from that top-N
// list then has a duplicate slot AND a missing slot, which the LCU renders as
// an EMPTY minor slot (the reported "Ashe Bot Pro" bug). These helpers instead
// resolve each sampled rune to its ROW (perkSlots.ts) and take the per-row
// modal, so the resulting page has exactly one rune per slot by construction —
// the same one-per-row guarantee lib/recommend.ts's `rowPicks` gives the WPA
// page. See the RunePageSlotPick / SlotCoherentRunePage type docs.

/** row -> runeId for one game's PRIMARY minors. Soloq selections come back in
 *  slot (row) order from Riot (lib/pro/extract.ts), so a full 3-minor soloq
 *  page is read POSITIONALLY — this is what lets a single real game fill every
 *  row (the brief's "a single real game HAS a complete valid page"), and also
 *  slots a brand-new rune id the static perkstyles map hasn't caught up to yet.
 *  Prostage's primary[] is NOT row-ordered (lib/prostage/extract.ts buckets by
 *  parent tree), so those ids are resolved by the perkstyles map instead; the
 *  first id to claim a row wins on the rare within-game duplicate. */
function primaryRowAssignments(
  game: ProGame,
  primaryTreeId: number,
  keystoneId: number | null
): Map<number, number> {
  const own = game.runes?.keystone ?? 0;
  const raw = (game.runes?.primary ?? []).filter((id) => id > 0 && id !== own && id !== keystoneId);
  const out = new Map<number, number>();
  if (game.source === "soloq" && raw.length === 3) {
    for (let i = 0; i < 3; i++) out.set(i, raw[i]);
    return out;
  }
  for (const id of raw) {
    const r = primaryMinorRow(primaryTreeId, id);
    if (r !== null && !out.has(r)) out.set(r, id);
  }
  return out;
}

/** row -> runeId for one game's SECONDARY picks. Unlike primary, secondary
 *  picks are NOT positionally row-mapped even for soloq (the two picks come
 *  from 2 of 3 rows, ascending, but which 2 varies), so every id is resolved
 *  through the perkstyles map for both sources. */
function secondaryRowAssignments(game: ProGame, secondaryTreeId: number): Map<number, number> {
  const own = game.runes?.keystone ?? 0;
  const raw = (game.runes?.secondary ?? []).filter((id) => id > 0 && id !== own);
  const out = new Map<number, number>();
  for (const id of raw) {
    const r = primaryMinorRow(secondaryTreeId, id);
    if (r !== null && !out.has(r)) out.set(r, id);
  }
  return out;
}

/** Per-row modal over the page sample for one tree role (primary or secondary),
 *  using the supplied per-game row->id assigner. Returns a fixed-length-3 array
 *  indexed by row; a row with no sampled data is `null`. */
function resolveRowPicks(
  pageSample: ProGame[],
  assign: (game: ProGame) => Map<number, number>
): (RunePageSlotPick | null)[] {
  const counts: Map<number, number>[] = [new Map(), new Map(), new Map()];
  const rowSample = [0, 0, 0];
  for (const game of pageSample) {
    assign(game).forEach((id, row) => {
      rowSample[row] += 1;
      bump(counts[row], id);
    });
  }
  return [0, 1, 2].map((r) => {
    const top = sortEntries(counts[r])[0];
    return top ? { runeId: top[0], row: r as 0 | 1 | 2, count: top[1], sampleSize: rowSample[r] } : null;
  });
}

/** Assemble the slot-coherent apply page from the conditioned page sample. */
function buildSlotCoherentPage(
  pageSample: ProGame[],
  primaryTreeId: number | null,
  keystoneId: number | null,
  secondaryTreeId: number | null
): SlotCoherentRunePage {
  const primaryRows =
    primaryTreeId !== null
      ? resolveRowPicks(pageSample, (g) => primaryRowAssignments(g, primaryTreeId, keystoneId))
      : [null, null, null];
  const secondaryRows =
    secondaryTreeId !== null
      ? resolveRowPicks(pageSample, (g) =>
          (g.runes?.secondaryTree ?? 0) === secondaryTreeId
            ? secondaryRowAssignments(g, secondaryTreeId)
            : new Map<number, number>()
        )
      : [null, null, null];
  return { primaryTreeId, secondaryTreeId, keystoneId, primaryRows, secondaryRows };
}

// ── Per-slot PRO shard aggregation (2026-07-24 fix) — see module header ────

/** Ids known-valid for the OFFENSE shard row (Adaptive Force, Attack Speed,
 *  Ability Haste — the current live game's offense row, per
 *  `lib/staticData.ts`'s `SHARD_NAME`). */
const OFFENSE_SHARD_IDS = new Set<number>([5008, 5005, 5007]);
/** Ids known-valid for the FLEX shard row (Adaptive Force, Move Speed,
 *  Health Scaling). */
const FLEX_SHARD_IDS = new Set<number>([5008, 5010, 5001]);
/** Ids known-valid for the DEFENSE shard row (Health Scaling, Tenacity and
 *  Slow Resist, Health — the current row) PLUS Armor (5002) / Magic Resist
 *  (5003), which occupied this row before Riot's stat-shard rework replaced
 *  them with Health Scaling. `lib/pro/fresh.ts`'s 90-day ingest window makes
 *  a live sample carrying the legacy ids unlikely today, but a historical
 *  row that does carry one is real pro data for that slot, not corruption —
 *  same "never assume" posture as the rest of this module, applied here as
 *  "never silently discard a once-valid id" rather than "never accept an
 *  id we haven't hardcoded." */
const DEFENSE_SHARD_IDS = new Set<number>([5011, 5013, 5001, 5002, 5003]);

const SHARD_SLOT_VALID_IDS: readonly [Set<number>, Set<number>, Set<number>] = [
  OFFENSE_SHARD_IDS,
  FLEX_SHARD_IDS,
  DEFENSE_SHARD_IDS,
];

export interface ProShardSlotPick {
  runeId: number;
  /** Games whose modal-winning id appeared at this position. */
  count: number;
  /** Games with a 3-element `runes.shards` array (soloq, structurally — see
   *  module header) — the shared denominator for all 3 slots, since a soloq
   *  game either carries all 3 positional picks or (prostage) none. */
  sampleSize: number;
}

/** The per-slot resolved pro shard page — the modal, slot-valid pick at each
 *  of the 3 positional rows (`game.runes.shards[0/1/2]`), or `null` when the
 *  sample never carried a valid id for that slot. Mirrors
 *  `SlotCoherentRunePage`'s per-row-modal pattern for the primary/secondary
 *  rune page. Exported for direct unit testing. */
export interface ProShardPage {
  offense: ProShardSlotPick | null;
  flex: ProShardSlotPick | null;
  defense: ProShardSlotPick | null;
}

/** Modal id at `position` (0=offense, 1=flex, 2=defense), restricted to ids
 *  valid for that slot — an id that fails validation is simply never counted
 *  (not treated as "no data"; a different, valid id at that position in
 *  another game can still win). `sampleSize` counts every game with 3-element
 *  shard data regardless of validity, so it stays the honest "how many games
 *  could have supplied this slot" denominator even when 0 of them did. */
function resolveShardSlot(games: ProGame[], position: 0 | 1 | 2): ProShardSlotPick | null {
  const validIds = SHARD_SLOT_VALID_IDS[position];
  const counts = new Map<number, number>();
  let sampleSize = 0;
  for (const g of games) {
    const shards = g.runes?.shards ?? [];
    if (shards.length !== 3) continue;
    sampleSize += 1;
    const id = shards[position];
    if (validIds.has(id)) bump(counts, id);
  }
  const top = sortEntries(counts)[0];
  return top ? { runeId: top[0], count: top[1], sampleSize } : null;
}

function buildProShardPage(games: ProGame[]): ProShardPage {
  return {
    offense: resolveShardSlot(games, 0),
    flex: resolveShardSlot(games, 1),
    defense: resolveShardSlot(games, 2),
  };
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
  // 2026-07-25 (P1-2 fix) — see ProConsensusModel.itemsSampleSize's doc
  // comment. Bumped once per game whose RAW finalItems array is non-empty
  // (mirrors RuneSlotAccumulator.add's `if (ids.length === 0) return` —
  // "did this game structurally carry item data at all", not "did any of
  // its items pass isBuildItem"), so it's the honest denominator for
  // items/boots/starters the same way each RuneSlotBreakdown.sampleSize is
  // for its own slot group.
  let itemsSampleSize = 0;

  // ── Phase A: tree-INDEPENDENT aggregates over every game ───────────────────
  // items, keystone, shards, spells, source/tournament split. The
  // tree-CONDITIONED rune rows (minors, secondary tree, secondary picks) can't
  // be computed until the modal keystone — and therefore the page's primary
  // tree — is known, so they run in Phase B over a filtered page sample.
  for (const game of games) {
    const rawFinalItems = game.finalItems ?? [];
    if (rawFinalItems.length > 0) itemsSampleSize += 1;
    const seenItems = new Set<number>();
    for (const itemId of rawFinalItems) {
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
  // itemsSampleSize, not gamesTotal — see ProConsensusModel.itemsSampleSize's
  // doc comment (2026-07-25 P1-2 fix).
  const toFrequency = ([itemId, count]: [number, number]): ItemFrequency => ({
    itemId,
    count,
    share: itemsSampleSize > 0 ? count / itemsSampleSize : 0,
  });
  // 2026-07-26: support-quest FINALS partitioned out the same way, checked
  // AFTER boots and starters. Order is a construction guarantee, not luck —
  // none of the five finals is Boots-tagged or allowlisted (verified against
  // live 16.13.1 item.json), and World Atlas (3865, the chain's STARTER) is
  // allowlisted and so still lands in `starters`, where it belongs. See the
  // module header's "Support-quest finals get ONE slot" section.
  const items: ItemFrequency[] = sortedItemEntries
    .filter(
      ([itemId]) =>
        !isBootsTag(itemMeta.get(itemId)) &&
        !STARTING_ITEM_ALLOWLIST.has(itemId) &&
        !isSupportFinalItem(itemId)
    )
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
  // The boots/starter exclusions are repeated here rather than assumed away:
  // if a future patch ever DID tag a final "Boots" or add one to the
  // allowlist, it must land in exactly one list, and the earlier partition
  // wins — same precedence rule `starters` already documents against `boots`.
  // rankSupportFinals applies no cap of its own (it reports what the sample
  // held); TOP_SUPPORT_FINALS_LIMIT is applied here, to the flattened
  // top-then-alternatives order, so the cap trims the weakest runners-up and
  // can never drop the top pick.
  const supportFinalEntries: ItemFrequency[] = sortedItemEntries
    .filter(
      ([itemId]) =>
        !isBootsTag(itemMeta.get(itemId)) &&
        !STARTING_ITEM_ALLOWLIST.has(itemId) &&
        isSupportFinalItem(itemId)
    )
    .map(toFrequency);
  const rankedSupportFinals = rankSupportFinals(supportFinalEntries);
  const supportFinals: SupportFinalRanking<ItemFrequency> | null = rankedSupportFinals
    ? {
        top: rankedSupportFinals.top,
        alternatives: rankedSupportFinals.alternatives.slice(0, TOP_SUPPORT_FINALS_LIMIT - 1),
      }
    : null;

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

  // Slot-coherent apply page — resolved PER ROW over the same conditioned page
  // sample the flat minors/picks used, so no two ids can share a slot. Trees/
  // keystone match the fields returned below (page primaryTree is null when the
  // conditioned sample collapsed to empty — see primaryTreeSampleSize).
  const runePage = buildSlotCoherentPage(
    pageSample,
    primaryTreeSampleSize > 0 ? primaryTreeId : null,
    effectiveKeystone?.keystoneId ?? null,
    secondaryTree?.treeId ?? null
  );

  return {
    gamesTotal,
    items,
    boots,
    starters,
    supportFinals,
    itemsSampleSize,
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
    shardPage: buildProShardPage(games),
    spellPair,
    spellSampleSize,
    tournaments: {
      names: tournamentNamesSortedByFrequency(games, tournamentNames),
      soloqCount,
      prostageCount,
    },
    runePage,
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

// ── Pro Consensus -> rune-apply input (2026-07-22, "manual pro push") ──────
// USER DIRECTIVE: keep auto-exporting the WPA-recommended page exactly as
// today, but let the user MANUALLY choose to push the pro-consensus page
// instead via a button on the Pro Consensus card. This section is the pure
// translation from ProConsensusModel -> the SAME RunesBlock shape
// runeApplyBody.ts's buildRuneApplyBody() already consumes, so "apply the
// pro page" is byte-for-byte the same wire path as "apply the WPA page" —
// only the ids/tree differ. No auto behavior is touched by any of this.
//
// ── Honesty rules (never fabricate a slot) ──────────────────────────────────
// A real LCU rune page needs exactly: 1 keystone, one primary minor per row
// (rows 0/1/2), 1 secondary tree, 2 secondary picks from 2 DIFFERENT secondary
// rows, and 3 shards. The pro-consensus sample can legitimately be too thin to
// have all of that.
//
// 2026-07-22 SLOT-COHERENCE FIX: this now reads off `model.runePage` (the
// per-row resolved page — one modal rune per perkstyles slot), NOT the flat
// primaryMinors/secondaryPicks COUNTS it used before. The count check was the
// bug: "3 primary minors present" could be TWO runes from the same row plus an
// empty row, which passed the old `entries.length < 3` guard but produced an
// invalid page the client rendered with an empty minor slot (live "Ashe Bot
// Pro" report). Checking the resolved per-row structure catches a slot GAP,
// not just a low total count. `missingRunePageReason` stays the single source
// of truth — both `proConsensusRuneApplyInput` (returns null when it fires) and
// the card's disabled-button tooltip read off it, so they can never disagree.
//
// THIN-DATA / "fill from real games" decision: per-row modal over the page
// sample already realizes cross-game fill — a row missing from one game is
// covered by any other sampled game that ran it, and a full soloq page is read
// positionally so a SINGLE real soloq game fills all 3 rows. A row is `null`
// (uncoverable) only when NO sampled game ran a resolvable rune there — which
// no "modal game" could supply either — so we honestly DISABLE the button with
// a reason rather than write a knowingly-incomplete page. This keeps the button
// usable on any sample that contains at least one complete real page while
// never fabricating a slot.
/** Riot tree style ids are a closed 5-value set (lib/types.ts's `TreeId`);
 *  `ProConsensusModel.primaryTree`/`secondaryTree.treeId` are plain
 *  `number` (resolved from raw game data, see proConsensus.ts's own tree
 *  conditioning above), so this is the guard that turns "a number that
 *  should be a tree id" into an actually-typed `TreeId` before it's used to
 *  build a `TreeRef` — never assumed, always checked against the known
 *  set. */
function asTreeId(id: number): TreeId | null {
  return id in TREE_NAME ? (id as TreeId) : null;
}

/** Builds a real Pick for a resolved pro shard slot — unlike `toPick` (used
 *  for keystone/primary/secondary, which stays on a `Rune #${id}` placeholder
 *  because resolving a real rune name needs an async CommunityDragon fetch,
 *  see that function's call site doc comment), shard names/icons are a small
 *  static synchronous lookup (`shardName`/`shardIconUrl`, `components/
 *  proAssets.ts`, already imported above for tree names), so there's no
 *  reason not to use the real ones here. `buildRuneApplyBody` still only
 *  reads `.id`, so this remains a non-goal for display purposes — it's just
 *  free correctness, not a new requirement. */
function toShardPick(slot: ProShardSlotPick): PickType {
  return {
    id: slot.runeId,
    name: shardName(slot.runeId),
    icon: shardIconUrl(slot.runeId),
    wpa: 0,
    winrate: null,
    occurrence: slot.count,
  };
}

const REQUIRED_SECONDARY_ROWS = 2;

export function missingRunePageReason(model: ProConsensusModel): string | null {
  const page = model.runePage;
  if (!model.keystone || page.keystoneId === null) return "No pro keystone data for this matchup yet.";
  if (page.primaryTreeId === null || asTreeId(page.primaryTreeId) === null) {
    return "No pro primary-tree data for this matchup yet.";
  }
  // Every primary minor ROW must resolve to exactly one rune. A `null` row is a
  // slot GAP — the count-only check this replaced passed it (3 total minors
  // could be 2-from-one-row + an empty row), which is exactly what wrote a page
  // with an empty in-client slot.
  if (page.primaryRows.some((r) => r === null)) {
    return "Incomplete primary rune data — not enough sampled pro games.";
  }
  if (page.secondaryTreeId === null || asTreeId(page.secondaryTreeId) === null) {
    return "No pro secondary-tree data for this matchup yet.";
  }
  // Need 2 secondary picks from 2 DIFFERENT rows — count resolved rows, not raw
  // picks, so two runes from the same row can never masquerade as a valid pair.
  if (page.secondaryRows.filter((r) => r !== null).length < REQUIRED_SECONDARY_ROWS) {
    return "Incomplete secondary rune data — not enough sampled pro games.";
  }
  return null;
}

export interface ProConsensusRuneApplyResult {
  /** Same shape buildRuneApplyBody() consumes — feed straight into it
   *  (`buildRuneApplyBody(champ.name, roleLabel, result.runes)`), which
   *  keeps the "CoachBuild <champ> <role>" title convention (v0.35.0) and
   *  the champ-scoped cleanup prefix intact — this never mints a new title
   *  vocabulary. */
  runes: RunesBlock;
  /** 2026-07-24: `true` only when NONE of the 3 shard slots resolved real
   *  pro data (`model.shardPage.offense`/`flex`/`defense` all `null` — e.g.
   *  an all-prostage sample, since shards are structurally soloq-only, see
   *  the module header). In that genuine no-data case every slot falls back
   *  to the caller's `fallbackShards` (the on-screen WPA-recommended
   *  ShardSet) and this flag lets the caller render an honest "shards from
   *  CoachBuild's recommendation — pro shard data unavailable" note.
   *
   *  When at least one slot DOES have pro data, `runes.shards` is a MIX:
   *  each slot independently uses `model.shardPage.<slot>` when resolved,
   *  falling back to `fallbackShards.<slot>` only for the specific slot(s)
   *  that didn't — this flag is `false` in that case (some/all slots are
   *  real pro data), even if one individual slot still came from the
   *  fallback. Was previously always `true` — `model.shards` (the FLAT,
   *  unlabeled top-3-by-frequency shard breakdown) carries no slot
   *  structure, so it could never be safely assigned to offense/flex/
   *  defense; `model.shardPage` (per-slot, perkstyles-validated) is what
   *  fixed that — see the module header's "Per-slot PRO shards, not WPA
   *  fallback shards" section for the full root-cause + fix. */
  shardsFromFallback: boolean;
}

/** Builds a RunesBlock for the "Apply pro runes" button
 *  (ProConsensusCard.tsx) — pushes the pro-consensus page through the SAME
 *  apply pipeline (companionClient.applyRunes via buildRuneApplyBody) the
 *  WPA "Apply runes" button already uses. Pure: no fetch, no DOM, plain
 *  ProConsensusModel + a caller-supplied fallback ShardSet in, a result or
 *  `null` out — see `missingRunePageReason` for exactly when this returns
 *  null (rune-page completeness only — shards never gate the button, since
 *  every shard slot has its own independent fallback), and the type doc
 *  above for exactly when/how shards mix pro data with `fallbackShards`.
 *
 *  Slot-coherent by construction (2026-07-22): primary minors are the per-row
 *  modals from `model.runePage.primaryRows`, emitted in ROW order (row 0 → 1 →
 *  2); the 2 secondary picks are the 2 most-adopted secondary rows, emitted in
 *  ascending row order. Because every id is the winner of ONE row, the assembled
 *  page can never put two runes in the same slot — the exact failure the flat
 *  frequency list allowed. (Emitting in row order also matches the WPA page's
 *  ordering; the LCU is robust either way, but row-ordered is the honest shape.)
 *
 *  Non-goal: the returned Picks carry placeholder `name`/`icon`/`wpa`/
 *  `winrate` — `buildRuneApplyBody` only reads `.id` off every slot plus
 *  `primaryTree.id`/`secondaryTree.id` (see that file), so this is
 *  intentionally NOT a display model. A future caller that needs display
 *  data too should resolve names/icons the same async way
 *  ProConsensusCard already does (`resolveRuneDisplay`) rather than adding
 *  that here — this stays pure and DOM-free. */
export function proConsensusRuneApplyInput(
  model: ProConsensusModel,
  fallbackShards: ShardSet
): ProConsensusRuneApplyResult | null {
  if (missingRunePageReason(model) !== null) return null;
  const page = model.runePage;
  // Narrowed by the guard above (missingRunePageReason validates keystone,
  // both trees via asTreeId, all 3 primary rows non-null, and ≥2 secondary
  // rows), but TS can't see through the function-boundary null-check — the
  // local consts + defensive re-checks make the non-null-ness explicit.
  const keystone = model.keystone;
  const primaryTreeId = page.primaryTreeId !== null ? asTreeId(page.primaryTreeId) : null;
  const secondaryTreeId = page.secondaryTreeId !== null ? asTreeId(page.secondaryTreeId) : null;
  if (!keystone || primaryTreeId === null || secondaryTreeId === null) return null; // unreachable; satisfies TS

  const toPick = (id: number, occurrence: number): PickType => ({
    id,
    name: `Rune #${id}`,
    icon: "",
    wpa: 0,
    winrate: null,
    occurrence,
  });

  // All 3 primary rows are non-null (missingRunePageReason enforced it) — emit
  // in row order (index 0 → 2).
  const primaryPicks = page.primaryRows;
  if (primaryPicks.some((r) => r === null)) return null; // unreachable; satisfies TS
  const primary = (primaryPicks as RunePageSlotPick[]).map((p) => toPick(p.runeId, p.count));

  // The 2 most-adopted secondary rows (games desc, row asc on ties), re-sorted
  // into ascending row order for emission — a real secondary page's 2 picks are
  // in row order.
  const secondary = page.secondaryRows
    .filter((r): r is RunePageSlotPick => r !== null)
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.row - b.row))
    .slice(0, REQUIRED_SECONDARY_ROWS)
    .sort((a, b) => a.row - b.row)
    .map((p) => toPick(p.runeId, p.count));
  if (secondary.length < REQUIRED_SECONDARY_ROWS) return null; // unreachable; satisfies TS

  // Per-slot pro shards (2026-07-24 fix): use model.shardPage.<slot> when the
  // sample resolved a valid pro pick for that slot, falling back to the
  // caller's fallbackShards.<slot> ONLY for a slot that didn't — see the
  // module header's "Per-slot PRO shards, not WPA fallback shards" section
  // and ProConsensusRuneApplyResult.shardsFromFallback's doc comment.
  const { offense, flex, defense } = model.shardPage;
  const shards: ShardSet = {
    offense: offense ? toShardPick(offense) : fallbackShards.offense,
    flex: flex ? toShardPick(flex) : fallbackShards.flex,
    defense: defense ? toShardPick(defense) : fallbackShards.defense,
  };
  // shardsFromFallback is true ONLY in the genuine no-pro-data-anywhere case
  // (all 3 slots null) — a partial mix (e.g. offense resolved, flex/defense
  // didn't) is NOT flagged as "fallback," since most of the page is real pro
  // data; the caller's tooltip text ("pro shard data unavailable") is only
  // accurate for the all-null case.
  const shardsFromFallback = !offense && !flex && !defense;

  const runes: RunesBlock = {
    primaryTree: { id: primaryTreeId, name: treeName(primaryTreeId), icon: treeIconUrl(primaryTreeId) },
    secondaryTree: {
      id: secondaryTreeId,
      name: treeName(secondaryTreeId),
      icon: treeIconUrl(secondaryTreeId),
    },
    keystone: toPick(keystone.keystoneId, keystone.count),
    primary,
    secondary,
    shards,
  };

  return { runes, shardsFromFallback };
}
