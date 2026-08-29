// ─────────────────────────────────────────────────────────────────────────────
// itemSetBody.ts — pure builder for the companion's POST /apply-itemsets body
// (item-sets feature round, 2026-07-20 — wire contract extension of
// runeApplyBody.ts's own pattern).
//
// v0.34.1 RESTRUCTURE (user feedback after confirming item sets work
// in-game): the original shape shipped THREE separate LCU sets per
// champion+role (Core / Optimized / Pro), each independently assembled from
// whatever pool it drew from with no shared "is this a sane build line"
// check. Two real in-game bugs came out of that:
//   1. A line with TWO boots. Root cause: buildProSet combined
//      `[...pro.boots, ...pro.items]` (pro.boots can carry up to 2 entries,
//      see proConsensus.ts's TOP_BOOTS_LIMIT) and sorted by share — nothing
//      stopped both boots candidates from landing in the top slice.
//   2. An "Optimized" line with only 3 items. Root cause: buildOptimizedSet
//      shipped `view.path` (2-3 items, by contract — optimizedPath.ts caps
//      the conditioned chain at 3) completely unpadded.
// Fix: ONE LCU set per champion+role, with Core/Optimized/Pro as BLOCKS
// (lines) inside it — the shop-panel grouping the user actually wants — and
// every build line (Core, Optimized, Pro) now runs through `buildLine`
// below, which enforces the invariant directly: exactly 6 items, exactly
// one boots, no duplicates, pools used to pad or fall back to when a line's
// own primary sequence over- or under-supplies. "Situational swaps" stays
// exempt — it's a swap-suggestion row, not a worn loadout, so several boots
// alternatives sitting side by side is normal, not a bug.
//
// v0.36.0 — two more user-driven changes:
//   1. FULL-ITEMS-ONLY build lines (live bug: Dark Seal — a stackable
//      component that upgrades into Mejai's Soulstealer — reached a Pro
//      build line via pro-consensus data). Root cause: proConsensus.ts's
//      `aggregateProConsensus` deliberately treats Dark Seal (and Cull,
//      Tear of the Goddess, Doran's items, the support starters) as "counts
//      as a build choice" via its own STARTING_ITEM_ALLOWLIST — correct for
//      the Pro Consensus CARD's own "what do pros keep all game" display,
//      but that same allowlist-inclusive `pro.items`/`pro.boots` data is
//      also what feeds this module's Pro build line, where a stacking/
//      starting item sitting in a "buy this next" shop-panel line makes no
//      sense. Fixed with a NARROWER, build-line-specific `isFullItem` check
//      (below) that does NOT consult that allowlist — see its own doc
//      comment. Applies to every 6-item build line (Core/Buy order/Pro/
//      themed); Starting and Situational swaps are UNCHANGED (a stacking/
//      starting item is exactly where it belongs in either of those).
//   2. "Optimized order" renamed to "Buy order" (user: "that doesn't make
//      sense") — it's the conditioned buy SEQUENCE, not a competing
//      alternative build. Purely a block-`type` string change; the
//      underlying optimizedPath.ts data/logic is untouched (out of scope —
//      that module backs CoreBuildOrderCard's own UI too).
//
// v0.43.0 through v0.48.0 built out a damage-type ARCHETYPE line system
// (Tank / AP-Mage / AP-Burst / Tank-Mage / Bruiser / Lethality / Crit /
// On-hit — up to CATEGORY_MAX_EMIT curated+data-first "themed" build blocks
// per champion, plus their own de-dup and "(low data)"/"(suggested)" honesty
// labels) on top of a "Highest WPA" themed line introduced in v0.36.0. User
// directive 2026-07-28 (see the FOUR-build-category note below) cut the
// shop panel down to exactly four blocks named for their SOURCE, and none
// of them is a themed/archetype line — so that entire system (buildThemedLine,
// buildArchetypeLine, resolveDamageFamily, selectArchetypes,
// curatedArchetypePool, categoryDefaultPool, dedupeArchetypeLines, the
// Archetype interface + curated pools, ArchetypeEvidence) went orphaned and
// was deleted in a follow-up pass (2026-07-28) once a byte-identical output
// diff across 8 live champion/role combos confirmed nothing reachable
// depended on it. See CHANGELOG / HANDOFF-engy.md for that pass's detail.
//
// AUDIT 2026-07-25 follow-up — P1-A / P1-B / P1-C. All three were found by
// driving THIS module against live prod data + the real 16.13.1 catalog; the
// 1551-test suite was green throughout and caught none of them. Each one is a
// class of silent failure, not a one-off, so each is closed structurally:
//
//   P1-A — TWO DIFFERENT SCALES WERE MERGED AS ONE RANKING AXIS. `fromPicks`
//     set weight = Pick.wpa; `fromShares` set weight = pro pick-share. The
//     Candidate doc below used to claim "wpa and share have always been this
//     module's one shared ranking axis." They are not the same axis and never
//     were: live WPA runs about -3.94 .. +1.35 and is FREQUENTLY NEGATIVE,
//     while a share is a proportion in 0..1. `unionPool` kept the MAX across
//     the two, so (a) a pro pick-rate could rescue an item whose own WPA says
//     it is actively harmful, and (b) any item with wpa > 1 outranked EVERY
//     pro pick regardless of adoption. Live symptom: a block titled
//     "Highest WPA" whose 3rd entry was there on a 0.67 pro pick-rate alone —
//     the title was a false claim about the block's own ordering.
//     FIX, two parts:
//       1. `Candidate.score` is now the ONE ranking axis, and it is
//          scale-free: each SCALE (wpa / share / gold) is ranked in its own
//          pool, best-first, and the merged score is the reciprocal RANK
//          POSITION within that pool (see buildScaleRanking). Rank positions
//          from different scales are commensurable; raw weights are not. The
//          raw number survives only as `Candidate.raw = {weight, scale}` —
//          PROVENANCE, never an ordering key. Comparing `raw.weight` across
//          two candidates is legal ONLY when both carry the same `raw.scale`,
//          and no other code in this file does it. The nesting is
//          deliberate: `c.raw.weight` is loud enough to catch in review, where
//          the old bare `c.weight` read like a neutral ranking number.
//       2. (Historical) a block whose TITLE claimed a metric was ordered by
//          that metric via a helper called `orderByMetric` (items carrying
//          the metric ranked first; items lacking it were appended as FILL).
//          That helper only ever served the "Highest WPA" themed line, which
//          was deleted along with the rest of the archetype/themed machinery
//          (see above) — item 1's invariant (`score` is the one ranking axis)
//          is what survives and still matters for every live block.
//
//   P1-B — DE-DUP ONLY COVERED ARCHETYPE-vs-ARCHETYPE. dedupeArchetypeLines
//     (v0.48.0) runs over the archetype lines only, and it runs AFTER Core
//     build / Buy order / Pro build / Highest WPA have already been emitted —
//     so the exact user complaint that motivated it ("don't duplicate, show
//     one and name it appropriately") kept firing BETWEEN BLOCK FAMILIES.
//     11 live instances, e.g. Ornn Top's `Highest WPA` and `Tank` byte-
//     identical, Garen's `Pro build` == `Highest WPA` (same 5 items, merely
//     REORDERED), Lee Sin's `Core == Buy order == Pro`. dedupeLineBlocks now
//     runs over EVERY build-line block. The duplicate test is the identical
//     item SET, ORDER-INSENSITIVE (Garen's case is why order can't be part of
//     it) with ONE carve-out: the Core build / Buy order pair counts as a
//     duplicate only when the order matches too, because expressing the order
//     is Buy order's entire reason to exist.
//
// (P1-C, the third fix in that same audit pass, was a mislabelling bug in
// `buildArchetypeLine`'s "(low data)"/"(suggested)" honesty suffix — deleted
// along with the rest of the archetype machinery above; ArchetypeEvidence no
// longer exists.)
//
// Item-set schema per set (LCU /lol-item-sets/v1/item-sets/{id}/sets
// contract, community-standard importer shape — see companion.ps1's own
// header comment for the full wire contract + PUT-replaces-all merge-safety
// note): {uid, title, type:'custom', map:'any', mode:'any',
// associatedMaps:[], associatedChampions:[champ.id], preferredItemSlots:[],
// sortrank:0, blocks:[{type:'<block label>', items:[{id:'<STRING>',
// count:1}]}]}. Item ids are STRINGS in item sets (unlike LCU rune perk ids,
// which stay numeric — see runeApplyBody.ts's own header note on that
// separate id space).
//
// ── Boots identification (structural AND classified — both, on purpose) ───
// v0.34.1 shipped this module against `Pick` (lib/types.ts) alone, which
// carries no `tags` field, so boots detection had to be STRUCTURAL: an id is
// boots because it arrived in a slot the contract calls boots (items.boots /
// alts.boots / pro.boots / otp.boots). v0.36.0 threaded real ItemDetail
// metadata in for the full-item rule but left boots detection structural only.
//
// 2026-07-29: structural-only was not enough, and the gap shipped. A boot the
// live catalog forgets to TAG as one (3172 Gunmetal Greaves) gets partitioned
// upstream into `pro.items`/`otp.items` instead of `.boots`, so it reached
// `collectBootsIds` through no boots slot at all, `buildLine` counted it as a
// full item, and a line went out holding Swiftmarch AND Gunmetal Greaves.
// `collectBootsIds` now unions the structural sources with a CLASSIFIED pass
// over every candidate id, using lib/bootsItems.ts — THE boots predicate,
// shared with proConsensus.ts and lib/otp/featuredBuild.ts, which were both
// carrying their own `tags.includes("Boots")` copy of the same wrong rule.
// Read that module's header before touching any of this. The two sources are
// kept because they fail in opposite directions: structural survives a total
// metadata-fetch failure, classified survives a wrong upstream partition.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, BuildResponse, ItemsBlock, Pick as PickType } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";
import { flattenSituational, situationalShortlist } from "./situational";
import {
  applyForThisGameLine,
  FOR_THIS_GAME_BLOCK_TITLE,
  type ForThisGamePlan,
  type ForThisGameSwap,
} from "@/lib/enemyComp/forThisGame";
import { wpaText } from "@/components/StatBadge";
import { resolveOptimizedPathView } from "./optimizedPath";
import { isBootsItem, isFinalBootsItem, type ItemCatalog } from "@/lib/bootsItems";
import {
  applyPositionRanks,
  orderedIdRanks,
  wpaSlotRanks,
  type PositionPrior,
} from "@/lib/positionalPriors";

export interface ItemSetItem {
  id: string;
  count: number;
}

export interface ItemSetBlock {
  type: string;
  items: ItemSetItem[];
}

export interface ItemSet {
  uid: string;
  title: string;
  type: "custom";
  map: "any";
  mode: "any";
  associatedMaps: number[];
  associatedChampions: number[];
  preferredItemSlots: string[];
  sortrank: number;
  blocks: ItemSetBlock[];
}

/** Already-resolved pro-consensus item frequencies, sorted by share desc —
 *  exactly the shape components/hextech/proConsensus.ts's own
 *  `ProConsensusModel.items`/`.boots` arrays already are. This builder stays
 *  pure/synchronous by taking the resolved numbers rather than fetching them
 *  itself; components/hextech/itemSetsApply.ts is where the actual
 *  /api/pros + item-metadata fetch lives (the same aggregation
 *  ProConsensusCard.tsx already performs independently — see that module's
 *  header for why "Pro" here needs its own fetch, since pro-consensus data
 *  isn't part of the /api/build BuildResponse contract at all). `boots` is
 *  ALREADY partitioned out of `items` by aggregateProConsensus's own
 *  tags-based check — see this module's header for why that matters.
 *
 *  CORRECTION (this doc said the opposite until the 2026-07-25 audit): these
 *  arrays are NOT allowlist-inclusive. Since the 2026-07-22 partition,
 *  aggregateProConsensus carves STARTING_ITEM_ALLOWLIST entries into their own
 *  `starters` field, which this input shape does not carry at all. The old
 *  wording ("ALLOWLIST-INCLUSIVE — this module's own `isFullItem` re-filters")
 *  told the next reader that isFullItem was the live guard for lane starters.
 *  It was not, and believing it is why Doran's Bow and Doran's Helm shipped
 *  inside completed build lines in production (v0.56.0 P0-A). isFullItem's
 *  starter rule is a STRUCTURAL backstop, not a re-filter of a list that is
 *  already applied upstream.
 *
 *  2026-07-26: `items` carries AT MOST ONE support-quest final. The five are
 *  mutually exclusive (Bounty of Worlds upgrades into exactly one), and
 *  aggregateProConsensus now partitions them into their own
 *  `ProConsensusModel.supportFinals` field; itemSetsApply.ts folds only the
 *  top pick back in here. Before that partition this array could carry two of
 *  them, and a 6-item Pro shop line could genuinely recommend both — the same
 *  bug the Pro Consensus card was reported for. Nothing in THIS module
 *  deduplicates the family, so do not reintroduce more than one upstream. */
export interface ProConsensusItemsInput {
  items: { itemId: number; share: number }[];
  boots: { itemId: number; share: number }[];
  /** 2026-08-27 (RC-2) — `items` is ALREADY in real purchase order and must
   *  NOT be re-sorted by share.
   *
   *  Absent/false means the only thing the source could offer is a frequency
   *  ranking. That is not a buy order and this file must stop presenting it as
   *  one: the block keeps the order it was given AND changes its own title
   *  (see `consensusBlockTitle`), because a block's title is a claim about its
   *  contents and "Pro build" read left to right in the shop panel is a claim
   *  about sequence.
   *
   *  Permanently absent for OTP: `/api/otp` sets `purchaseOrder: []`
   *  unconditionally — its ingest skips the match-v5 timeline call on purpose —
   *  so there is no order to have. A flag rather than an inference from the
   *  data, so the day the OTP ingest starts fetching timelines the title fixes
   *  itself with no code change here. */
  ordered?: boolean;
  /** 2026-08-28 (RC-5) — the ids this source's timelines actually POSITIONED,
   *  in median purchase order: `ConsensusArtifactSource.p` verbatim.
   *
   *  Present exactly when `ordered` is, and NOT the same list as `items`:
   *  `items` additionally carries every id the sample could not position,
   *  trailing behind the ones it could. This field exists because the OTHER
   *  source uses it as a positional prior (see `consensusPoolOrder`), and
   *  handing over `items` instead would export an order this sample never
   *  measured. */
  orderedIds?: number[];
  /** 2026-08-29 — set to the ARTIFACT'S OWN patch when these numbers came from
   *  a precomputed artifact that is one or two patches behind the build being
   *  exported (`classifyConsensusArtifactFreshness` -> `"stale"`).
   *
   *  Serving stale is deliberate and measured — see that function — but the
   *  standing rule on this file is that a block's title is a CLAIM about its
   *  contents, and "Pro build" on patch 16.17 claims 16.17 pros. So the title
   *  carries the patch the numbers are actually from. Absent on every fresh
   *  serve and on every live query, so the healthy export is unchanged. */
  stalePatch?: string;
}

const LINE_LEN = 6;

// ── Situational (2026-08-19, user directive) ────────────────────────────────
// "i want you to also add the situational items shown here into the in game
// item list as well as another item set." — the SITUATIONAL panel on the
// Builds page, verbatim, reaching the shop.
//
// It used to be emitted (as "Situational swaps") and was cut by the 2026-07-28
// four-build-category directive along with the archetype lines. This brings it
// back as a FIFTH block plus a standalone second set, and it is deliberately
// NOT a fifth LineFamily:
//
//   * `buildLine` must not touch it. That function enforces "a worn loadout":
//     exactly 6, exactly ONE boots, padded from the fallback cascade. A
//     situational list is a SWAP ROW — three boots alternatives sitting side by
//     side is the answer, not a bug (this file has said so since v0.34.1), and
//     padding it from the pro/optimized pools would put items in it that the
//     champion's own per-slot alternatives never offered, under a label that
//     claims they did.
//   * `fullItemsOnly` must not touch it either, for the reason the v0.36.0
//     header already gives: a stacking/starting item is exactly where it
//     belongs in a swap row.
//   * It is not in `dedupeLineBlocks`. That machinery compares BUILDS. A
//     situational row that happens to overlap a build line is not "the same
//     recommendation twice" — see the duplicate note on `situationalBlockPicks`.
//
// The label is "Situational" and not "Situational swaps": the Builds page's own
// panel heading is SITUATIONAL, and the two surfaces now show the same six
// items, so they should say the same word.
const SITUATIONAL_BLOCK_TYPE = "Situational";

/** The picks that go in the Situational block — the SAME window the Builds
 *  page's SituationalCard renders, from the SAME field of the SAME response
 *  (`BuildResponse.items.alts`, per-slot ranked alternatives). Not a
 *  re-derivation and not a heuristic: `situationalShortlist` is the one helper
 *  both surfaces call, and `SITUATIONAL_DISPLAY_LIMIT` lives beside it.
 *
 *  ── ORDER ────────────────────────────────────────────────────────────────
 *  WPA descending (`flattenSituational`'s own sort, id ascending as tiebreak).
 *  That is the same number the panel prints beside each item, and in the shop
 *  it is the ONLY thing that survives: an LCU block item is `{id, count}` and
 *  has nowhere to put a delta. Negative-delta picks therefore land last for
 *  free.
 *
 *  ── NEGATIVE DELTAS: INCLUDED, AND HERE IS WHY, WITH THE NUMBERS ─────────
 *  Measured 2026-08-19 against live prod (`/api/build`, patch 16.16, all 173
 *  champions x 5 lanes; 323 combos returned build data, 273 of them carry at
 *  least one situational pick):
 *    - 1,132 top-6 slots. 623 of them (55.0%) have wpa < 0.
 *    - 252 of 323 combos (78.0%) have at least one negative pick in the top 6.
 *    - 62 combos are ENTIRELY negative in the top 6.
 *    - Worst that would ship: Xerath mid, Ionian Boots of Lucidity, -5.54.
 *  So this is not an edge case, and a floor at 0 is not a cosmetic tweak: it
 *  would delete the block outright for 62 champion+lane combos and, on the very
 *  champion the user was looking at (Galio mid), drop Sunfire Aegis at -0.06 —
 *  an item they explicitly pointed at.
 *
 *  Three reasons it ships unfiltered anyway:
 *    1. The block's title is a claim about its SOURCE, which is this file's
 *       standing rule. "Situational" claims these are the alternatives the
 *       champion's own per-slot data offers. That is true of every entry,
 *       including the negative ones. It does not claim they are better.
 *    2. Shop and page must not disagree about what a named block contains
 *       (the Hidden gem precedent above). A shop-only floor makes them
 *       disagree on 252 of 323 combos.
 *    3. There is no principled floor available today. The obvious candidate,
 *       `Pick.lowSample`, is measurably ANTI-correlated: 21.5% of negative
 *       slots are lowSample vs 47.2% of non-negative ones, and 4 of Galio
 *       mid's own 6 screenshot picks are flagged lowSample. Filtering on it
 *       would cut the user's list from 6 to 2 and still keep a -4.96. Picking
 *       a bare number instead (-0.02, -0.5) would be a magic constant this
 *       file would have to defend and could not.
 *
 *  OPEN, and reported rather than silently decided: the principled version of
 *  the filter is RELATIVE, not absolute — an alternative only means anything
 *  against the pick it replaces (Galio's Ionian Boots at +4.27 beats his own
 *  Sorcerer's Shoes at +1.56 and is a genuine recommendation; Xerath's Ionian
 *  at -5.54 is not). That needs the per-SLOT provenance `flattenSituational`
 *  currently discards when it flattens `alts` into one list, so it is a real
 *  change to the data model and a user call, not a silent one. See
 *  HANDOFF-core-situational.md.
 *
 *  ── DUPLICATES: EXCLUDE THE WPA BUILD, AND NOTHING ELSE ─────────────────
 *  `excludeIds` is the emitted WPA build line's ids. An item that block
 *  already tells you to buy is not an ALTERNATIVE to your build — it IS your
 *  build, and naming it both "buy this" and "consider this instead" in one
 *  shop panel is a contradiction, not extra information.
 *
 *  Scoped to that one block on purpose, and the split is measured. Live, 2026-
 *  08-19, driving the real export path (`/api/build` + `/api/pros` + `/api/otp`
 *  + the 16.16.1 catalog) over 38 champion+lane combos, 124 emitted situational
 *  slots:
 *    - 8 slots (6.5%), on 8 combos, also sat in the WPA build. Never more than
 *      one per combo. These are the contradiction, and they are what this
 *      excludes.
 *    - 58 slots (46.8%) also sat in a Pro / OTP / Hidden gem block. Those are
 *      KEPT. Those blocks answer a different question ("what do pros build")
 *      and an item being both is a real finding, not a duplicate — the same
 *      reasoning that stops `dedupeLineBlocks` collapsing Pro into WPA.
 *  Nothing is hidden by the exclusion: the excluded id is still on screen in
 *  the very same set, in the block directly above.
 *
 *  Order matters. The top-6 window is taken FIRST and the exclusion applied
 *  after, so the block is always a SUBSET of what the Builds page showed. It
 *  never reaches for a 7th pick to backfill — a shop block containing an item
 *  the page did not show would be a worse disagreement than a shorter one.
 *
 *  BOOTS ARE SAFE FROM THIS, structurally, not by luck. The situational boots
 *  live in `items.alts.boots`, which by construction never contains the boot
 *  the build chose (Galio: alts.boots is Ionian/Swiftness/Steelcaps; the chosen
 *  boot, Sorcerer's Shoes 3020, is not among them). Measured: 0 collisions
 *  between a top-6 situational pick and the champion's own core picks across
 *  all 323 live combos. So a situational boot is never dropped because a
 *  DIFFERENT boot is in the main path — only ever because the WPA line took
 *  that exact boot, which is the one case where it genuinely is not an
 *  alternative.
 *
 *  @param excludeIds ids already emitted in the WPA build block. Pass an empty
 *                    set to get the panel's own list verbatim. */
export function situationalBlockPicks(
  items: ItemsBlock,
  excludeIds: ReadonlySet<number> = new Set()
): PickType[] {
  return situationalShortlist(items).filter((p) => !excludeIds.has(p.id));
}

// ── Putting the WPA number in the shop (2026-08-19, user directive) ──────────
// "is there a way to show the wpa values in game so i can make better
// decisions on what to buy?"
//
// ── THE FIRST ANSWER, AND WHY IT IS GONE (0.113.x -> 0.114.0) ──────────────
// An LCU block item is `{id, count}`. There is no field on an ITEM for a
// number, and the only writable string anywhere near an item is its BLOCK's
// title — so 0.113.0 gave every situational pick a block of its own titled
// `Situational +4.27`. It worked, and the SHAPE was rejected on sight: it
// turned a 5-block set into ELEVEN blocks, against a client whose own sets
// never exceed five. User, 2026-08-19: "doesnt look great".
//
// So the number does NOT go in the shop's own chrome any more. The row is one
// plain `Situational` block again, and the deltas are drawn by CoachBuild's
// own overlay ON TOP OF the item icons — the only surface that can put a
// number next to an icon without asking the client for a place to put it.
//
// ── WHAT THAT COSTS THIS FILE: the deltas now leave on the wire ────────────
// The overlay needs the same numbers, bound to the same items, in the same
// order. `situationalWire` below emits them as an optional `situational`
// array on the `/apply-itemsets` body.
//
// ONE DERIVATION, TWO CONSUMERS. `buildItemSets` calls `situationalBlockPicks`
// exactly ONCE and hands the SAME array to `situationalBlocks` (what the shop
// renders) and `situationalWire` (what the overlay draws). Recomputing the
// shortlist for the wire would be a second derivation of a FILTERED list, and
// the WPA-build exclusion is exactly where two derivations diverge: the block
// drops an id the build already recommends, an independently-recomputed wire
// would not, and the overlay would then paint the Nth number over the (N+1)th
// icon. A test drives a fixture where that exclusion bites and asserts the
// pairing index-by-index, so a recompute fails rather than misaligning
// silently.
//
// THE NUMBER IS A STRING ON THE WIRE, formatted HERE by `wpaText` — the Builds
// page's own formatter. The desktop renders `text` verbatim and never formats
// a number itself. Two surfaces printing the same field through two formatters
// is how they end up disagreeing at a rounding boundary (`wpaText` prints a
// leading `+` on positives; a bare `toFixed(2)` prints none, so every positive
// delta in the shop would disagree with the page immediately).
// `wpa` also rides along as the raw number, and the desktop uses ONLY ITS
// SIGN, for colour.
//
// DECORATION, NEVER A PRECONDITION. The field is optional in both directions:
// an older desktop / older companion.ps1 ignores it (companion.ps1's
// `Test-ItemSetsPayload` is handed `$bodyObj.sets`, never the body, so a new
// top-level field is not reachable by it; C#'s `ApplyItemSetsRequest` is
// deserialized with `JsonOptions.Wire`, which does not set
// `UnmappedMemberHandling.Disallow`, so System.Text.Json's default skips
// unknown members — both pinned by source tests in
// components/__tests__/situationalItemSet.test.ts), and a newer desktop
// against an older web simply receives nothing. Nothing about `situational`
// may fail or alter an apply.
//
// OMITTED, NOT EMPTY, when there are no picks — the key is absent rather than
// `situational: []`. "There is no such field" and "there are zero of them" are
// the same fact here, and an absent key is the one an older bridge, a stale
// cache and a future strict validator all already agree on.
//
// ── "NEVER RENDER A FABRICATED ZERO": MEASURED, AND IT DOES NOT ARISE HERE ─
// `Pick.wpa` is a non-nullable number, so a 0 could in principle mean "no
// data". Swept 150 champion+lane combos / 487 situational picks against live
// prod, 2026-08-19: **exactly-zero wpa: 0 of 487.** Three round to 0.00 for
// display (|wpa| < 0.005) and are real, tiny measurements. So every number on
// the wire below is a genuine value; there is nothing to suppress. (260 of 487
// are negative — that is the known, deliberately-kept negative tail, ordered
// last, not an absence.) If a future data source ever DOES emit a placeholder
// zero, this is the paragraph that is now wrong, and `text` must degrade to a
// dash rather than print it.

/** One situational delta on the `/apply-itemsets` wire, for the desktop
 *  overlay to draw over the matching item icon.
 *
 *  `id`   — pairs POSITIONALLY with the `Situational` block's items. Same
 *           membership, same order, same length, by construction (see
 *           `buildItemSets`).
 *  `wpa`  — the raw measurement. The desktop uses only its SIGN, for colour.
 *  `text` — what to draw, already formatted by `wpaText`. Rendered verbatim;
 *           the desktop never formats a number itself. */
export interface SituationalWireEntry {
  id: number;
  wpa: number;
  text: string;
}

/** What `buildItemSets` returns: the sets that go to the bridge, plus the
 *  optional overlay deltas.
 *
 *  A RECORD RATHER THAN A SIBLING FUNCTION, deliberately. The obvious
 *  alternative — a second exported pure function taking the same
 *  (champ, roleLabel, build, pro, itemMeta, otp) inputs — would have to derive
 *  the shortlist a SECOND time to answer, which is the precise failure this
 *  field exists to avoid (see the note above). Returning both from the one
 *  call makes the shared derivation structural instead of a convention two
 *  functions have to keep, and it is why the record was worth the churn at
 *  every call site.
 *
 *  `sets` is still a LIST and is still posted WHOLE. Both bridges' merge keeps
 *  only the sets in the current write and prunes every other CoachBuild-titled
 *  set, so a caller that sliced it would delete the rest — see
 *  itemSetsApply.ts's "one call, never slice" contract. */
export interface ItemSetExport {
  sets: ItemSet[];
  /** OMITTED (key absent) when there are no situational picks — never `[]`,
   *  never `null`. */
  situational?: SituationalWireEntry[];
  /** The changes the `For this game` block actually made, in the order it made
   *  them. OMITTED (key absent) when there is no such block.
   *
   *  ONE DERIVATION, TWO CONSUMERS, exactly like `situational` above and for
   *  the same reason. The caption that rides the `diagnostics` array to
   *  `companion.log` is built from THIS array, not from a second call to
   *  `applyForThisGameLine`, because the line assembly is where a swap can
   *  turn out to be a MOVE rather than a replacement — and a caption derived
   *  independently would name a displaced item that the block did not actually
   *  displace. */
  forThisGame?: ForThisGameSwap[];
}

/** The Situational row as shop blocks: exactly ONE `Situational` block
 *  carrying every pick in the picks' own order (WPA descending, negatives
 *  last), or `[]` for no picks — never an empty block.
 *
 *  ONE BLOCK, not one per pick. 0.113.x titled a block per item to bind a
 *  number to it (`Situational +4.27`); the user rejected the shape, and the
 *  numbers moved to the overlay via `situationalWire`. Nothing lives in a
 *  block title now, so there is no longer any reason to split the row.
 *
 *  Returns an array rather than one block because the caller splices it into
 *  `blocks` and the empty case must contribute nothing. */
export function situationalBlocks(picks: readonly PickType[]): ItemSetBlock[] {
  if (picks.length === 0) return [];
  // NO COMP SUFFIX (0.120.0). 0.118.0 titled this `Situational vs CC` /
  // `vs AD` / `vs AP` when the enemy-comp signal fired. The comp now gets its
  // own block -- `For this game`, a whole adjusted build -- and two
  // comp-driven opinions in one set cannot be reconciled by the reader. This
  // row is a pure SOURCE claim again. See situational.ts's own note.
  return [{ type: SITUATIONAL_BLOCK_TYPE, items: picks.map((p) => itemRef(p.id)) }];
}

/** The same picks as `situationalBlocks`, as overlay deltas.
 *
 *  Takes the ALREADY-RESOLVED picks — not an `ItemsBlock` — on purpose: a
 *  function that took the raw items would have to re-run the shortlist and the
 *  exclusion, and could then disagree with the block it exists to annotate.
 *  Its only input is the block's own input.
 *
 *  Order is preserved verbatim, so `wire[i]` describes `block.items[i]`. */
export function situationalWire(picks: readonly PickType[]): SituationalWireEntry[] {
  return picks.map((p) => ({ id: p.id, wpa: p.wpa, text: wpaText(p.wpa) }));
}

// ── Cross-family de-dup (audit P1-B) ────────────────────────────────────────
// The shop panel used to carry Core build + Buy order + Pro build + OTP build
// + Highest WPA + up to 4 damage-archetype categories + Situational swaps —
// up to nine blocks to triage mid-champ-select, and an earlier archetype-only
// de-dup (superseded, since removed along with the rest of that machinery —
// see the module header) missed duplicates that crossed BLOCK FAMILIES: 11
// live instances across 23 champions, e.g. Ornn Top's `Highest WPA` and
// `Tank` byte-identical, Garen's `Pro build` == `Highest WPA` (same 5 items,
// merely REORDERED). dedupeLineBlocks below runs over EVERY build-line block,
// EXACT match, item SET, ORDER-INSENSITIVE.

/** Which build-line family a block belongs to. Order of declaration is the
 *  canonical EMISSION order and also the keep-priority order — the block a
 *  user reads first is the one that survives a collision. */
// FOUR build categories, and only four (user directive 2026-07-28). Each
// answers a DIFFERENT question:
//
//   wpa  — what the app's own WPA model recommends (the Builds page headline)
//   pro  — what professionals actually built
//   otp  — what the champion's one-tricks actually built
//   gem  — what almost nobody builds but wins when they do (selectHiddenGemPicks)
//
// Rank order is collision priority for dedupeLineBlocks. `gem` is last on
// purpose — if the hidden gem equals a headline build it was never hidden, and
// the block should disappear rather than repeat.
//
// wpa/pro/otp are NEVER dropped for duplicating each other (user directive
// 2026-07-29: "just put both item sets so i can see its the same for pro and
// otps"). Each names a SEPARATELY SOURCED answer to the same question, so two
// of them landing on the same items is itself the finding — the pros and the
// one-tricks agree with the model — and collapsing them hides it. Worse, the
// collapse is indistinguishable from having no data for that source: the reader
// sees a missing block, not a consensus. So both are shown, and the later one
// says whose build it matches (see `sameAs`), which is what makes the agreement
// legible rather than merely repeated.
type LineFamily = "wpa" | "pro" | "otp" | "gem";

/** Families whose label is a claim about a SOURCE rather than about a shape,
 *  and which therefore still earn a block when their items duplicate an earlier
 *  one. `gem` is the only family outside this set, and has to be: it is defined
 *  as what almost nobody builds, so a gem equal to a headline build is
 *  self-contradictory and the honest move is to not show it at all. */
const SOURCE_CLAIM_FAMILIES: ReadonlySet<LineFamily> = new Set<LineFamily>(["wpa", "pro", "otp"]);

const FAMILY_KEEP_RANK: Record<LineFamily, number> = {
  wpa: 0,
  pro: 1,
  otp: 2,
  gem: 3,
};

interface LineBlock {
  type: string;
  family: LineFamily;
  /** Lower survives a collision. */
  keep: number;
  /** Position in canonical emission order — preserved for the surviving set. */
  emit: number;
  line: Candidate[];
  /** Set when this block's item set is EXACTLY an earlier block's, naming that
   *  block. Rendered into the title so the panel states the agreement instead
   *  of leaving two identical-looking blocks unexplained. Never set on a
   *  near-duplicate: see dedupeLineBlocks. */
  sameAs?: string;
  /** The patch these numbers are from, when that is NOT the patch being
   *  exported. See `ProConsensusItemsInput.stalePatch`. Only the pro and OTP
   *  blocks can carry it — every other block is computed from the live
   *  `BuildResponse`, which is the current patch by definition. */
  stalePatch?: string;
}

function idSetKey(line: Candidate[]): string {
  return Array.from(new Set(line.map((c) => c.id))).sort((a, b) => a - b).join(",");
}

/** How many items a block may carry that a higher-priority block does not,
 *  before it counts as a near-duplicate.
 *
 *  SCOPE, since 2026-07-29: being a near-duplicate now only removes a `gem`
 *  block. For wpa/pro/otp it decides nothing about visibility — they are always
 *  shown — and only the stricter EXACT-set test drives the "(same as X)" label.
 *  The reasoning below is why the threshold is 1 and is unchanged; what changed
 *  is that "these two are alike" stopped meaning "hide one of them" for the
 *  three source-claim families.
 *
 *  1 means "shares all but one item". User directive 2026-07-28, from a live
 *  report on Viktor Mid that the OTP and Hidden gem blocks "look too much like
 *  the first two".
 *
 *  They did, and the cause is arithmetic rather than a bug in any one block.
 *  Every line is built to SIX slots, but no source supports six. Measured on
 *  Viktor Mid the same day: the one-trick feed had 65 games from 8 players with
 *  only FIVE items above 20% agreement; the pro feed had 300 games and also only
 *  five. Both lines therefore run out of their own evidence and pad the rest from
 *  the shared fallback cascade (optimized → situational → the other consensus →
 *  the champion's core), so the tails converge by construction. Hidden gem is the
 *  extreme case: GEM_MIN_ITEMS is 1 and the remaining slots fill from the WPA
 *  build, so a gem block is typically one distinctive item and five copied ones.
 *
 *  The underlying data is NOT degenerate — Viktor's one-tricks put Lich Bane at
 *  40% where pros have it at 21%, and build Void Staff where pros build
 *  Rabadon's. That signal is real; it was just being diluted to one or two slots
 *  out of six and shown at the same visual weight as the filler.
 *
 *  So: a block that differs by a single item is the same recommendation with a
 *  swap, not a second opinion worth a labelled block in a shop panel you read
 *  mid-game. Dropping it is better than showing it, because a block's TITLE is a
 *  claim about where its contents came from. */
const MAX_UNIQUE_ITEMS_FOR_NEAR_DUPLICATE = 1;

/** Two blocks collide when the later one adds at most
 *  MAX_UNIQUE_ITEMS_FOR_NEAR_DUPLICATE items the earlier one does not have —
 *  ORDER-INSENSITIVE, and asymmetric on purpose: what matters is whether the
 *  CANDIDATE still tells the reader something, not whether the two are alike in
 *  the abstract. A 3-item block wholly contained in a kept 6-item block adds
 *  nothing and goes, which set equality would have missed entirely.
 *
 *  Order-insensitive is load-bearing: Garen Top shipped `Pro build` and
 *  `Highest WPA` with the same five items merely REORDERED, and a user reading
 *  two blocks with identical contents does not care which permutation each one
 *  chose — it is the same build shown twice.
 *
 *  The old Core-build/Buy-order carve-out (where ORDER was part of the content,
 *  because Buy order existed only to re-express the same items in purchase
 *  order) went with Buy order itself in the 2026-07-28 four-category cut. All
 *  four surviving families name a distinct SOURCE, so two of them landing on
 *  the same item set genuinely is the same recommendation twice, in any order.
 *
 *  BOOTS: they count as ordinary items here, so two lines differing ONLY in
 *  their boot register as near-duplicates. This used to discard a real build
 *  difference. Since pro/otp are no longer dropped it no longer can, except on
 *  a `gem` block — and a gem whose only distinction from the WPA build is its
 *  boot is not a hidden gem in any useful sense, so collapsing it there is the
 *  wanted behaviour rather than a tolerated loss. A boots-only pro/OTP split now
 *  renders as two blocks with no "(same as)" label, because the sets are not
 *  identical, which is exactly how the reader spots the difference. */
function duplicateBlocks(kept: LineBlock, cand: LineBlock): boolean {
  return uniqueTo(cand.line, kept.line) <= MAX_UNIQUE_ITEMS_FOR_NEAR_DUPLICATE;
}

/** Count of distinct item ids in `line` that do not appear in `other`.
 *
 *  Array.from around the Set rather than iterating it directly: this file is
 *  compiled by the Next build with a target that does not downlevel Set
 *  iteration, so `for (const x of someSet)` type-checks under tsc and then
 *  fails the build. */
function uniqueTo(line: Candidate[], other: Candidate[]): number {
  const seen = new Set(other.map((c) => c.id));
  const distinct = Array.from(new Set(line.map((c) => c.id)));
  return distinct.filter((id) => !seen.has(id)).length;
}

/** Resolve duplicate build-line blocks across ALL families against whichever
 *  comes first in canonical emission order.
 *
 *  Only `gem` is ever REMOVED (see SOURCE_CLAIM_FAMILIES). A wpa/pro/otp block
 *  that duplicates an earlier one is KEPT and tagged with `sameAs`, so the
 *  panel shows the agreement between two independent sources instead of
 *  swallowing one of them.
 *
 *  `sameAs` is set only on an EXACT item-set match, never on a near-duplicate.
 *  A line that differs by one item is not the same build, and this module's
 *  standing rule is that a block's label is a claim about its contents — so
 *  "same as Pro build" has to actually be true. Near-duplicates simply render
 *  side by side and let the reader see the one-item difference for themselves,
 *  which is the whole point of showing both.
 *
 *  Deterministic: `keep` is a total order (family rank, then the emission index
 *  as a final tiebreak), and the survivors are returned in emission order so
 *  the block layout the user sees never depends on the dedup's internal
 *  traversal. `type` is never mutated, so a `sameAs` label always names a
 *  block's ORIGINAL title and can never nest into
 *  "OTP build (same as Pro build (same as WPA build))". */
function dedupeLineBlocks(blocks: LineBlock[]): LineBlock[] {
  const byKeep = [...blocks].sort((x, y) => x.keep - y.keep || x.emit - y.emit);
  const kept: LineBlock[] = [];
  for (const cand of byKeep) {
    const clash = kept.find((k) => duplicateBlocks(k, cand));
    if (!clash) {
      kept.push(cand);
      continue;
    }
    if (!SOURCE_CLAIM_FAMILIES.has(cand.family)) continue;
    const identical = idSetKey(clash.line) === idSetKey(cand.line);
    kept.push(identical ? { ...cand, sameAs: clash.type } : cand);
  }
  return kept.sort((x, y) => x.emit - y.emit);
}

/** The title the shop panel actually shows. Parentheses rather than a dash
 *  because the client renders these titles in a narrow column and a bracketed
 *  suffix stays readable when it wraps.
 *
 *  The stale tag is composed HERE and never written into `LineBlock.type`, for
 *  the same reason `sameAs` is not: `dedupeLineBlocks` labels a duplicate with
 *  the other block's `type`, so a tag living in `type` would nest into
 *  `OTP build (16.16 data) (same as Pro build (16.16 data))`. One tag, at the
 *  end, whatever else the title says. */
function blockTitle(b: LineBlock): string {
  const base = b.sameAs ? `${b.type} (same as ${b.sameAs})` : b.type;
  return b.stalePatch ? `${base} (${b.stalePatch} data)` : base;
}

function slugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "x";
}

function itemRef(id: number, count = 1): ItemSetItem {
  return { id: String(id), count };
}

// ── Candidate: the one shape `buildLine` construction operates on ─────────
// Unifies Pick (wpa-ranked — Core/Optimized/Situational's native shape) and
// pro/OTP-consensus entries (share-ranked) behind one type, so the
// dedup/boots-fix/padding/ranking logic below is written ONCE, not once per
// pool type.
//
// THE INVARIANT THIS TYPE EXISTS TO ENFORCE (audit P1-A, see header):
//   `score` is the ONLY ranking axis. `raw.weight` is PROVENANCE and must
//   never be compared against another candidate's unless `raw.scale` is
//   identical — because -3.94 (a real live WPA) and 0.67 (a real live pro
//   share) are not two points on one number line, and the module spent three
//   releases pretending they were. No code in this file compares raw weights
//   across candidates any more — buildLine, findBestBoots and everything else
//   sorts on `score`.

/** Which number line a raw weight lives on. `wpa` can be negative and is
 *  unbounded; `share` is a proportion in 0..1; `gold` is an item's total cost.
 *  No two of these are comparable. */
type WeightScale = "wpa" | "share" | "gold";

interface RawWeight {
  weight: number;
  scale: WeightScale;
}

interface Candidate {
  id: number;
  /** THE ranking axis: this id's reciprocal rank position WITHIN its own
   *  scale's pool (1 for the best, 1/2 for the runner-up, ...). Scale-free by
   *  construction, so a candidate ranked out of the WPA pool and one ranked
   *  out of the pro-share pool can be compared without inventing a conversion
   *  between win-probability points and pick rates. */
  score: number;
  /** Provenance only — NEVER an ordering key. See the invariant above. */
  raw: RawWeight;
}

/** One scale's full ranking table for this champion: id -> {raw weight, rank
 *  score}. Built ONCE per scale over EVERY source that speaks that scale, so
 *  a WPA rank means the same thing whether the item came from the core build,
 *  the optimized path or the situational pool — the old code ranked pools
 *  independently, which made "best in a 3-item pool" and "best in a 20-item
 *  pool" the same number. */
type ScaleRanking = ReadonlyMap<number, RawWeight & { score: number }>;

/** Rank `entries` best-first within a single scale and hand back the rank
 *  table. Reciprocal rank (`1/(1+rank)`) rather than the position-normalised
 *  `1 - i/len` on purpose: `1 - i/len` is POOL-SIZE SENSITIVE (last place in a
 *  3-item pool scores 0 while 10th of 20 scores 0.5), which would hand small
 *  pools an inflated merge weight — the same class of incommensurability this
 *  whole change exists to remove. Reciprocal rank depends only on position.
 *
 *  Duplicate ids collapse to their MAX weight — legal here and only here,
 *  because both weights are on the same scale by construction (this is the
 *  "credit an item its best evidence" rule unionPool used to apply ACROSS
 *  scales, which is what made it a bug).
 *
 *  Ties share a rank (competition ranking), so two items with identical
 *  weights are never ordered by an accident of input order; the id tiebreak in
 *  the sort keeps the table itself deterministic. */
function buildScaleRanking(
  scale: WeightScale,
  entries: { id: number; weight: number }[]
): ScaleRanking {
  const best = new Map<number, number>();
  for (const e of entries) {
    const prev = best.get(e.id);
    if (prev === undefined || e.weight > prev) best.set(e.id, e.weight);
  }
  const sorted = Array.from(best.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out = new Map<number, RawWeight & { score: number }>();
  let rank = 0;
  let prevWeight = Number.NaN;
  sorted.forEach(([id, weight], idx) => {
    if (weight !== prevWeight) {
      rank = idx;
      prevWeight = weight;
    }
    out.set(id, { weight, scale, score: 1 / (1 + rank) });
  });
  return out;
}

/** Resolve one id against its scale's ranking table.
 *  The `fallback` branch is unreachable by construction — every ranking in
 *  buildItemSets is built from the exact union of the pick/share sources the
 *  pools are then derived from — but it degrades deterministically (rank last
 *  within its own scale, provenance preserved) rather than throwing on a
 *  future call site that forgets to feed its source into the ranking. */
function toCandidate(id: number, ranking: ScaleRanking, fallback: RawWeight): Candidate {
  const r = ranking.get(id);
  if (!r) return { id, score: 0, raw: fallback };
  return { id, score: r.score, raw: { weight: r.weight, scale: r.scale } };
}

// ── Hidden gem ───────────────────────────────────────────────────────────────
//
// The fourth category: "a build that isn't thought of by users, or has high
// winrate but low play rate" (user directive 2026-07-28).
//
// This is the ONE line derived from a claim about the world rather than from a
// ranking, so it carries the most risk of being confidently wrong. High winrate
// at low play rate is the classic small-sample trap: an item bought 9 times that
// happened to win 7 is not a hidden gem, it is noise wearing a percentage. Three
// guards, all deliberately conservative:
//
//   1. MIN_GEM_OCCURRENCE — an absolute sample floor. Below it a winrate is not
//      evidence of anything, whatever the margin.
//   2. GEM_WINRATE_MARGIN_PP — it must beat the pool's own baseline winrate by a
//      real margin, not by rounding.
//   3. GEM_PLAY_RATE_CEILING — it must be genuinely UNDER-played relative to
//      that same pool. An item everyone already builds cannot be hidden.
//
// And a fourth, structural: anything already in the WPA build is excluded
// outright. A "hidden" pick that is already your top recommendation is not
// hidden — it is just the build, and repeating it would make the block a lie.
//
// When fewer than GEM_MIN_ITEMS candidates clear all of that, NO block is
// emitted. A one-item "gem" line padded out with the standard build IS the
// standard build with a misleading title, which is worse than no block at all.

// THRESHOLDS ARE MEASURED, NOT GUESSED. Swept live against 10 champion+role
// combinations on patch 16.13 (Viktor/Ahri mid, Lee Sin jg, Jinx bot,
// Thresh/Pyke/Lux sup, Garen/Teemo/Yasuo top). Observed pool shape: 14-17 items
// carrying a winrate, occurrence ranging 483 to ~249,000, median play count
// 8k-44k depending on champion. The settings below fire on 7 of 9 champions and
// surface genuinely off-meta picks (Banshee's Veil on Ahri, Jak'Sho on Thresh,
// Rapid Firecannon on Jinx). Loosening the margin to 1.5pp fires on 9 of 9 but
// starts admitting picks under 2pp of baseline, which is inside the noise the
// margin exists to exclude. Not every champion HAS a hidden gem, and a block
// that appears for everyone would not be one.

/** Absolute game-count floor. The smallest occurrence observed in any sampled
 *  pool was 483, so 500 keeps every real pick while still refusing a winrate
 *  computed off a handful of games on a thinly-played champion. At ~1,500 games
 *  a winrate is good to roughly ±1.3pp, comfortably inside the margin below. */
const MIN_GEM_OCCURRENCE = 500;
/** Percentage POINTS above the pool's median winrate. */
const GEM_WINRATE_MARGIN_PP = 2;
/**
 * UPPER bound, in percentage points above the median — a SELECTION-BIAS guard,
 * and the one the first version of this feature was missing.
 *
 * Caught by looking at the rendered card rather than by any unit test: Ahri's
 * top "gem" came back as **Mejai's Soulstealer at 78.5% across 8,149 games**.
 * The sample is enormous and the winrate is real, so every guard above passed.
 * It is still a terrible recommendation: Mejai's is a snowball stack you buy
 * BECAUSE you are already far ahead. Its winrate measures the games it gets
 * bought in, not the effect of buying it. Telling a user to build it is telling
 * them to buy a trophy for a game they have not won yet.
 *
 * A genuine item edge in this data sits around 2-8pp over the pool median.
 * Anything past +10pp is not an under-rated item, it is an item that only
 * appears in won games — the same reason Dark Seal and every other snowball
 * stack would rank absurdly here. Excluding the top end costs nothing real and
 * removes the whole class.
 *
 * Live on Ahri: drops Mejai's (+~26pp), keeps Banshee's Veil (+5.7),
 * Shadowflame (+4.4) and Gluttonous Greaves (+3.9).
 */
const GEM_WINRATE_CEILING_PP = 10;
/** Must be played at most this fraction of the pool's median play count. */
const GEM_PLAY_RATE_CEILING = 0.6;
/** One genuine find is worth a block. Measured: the strongest results in the
 *  sweep (Jinx's Rapid Firecannon, Thresh's Jak'Sho) are SINGLE items — a
 *  2-item minimum would have discarded exactly the picks the feature exists to
 *  surface. The block leads with the gem and fills the rest from the WPA build,
 *  which is the honest shape of "play your build, but swap this in". */
const GEM_MIN_ITEMS = 1;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Picks winning well above the pool baseline while being played well below it.
 * Exported for tests — this is the judgement call in the whole file.
 *
 * Returns them best-winrate-first, or [] when the evidence doesn't support a
 * block. Never throws; a pick with a null winrate (coachless omits it below its
 * own confidence threshold) is simply not a candidate.
 */
export function selectHiddenGemPicks(
  pool: PickType[],
  excludeIds: ReadonlySet<number>,
  meta: ReadonlyMap<number, ItemDetail>
): PickType[] {
  // One item can arrive from core, the conditioned optimizer, and a
  // situational pool with different conditioning and therefore different
  // statistics. A gem is one item, not one card per source. Keep the largest
  // sample before calculating the baseline so duplicate observations cannot
  // skew it either; ties preserve the caller's deterministic pool order.
  const byId = new Map<number, PickType>();
  for (const pick of pool) {
    const existing = byId.get(pick.id);
    if (!existing || pick.occurrence > existing.occurrence) byId.set(pick.id, pick);
  }
  // NOTE what is deliberately NOT filtered here: `Pick.lowSample`. That flag is
  // the app's own confidence guard, so excluding it looks like the obviously
  // correct thing to do — and it is exactly wrong for this block. Measured
  // 2026-07-28: with lowSample excluded, ZERO gems survive on ANY of the 10
  // sampled champions, because "flagged as low sample" and "played less than the
  // popular items" are the SAME population. The flag is relative to the
  // headline pick; this block is about items that are rare RELATIVE to that
  // headline. The absolute floor above is the honest guard, since an item with
  // 1,500+ real games has a trustworthy winrate whatever its share of the pool.
  //
  // Baseline is computed over the FULL eligible pool, BEFORE exclusions — the
  // question "is this under-played?" is about the champion's item pool as a
  // whole, not about whatever is left once the popular picks are removed. Doing
  // it after would raise the bar precisely where the popular items were taken
  // out, and quietly promote mid-tier picks into "gems".
  const eligible = Array.from(byId.values()).filter(
    (p) =>
      isFullItem(p.id, meta.get(p.id)) &&
      typeof p.winrate === "number" &&
      Number.isFinite(p.winrate) &&
      p.occurrence >= MIN_GEM_OCCURRENCE
  );
  if (eligible.length === 0) return [];

  const baselineWinrate = medianOf(eligible.map((p) => p.winrate as number));
  const medianPlay = medianOf(eligible.map((p) => p.occurrence));

  const gems = eligible.filter(
    (p) =>
      !excludeIds.has(p.id) &&
      (p.winrate as number) >= baselineWinrate + GEM_WINRATE_MARGIN_PP &&
      // Upper bound too — see GEM_WINRATE_CEILING_PP. A winrate this far above
      // the pool is a snowball item measuring won games, not a hidden edge.
      (p.winrate as number) <= baselineWinrate + GEM_WINRATE_CEILING_PP &&
      p.occurrence <= medianPlay * GEM_PLAY_RATE_CEILING
  );

  if (gems.length < GEM_MIN_ITEMS) return [];
  // Best winrate first; ties broken by the RARER item, since rarity is the other
  // axis this block is actually about.
  return gems.sort(
    (a, b) => (b.winrate as number) - (a.winrate as number) || a.occurrence - b.occurrence
  );
}

function fromPicks(picks: PickType[], ranking: ScaleRanking): Candidate[] {
  return picks.map((p) => toCandidate(p.id, ranking, { weight: p.wpa, scale: "wpa" }));
}

function fromShares(
  entries: { itemId: number; share: number }[],
  ranking: ScaleRanking
): Candidate[] {
  return entries.map((e) => toCandidate(e.itemId, ranking, { weight: e.share, scale: "share" }));
}

/** The order a consensus pool feeds `buildLine` in — and therefore, since
 *  `buildLine` preserves its primary's order, the order the shop panel shows.
 *
 *  This function is the RC-2 fix, and it is one line because the defect was
 *  one line: the pool was unconditionally `.sort((a, b) => b.share - a.share)`,
 *  so a block read left to right as a buy order was ranked by how often an item
 *  ENDED UP in the inventory. Live, Jinx Bot, patch 16.16: Infinity Edge is the
 *  most-built item (70%) and the third-bought one, behind Hexoptics C44 and
 *  Runaan's Hurricane, so the panel told an ADC to buy it first.
 *
 *  When the source declares `ordered`, its `items` are already in median
 *  purchase position and must be passed through untouched. Boots lead the array
 *  either way — `buildLine` pulls them out and reinserts at `BOOTS_LINE_INDEX`,
 *  so their position in this list is not a claim about anything.
 *
 *  When it does not, the share sort stays — it is still the best available
 *  ranking, and it is still not an order. `consensusBlockTitle` is what stops
 *  the block claiming otherwise. */
/** RC-5 (2026-08-28). The cascade below is the user's directive in code:
 *  *"frequency order is NOT an acceptable fallback anywhere a block reads as a
 *  build."* RC-2 stopped a frequency-ordered block from CALLING itself a build,
 *  which was honest and did not help — it was still a row in a shop panel, for
 *  236 of 442 pro entries and all 297 OTP entries in the committed artifact.
 *
 *  Each step is real positional evidence, ranked by how close it is to this
 *  block's own population. See lib/positionalPriors.ts for what each signal is
 *  and what it is worth; the ONLY thing decided here is precedence. */
interface ConsensusOrderContext {
  /** The other source's `orderedIds`, when it measured one. */
  crossSourceOrder?: readonly number[] | null;
  /** Modal WPA slot per item id, from this champion-role's own model. Built
   *  once per export and shared by both blocks. */
  wpaSlots?: ReadonlyMap<number, number> | null;
}

interface ConsensusOrderResult {
  /** The pool `buildLine` selects the block's six slots FROM. */
  entries: { itemId: number; share: number }[];
  prior: PositionPrior | null;
  /** RC-5b. Ranks to permute the BUILT LINE with, set for the cross-source and
   *  WPA priors and null for the other two.
   *
   *  This split is the whole content-freezing rule. Ordering the POOL changes
   *  which six items survive `buildLine`'s cut, so an out-of-sample prior that
   *  reordered the pool would silently RE-SELECT the block: measured over all
   *  551 renderable blocks, permuting the pool changed the CONTENTS of 141 of
   *  them (Urgot Top's OTP block lost Youmuu's Ghostblade, 32 of 200 one-trick
   *  games, because no slot pool of that champion-role ranks it). A prior is
   *  evidence about SEQUENCE and carries no information about which items
   *  belong in the block, so it does not get to answer that question.
   *
   *  The own-timeline prior keeps ordering the pool, and the asymmetry is the
   *  point rather than an oversight: those medians are measured on the very
   *  games that produced the shares, so reordering is within-sample and the
   *  selection it implies is a better answer than the share ranking. A
   *  cross-source or model-wide prior is out-of-sample and gets the narrower
   *  mandate. */
  lineRanks: ReadonlyMap<number, number> | null;
}

function consensusPoolOrder(
  input: ProConsensusItemsInput | null | undefined,
  entries: { itemId: number; share: number }[],
  ctx: ConsensusOrderContext = {}
): ConsensusOrderResult {
  // 1. The source measured its OWN median purchase positions. `entries` is
  //    already in that order (consensusSourceToInput reordered it), so this is
  //    the pass-through RC-2 introduced.
  if (input?.ordered) return { entries, prior: "timeline", lineRanks: null };

  // Boots are pinned to the head and never count as evidence: `buildLine`
  // lifts them out of this pool and reinserts them at BOOTS_LINE_INDEX, so
  // their place here is not a claim, and a block must not get to say it knows
  // a legendary order on the strength of a boot.
  const front = new Set((input?.boots ?? []).map((b) => b.itemId));
  // The pool the two priors below leave ALONE. Share order decides the block's
  // contents, exactly as it did before RC-5.
  const byShare = [...entries].sort((a, b) => b.share - a.share);

  // 2. The OTHER source measured one, for the SAME champion-role. Still a
  //    timeline measurement of real games of this champion in this lane.
  //
  //    `applyPositionRanks` is called here as the DECISION - does this block's
  //    own source have enough positioned items to claim an order - and its
  //    reordered output is deliberately discarded; the same ranks then permute
  //    the built line instead. Asking the question of the source's own items
  //    and applying the answer to the line is what keeps the evidence and the
  //    effect on the populations each belongs to.
  const crossSourceRanks = orderedIdRanks(ctx.crossSourceOrder);
  if (applyPositionRanks(entries, crossSourceRanks, { front })) {
    return { entries: byShare, prior: "cross-source", lineRanks: crossSourceRanks };
  }

  // 3. The champion's own WPA model, which publishes a candidate pool PER
  //    LEGENDARY SLOT with per-item occurrence. Weakest of the three because it
  //    describes the whole ranked population rather than this block's, and
  //    last for exactly that reason.
  if (ctx.wpaSlots && applyPositionRanks(entries, ctx.wpaSlots, { front })) {
    return { entries: byShare, prior: "wpa-slot", lineRanks: ctx.wpaSlots };
  }

  // 4. Residual. Share order is still the best RANKING available and it is
  //    still not an order; `consensusBlockTitle` is what stops the block
  //    claiming otherwise.
  return { entries: byShare, prior: null, lineRanks: null };
}

/** RC-5b. A built line, permuted into purchase order - and nothing else.
 *
 *  CONTENT-PRESERVING BY CONSTRUCTION, which is the whole reason the ordering
 *  moved here from the pool: this returns a permutation of the array
 *  `buildLine` produced, so the block's items are exactly the ones share order
 *  selected. It cannot promote an item into the block or drop one out of it,
 *  because it never sees a candidate that is not already in it.
 *
 *  Two consequences worth stating. The PADDING is ordered too - `buildLine`
 *  fills a short consensus line from the champion's own pools, and those items
 *  are in the row the player reads, so leaving them in fallback-priority order
 *  would put an ordered block's tail out of order (Urgot Top's Pro block is
 *  three consensus items and two padded ones). And boots go back at the index
 *  they came out of, so `BOOTS_LINE_INDEX` still owns that slot and this
 *  function has no opinion about it. */
function orderBuiltLine(
  line: Candidate[],
  ranks: ReadonlyMap<number, number> | null,
  bootsIds: ReadonlySet<number>
): Candidate[] {
  if (!ranks) return line;
  const bootsAt = line.findIndex((c) => bootsIds.has(c.id));
  const rest = bootsAt >= 0 ? line.filter((_, index) => index !== bootsAt) : line;
  // minPositioned 1: the DECISION was already taken in `consensusPoolOrder`,
  // against the source's own items. This call is the permutation, not the
  // judgement, and re-asking a two-item question of a list that also contains
  // padding would be a different question answered with the same number.
  const applied = applyPositionRanks(
    rest.map((cand) => ({ itemId: cand.id, cand })),
    ranks,
    { minPositioned: 1 }
  );
  if (!applied) return line;
  const ordered = applied.entries.map((e) => e.cand);
  if (bootsAt < 0) return ordered;
  const insertAt = Math.min(bootsAt, ordered.length);
  return [...ordered.slice(0, insertAt), line[bootsAt], ...ordered.slice(insertAt)];
}

/** The title a consensus block gets, given whether its source could measure a
 *  buy order.
 *
 *  `lib/buildSlots.ts` and `components/hextech/buildSlotView.ts` have said this
 *  in their headers since 2026-07-29 — *"nothing here knows purchase order and
 *  the render must not number the slots"* / *"NO SLOT NUMBERS, EVER"* — and the
 *  Builds page honours it: no slot numbers, and `FeaturedOtpCard`'s strip
 *  carries a "not a purchase order" caption. THE EXPORT DID NOT. The League
 *  shop panel renders a block as a left-to-right ordered row, there is no
 *  caption channel in the item-set format, and so the only lever is the title.
 *
 *  Live example, Ahri's OTP block: Malignance -> boots -> Lich Bane -> Zhonya's
 *  -> Shadowflame -> Blackfire Torch. Malignance (76%) and Blackfire (21%) are
 *  the pair `lib/buildSlots.ts` measured at LIFT 0 — never built together — and
 *  the block instructed the player to buy both, at positions 1 and 6. No
 *  ordering of frequency data can fix that; only not claiming to be an order
 *  can.
 *
 *  "most built" rather than "build": it names the measurement the block
 *  actually is, it is short enough for the client's narrow title column, and it
 *  matches the language the Pro Consensus card already uses for the same
 *  quantity. The `(same as ...)` suffix still composes on top of it. */
const CONSENSUS_UNORDERED_SUFFIX = "most built";

/** RC-5: the argument now takes the RESOLVED prior, not the source's own
 *  `ordered` flag, because there are three ways to be in purchase order and
 *  only one of them is the source's own timelines.
 *
 *  A block ordered by a cross-source or WPA-slot prior is titled a BUILD. Its
 *  contents are still that source's items — the prior permutes the block, it
 *  never re-selects it — and the row is now a real purchase sequence, which is
 *  the claim the title makes. "most built" is reserved for the residual, where
 *  no positional evidence of any kind exists and the row really is a
 *  popularity ranking; measured on the committed patch-16.16 artifact that is
 *  17 pro and 3 OTP blocks of the 551 the export can render. */
function consensusBlockTitle(source: "Pro" | "OTP", prior: PositionPrior | null): string {
  return prior ? `${source} build` : `${source} ${CONSENSUS_UNORDERED_SUFFIX}`;
}

/** Sort a candidate list best-first on the ONE legal axis. The original array
 *  index is the tiebreak, so equal scores keep the caller's order (which is
 *  itself deterministic: pool priority, then within-pool rank) instead of
 *  depending on the engine's sort being stable. */
function byScoreDesc(cands: Candidate[]): Candidate[] {
  return cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c);
}

function dedupeById(cands: Candidate[]): Candidate[] {
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const c of cands) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** v0.36.0 — true when `itemId` is a FULL, buy-order-worthy item: something
 *  a 6-item build LINE (Core/Buy order/Pro/themed) should recommend as a
 *  standalone slot. Deliberately NARROWER than proConsensus.ts's
 *  `isBuildItem` — that function ALSO treats STARTING_ITEM_ALLOWLIST
 *  entries (Dark Seal, Cull, Tear of the Goddess, Doran's items, the
 *  support starters) as "counts as a build choice," which is correct for
 *  the Pro Consensus CARD's own "what do pros keep all game" display but
 *  was never meant to license those ids into an in-game shop-panel
 *  BUY-ORDER line — exactly the live bug this rule closes (Dark Seal
 *  reached a Pro build line via `pro.items`, itself sourced from
 *  aggregateProConsensus's allowlist-inclusive isBuildItem).
 *
 *  - No metadata at all for this id -> EXCLUDE. Never assume an unknown
 *    item is finished (same "never assume, never invent" posture
 *    proConsensus.ts's own isBuildItem already applies) — Starting and
 *    Situational swaps never call this, so they're completely unaffected
 *    by an itemMeta miss; only the 6-item build lines degrade (to whatever
 *    of their own primary/fallback candidates DOES have metadata, possibly
 *    an empty line in the total-fetch-failure case — a deliberate,
 *    documented tradeoff: correctness over completeness for a line users
 *    will actually click "buy" against in the shop panel).
 *  - `purchasable === false` -> EXCLUDE.
 *  - Boots special case — lib/bootsItems.ts's `isFinalBootsItem`, THE boots
 *    rule for the whole app (2026-07-29; this file used to carry its own
 *    `tags.includes("Boots")` copy, as did proConsensus.ts and
 *    lib/otp/featuredBuild.ts, and all three were wrong about 3172 Gunmetal
 *    Greaves together). A boots item with a non-empty `from` (built from
 *    something) is a legitimate final choice even though the 2026 boots rework
 *    gives every tier-2 boot an optional tier-3 enchant `into` — "stopped at
 *    tier 2" is a normal final build state, not an unfinished component.
 *  - LANE STARTERS -> EXCLUDE, structurally (see below).
 *  - Everything else: a genuine recipe-tree leaf (`into` empty) is full.
 *
 *  THE `into`-ONLY RULE WAS NOT ENOUGH. It was documented as excluding "every
 *  STARTING_ITEM_ALLOWLIST id", which was simply false against the real
 *  catalog: 7 of those 9 ids have `into: []` and passed as genuine recipe-tree
 *  leaves. Only Dark Seal (into: Mejai's) and Tear (into: its upgrades) were
 *  ever caught here. The class was held out one layer up, by
 *  proConsensus.ts's STARTING_ITEM_ALLOWLIST partition — and that list is an
 *  ENUMERATION, which rotted: it was missing Doran's Bow (1086) and Doran's
 *  Helm (1120), so both shipped inside completed 6-item build lines in
 *  production (Ashe/Jinx/Caitlyn/Lucian/Ezreal Bot carried Doran's Bow in
 *  "Pro build"; Ornn/Darius/Malphite Top carried Doran's Helm), and
 *  ProConsensusCard rendered "Doran's Bow 43%" in its completed-items grid.
 *  That is the display the 2026-07-22 Dark Seal directive banned outright.
 *
 *  So the rule is structural now, matching how a lane starter actually looks
 *  rather than which ids someone remembered: bought from nothing
 *  (`from` empty), cheap, and carrying the catalog's own "Lane" tag. The
 *  `from.length === 0` clause is load-bearing in the other direction — the
 *  support finals (3869/3870/3871/3876/3877) are also ~400g and Lane-tagged,
 *  but they are BUILT from World Atlas, so they stay full items.
 *  The allowlist upstream stays as belt-and-braces; this is the guard that
 *  does not depend on anyone maintaining a list. */
const LANE_STARTER_MAX_GOLD = 500;

function isFullItem(
  itemId: number,
  meta: ItemDetail | undefined,
  catalog?: ItemCatalog
): boolean {
  if (!meta) return false;
  if (meta.purchasable === false) return false;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const from = Array.isArray(meta.from) ? meta.from : [];
  const into = Array.isArray(meta.into) ? meta.into : [];
  if (isFinalBootsItem(itemId, meta, catalog)) return true;
  const goldTotal = typeof meta.goldTotal === "number" ? meta.goldTotal : Number.POSITIVE_INFINITY;
  if (from.length === 0 && goldTotal <= LANE_STARTER_MAX_GOLD && tags.includes("Lane")) return false;
  return into.length === 0;
}

function fullItemsOnly(cands: Candidate[], itemMeta: ReadonlyMap<number, ItemDetail>): Candidate[] {
  return cands.filter((c) => isFullItem(c.id, itemMeta.get(c.id), itemMeta));
}

/** Best (highest-weight) boots candidate across the fallback pools, in
 *  priority order, excluding anything already used in the line — the
 *  "insert the top boots from situational/consensus" step of the spec. */
function findBestBoots(
  pools: Candidate[][],
  bootsIds: ReadonlySet<number>,
  excludeIds: ReadonlySet<number>
): Candidate | null {
  for (const pool of pools) {
    const options = pool.filter((c) => bootsIds.has(c.id) && !excludeIds.has(c.id));
    if (options.length > 0) return byScoreDesc(options)[0];
  }
  return null;
}

/** The invariant the user confirmed live: every build line is EXACTLY 6
 *  items with EXACTLY ONE pair of boots. Callers pass ALREADY full-item-
 *  filtered `primary`/`fallbackPools` (see buildItemSets) — this function
 *  itself is unaware of item metadata, same as before v0.36.0.
 *
 *  1. Dedupe `primary` by id, preserving order.
 *  2. Partition into boots vs. non-boots via `bootsIds` (see module header).
 *     - 0 boots: pull the best boots candidate from `fallbackPools`, in
 *       priority order (this is exactly what buildOptimizedSet's old
 *       unpadded `view.path` — which never carries a boots pick, since
 *       optimizedPath.ts only conditions on first/second/third — needed and
 *       never had).
 *     - >1 boots: keep only the highest-weight one (this is the exact "2
 *       boots in one line" bug — see module header).
 *  3. Pad the non-boots side to fill the remaining 5 slots from
 *     `fallbackPools`, in priority order, skipping ids already used AND
 *     skipping any boots candidate (the slot is already resolved — letting
 *     a second boots leak in through padding would silently reopen bug #1).
 *  4. Never invent: if the pools genuinely can't reach 6, ship what exists
 *     (callers/tests assert standard fixtures DO reach 6).
 *  5. Reinsert the boots pick at `BOOTS_LINE_INDEX` — see that constant. */
/**
 * Index the boots pick is reinserted at, inside the completed-item line.
 *
 * A build line is read left to right as a BUY ORDER — that is the whole reason
 * the shop panel exists — so this index is a claim about WHEN to buy boots, not
 * a layout choice. It was `3` ("after first/second/third"), which the comment
 * called "the historical convention"; it was never measured.
 *
 * MEASURED, 2026-08-27, against live prod on patch 16.16. 978 real games
 * carrying a purchase timeline, over 14 champion+role combinations covering all
 * five lanes (Aatrox/Garen Top, Lee Sin/Kha'Zix Jungle, Ahri/Zed/Syndra Mid,
 * Jinx/Ezreal/Ashe/Lucian Bot, Thresh/Lulu/Nautilus Support). Position of the
 * final boots purchase WITHIN each game's own completed-item buy order:
 *
 *     slot 1  34.9%        slot 4   4.4%   <- what this constant used to say
 *     slot 2  45.1%        slot 5+  2.0%
 *     slot 3  13.6%
 *
 * Pooled median: slot 2, mean 1.94. So `1`. The old `3` described 4.4% of real
 * games, and the distribution is not flat — 80% of games sit at slot 1 or 2, so
 * this is a peak, not a taste call between neighbouring options.
 *
 * It also removes a disagreement between two of our OWN surfaces that shipped
 * for months: the Builds page (components/ItemPath.tsx) renders the row as
 * `Start / Boots / 1st / 2nd / 3rd`, and lib/recommend.ts genuinely CONDITIONS
 * the legendary slots on boots already being owned — so the page and the model
 * both put boots ahead of the second legendary while the in-game panel put it
 * behind the third. Same champion, same response, two different buy orders.
 *
 * KNOWN LIMITATION, stated rather than hidden. JUNGLE measures later than every
 * other lane: Lee Sin median slot 3 (49% at slot 3, 31% at slot 4+), Kha'Zix
 * median slot 3 (43% / 29%) — a jungler buys the jungle item and a first
 * legendary before finishing boots. One index for every role is off by one
 * there. `buildLine` takes no role parameter today, and threading one through
 * to carry a single exception is a bigger change than this evidence supports;
 * do it off a per-role measurement, not off this note.
 */
const BOOTS_LINE_INDEX = 1;

function buildLine(
  primary: Candidate[],
  fallbackPools: Candidate[][],
  bootsIds: ReadonlySet<number>,
  lineLen: number = LINE_LEN
): Candidate[] {
  const dedup = dedupeById(primary);
  const primaryBoots = dedup.filter((c) => bootsIds.has(c.id));
  let others = dedup.filter((c) => !bootsIds.has(c.id));

  let boots: Candidate | null = primaryBoots.length > 0 ? byScoreDesc(primaryBoots)[0] : null;

  const used = new Set<number>(dedup.map((c) => c.id));

  if (!boots) {
    boots = findBestBoots(fallbackPools, bootsIds, used);
    if (boots) used.add(boots.id);
  }

  const target = lineLen - (boots ? 1 : 0);
  for (const pool of fallbackPools) {
    if (others.length >= target) break;
    for (const cand of pool) {
      if (others.length >= target) break;
      if (used.has(cand.id) || bootsIds.has(cand.id)) continue;
      used.add(cand.id);
      others.push(cand);
    }
  }
  if (others.length > target) others = others.slice(0, target);

  if (!boots) return others; // no boots anywhere in reach -- ship what exists, never invent

  const insertAt = Math.min(BOOTS_LINE_INDEX, others.length);
  return [...others.slice(0, insertAt), boots, ...others.slice(insertAt)];
}

function toItemRefs(cands: Candidate[]): ItemSetItem[] {
  return cands.map((c) => itemRef(c.id));
}

/** One id set covering every id `buildLine` must treat as boots.
 *
 *  TWO independent sources, deliberately, because each covers the other's blind
 *  spot and the one-boots-per-line invariant must not rest on either alone:
 *
 *  1. POSITIONAL — ids that arrive in a slot the contract already CALLS boots
 *     (`items.boots`, its alts, `pro.boots`, `otp.boots`). This needs no item
 *     metadata, so it still works when the ddragon fetch failed entirely, and it
 *     is what makes an upstream-declared boot recognisable even if the catalog
 *     has never heard of the id. OTP boots must be in here or buildLine cannot
 *     RECOGNISE an OTP-favoured boot and the one-boots rule silently
 *     mis-classifies it as a full item — the same class of defect the Yuumi
 *     missing-boots bug came from on the Pro line.
 *
 *  2. CLASSIFIED — every candidate id from every pool, run through
 *     lib/bootsItems.ts's `isBootsItem` (2026-07-29). Source 1 alone was NOT
 *     enough and shipped a real defect: a boot the catalog forgets to tag (3172
 *     Gunmetal Greaves) is partitioned upstream into `pro.items`/`otp.items`
 *     rather than `.boots`, so it reached this set through no positional slot at
 *     all, buildLine counted it as a full item, and a line went out holding
 *     Swiftmarch AND Gunmetal Greaves — two pairs of boots in one worn loadout.
 *
 *     Fixing the upstream partition (proConsensus.ts now shares the same rule)
 *     removes today's instance. This clause is what removes the CLASS: the
 *     invariant is now enforced here from the item data itself, so it holds even
 *     when an upstream partition is wrong, which is exactly the condition under
 *     which it shipped. Do not delete it as redundant with the upstream fix —
 *     redundancy IS the point, and "an independent second aggregation will miss
 *     the next fix" (CLAUDE.md gotcha (dd)) cuts both ways: a lone consumer
 *     trusting its producer's classification will miss the next catalog gap.
 *
 *  @param candidateIds every id that can reach a build line — pass ALL of them.
 *                      A missed id is a boot buildLine cannot see. A plain
 *                      readonly array rather than an Iterable: this file's
 *                      tsconfig target predates downlevel iteration, and the
 *                      callers all build an array anyway.
 *  @param meta         the item catalog; an empty map degrades this to source 1
 *                      plus `BOOTS_ID_EXCEPTIONS`, never to a throw. */
function collectBootsIds(
  items: ItemsBlock,
  pro: ProConsensusItemsInput | null | undefined,
  otp: ProConsensusItemsInput | null | undefined,
  candidateIds: readonly number[],
  meta: ReadonlyMap<number, ItemDetail>
): Set<number> {
  const ids = new Set<number>([items.boots.id]);
  for (const alt of items.alts?.boots ?? []) ids.add(alt.id);
  if (pro) for (const b of pro.boots) ids.add(b.itemId);
  if (otp) for (const b of otp.boots) ids.add(b.itemId);
  for (const id of candidateIds) {
    if (ids.has(id)) continue;
    if (isBootsItem(id, meta.get(id), meta)) ids.add(id);
  }
  return ids;
}

/** Champ-scoped (NOT champ+role-scoped) stale-removal prefix for the
 *  companion's /apply-itemsets `replacePrefix` field (v0.35.0, companion
 *  1.3.1+). Deliberately narrower than this module's own per-role uid/title
 *  (`CoachBuild <champ> <role>`) — user-reported: switching Senna Bot ->
 *  Support left BOTH "CoachBuild Senna Bot" and "CoachBuild Senna Support"
 *  in the client, because the companion's OWN stale-match (when
 *  `replacePrefix` is absent, e.g. an older web build) derives its prefix
 *  from the NEW set's own title, which is already role-scoped. Sending this
 *  wider, champ-only prefix explicitly means a LANE FLIP now cleans up the
 *  OTHER lane's stale set for the same champion instead of leaving it to
 *  accumulate. The trailing space is load-bearing: it's what stops
 *  "CoachBuild Vi " from ALSO matching "CoachBuild Viktor ..." — a
 *  different champion whose name happens to start with the same letters.
 *  See public/companion.ps1's Merge-ItemSets for the companion-side match
 *  (falls back to its own em-dash-derived, role-scoped prefix when this is
 *  omitted — back-compat with an older web build talking to a newer
 *  companion, or a newer web build talking to an older companion that
 *  doesn't read this field at all). */
export function champScopedReplacePrefix(champ: ChampionRef): string {
  return `CoachBuild ${champ.name} `;
}

/** The ONE set's envelope. Two invariants, both enforced elsewhere and both
 *  load-bearing:
 *
 *  1. The title must START WITH "CoachBuild". Both bridges validate exactly
 *     that (`ApplyPayloadValidation.IsCoachBuildTitle` in the desktop app,
 *     `Test-ItemSetsPayload` in companion.ps1), and it is also what makes the
 *     set OURS to prune. A set that fails it is rejected whole, and HARD RULE
 *     5 says a set that is not ours is never touched.
 *  2. It must stay inside `champScopedReplacePrefix`'s reach
 *     ("CoachBuild <champ> "), so a lane flip still cleans up the other lane's
 *     copy under companion.ps1's champion-scoped prune.
 *
 *  Both are why 0.112.0's short-lived second set was titled `CoachBuild <champ>
 *  <role> Situational` and not `CoachBuild Situational <champ> <role>` — and
 *  why, now that it is gone, the orphan it left on disk is pruned by a normal
 *  export instead of needing a bespoke cleanup path.
 *
 *  The uid and title are unchanged, byte for byte, from every version that has
 *  ever shipped — verified against a real client-written set on disk
 *  (`CoachBuild Urgot Top` / `coachbuild-urgot-top`). That is the upgrade path:
 *  an existing install's set is replaced in place rather than accumulating a
 *  second copy. */
function baseSet(champ: ChampionRef, roleLabel: string): Omit<ItemSet, "blocks"> {
  return {
    uid: `coachbuild-${slugPart(champ.name)}-${slugPart(roleLabel)}`,
    title: `CoachBuild ${champ.name} ${roleLabel}`,
    type: "custom",
    map: "any",
    mode: "any",
    associatedMaps: [],
    associatedChampions: [champ.id],
    preferredItemSlots: [],
    sortrank: 0,
  };
}

/** ONE item set per champion+role — Starting plus the four build-line
 *  BLOCKS (in-game shop-panel lines) below are all inside it, not separate
 *  sets. See module header for the "3 sets → 1 set" restructure and the
 *  2026-07-28 four-build-category cut (see the FOUR build categories note
 *  above LineFamily) that replaced the old up-to-nine-block model.
 *
 *  `itemMeta` (v0.36.0, optional — defaults to empty) is the SAME
 *  ItemDetail map components/itemDetail.ts's getItemDetailMap already
 *  resolves (itemSetsApply.ts fetches it; see that module). Powers the
 *  full-items-only filter on every 6-item build line (isFullItem). Starting
 *  never consults it — unaffected either way.
 *
 *  EVERY build-line block below is additionally subject to the cross-family
 *  de-dup (audit P1-B, dedupeLineBlocks): a block whose ITEM SET already
 *  appeared in a higher-priority block is dropped, so "the gate says emit it"
 *  is necessary but not sufficient. Keep-priority is the emission order below.
 *
 *  Block order: Starting (exempt from the 6-rule — 1-3 items) → WPA build
 *  (always — the ONE block emitted even when empty, see its push site; the
 *  optimized/situational/pro pools feed it only as PADDING, they are not
 *  their own blocks) → Pro build (only when pro-consensus data resolves,
 *  boots-deduped to the single highest-share pick) → OTP build (same shape,
 *  one-trick consensus) → Hidden gem (only when selectHiddenGemPicks finds a
 *  genuine under-played/over-performing pick) → Situational (2026-08-19; the
 *  Builds page's SITUATIONAL panel verbatim, exempt from buildLine/
 *  fullItemsOnly/dedupeLineBlocks — see SITUATIONAL_BLOCK_TYPE's note).
 *
 *  RETURNS EXACTLY ONE SET, always, in `.sets`. It briefly (web 0.112.0, 32
 *  minutes in production) returned a second standalone `CoachBuild <champ>
 *  <role> Situational` set; the user rejected it on sight and it is gone.
 *  `.sets` is still a LIST because both bridges' wire contract is a list and
 *  their merge takes the whole list — see the Situational push site for why a
 *  single, unsliced call is load-bearing either way.
 *
 *  RETURNS A RECORD, not a bare `ItemSet[]` (0.114.0). The second field,
 *  `.situational`, is the optional overlay-delta array — omitted entirely when
 *  the champion has no situational picks. It rides along on the same return
 *  rather than living in its own exported function so that it is derived from
 *  the SAME `situationalBlockPicks` call the `Situational` block is built
 *  from; see `ItemSetExport` for the full argument.
 *
 *  PADDING CASCADES, stated exactly (this doc claimed a symmetry that never
 *  existed — that both consensus lines padded from "the other consensus" —
 *  which was wrong in both directions and is the kind of drift that hid the
 *  2026-07-29 OTP defect for a release):
 *    - WPA build → optimized, situational, proPool  (`generalFallback`)
 *    - Pro build → optimized, situational, proPool, corePrimary
 *      (proPool is its own primary, so its presence in the cascade is a no-op
 *      after dedupe; otpPool has NEVER been in it)
 *    - OTP build → optimized, situational, corePrimary  (`otpFallback` —
 *      proPool deliberately absent, see that constant)
 *    - Hidden gem → corePrimary, then `generalFallback`
 *  corePrimary is last on both consensus lines because it is the only pool
 *  guaranteed to carry `items.boots`, so a champ with no `pro.boots`/`otp.boots`
 *  still gets a boots slot from the champ's own core boots. */
export function buildItemSets(
  champ: ChampionRef,
  roleLabel: string,
  build: BuildResponse,
  pro?: ProConsensusItemsInput | null,
  itemMeta?: ReadonlyMap<number, ItemDetail>,
  /** OTP (one-trick) consensus, 2026-07-28. Same shape as `pro` and equally
   *  optional — omitted/null simply means no "OTP build" block this export,
   *  never a failure. Deliberately a SEPARATE parameter rather than merged
   *  into `pro` upstream: the two are different populations with different
   *  denominators, and averaging them would produce a build nobody actually
   *  plays. */
  otp?: ProConsensusItemsInput | null,
  /** The enemy-composition plan (lib/enemyComp/forThisGame.ts), or
   *  null/undefined when the comp is incomplete or nothing fired -- the common
   *  case, which produces a byte-identical export to before this parameter
   *  existed.
   *
   *  It adds ONE block (`For this game`) and touches nothing else. Every other
   *  block, the Starting slot, the `situational` wire and the set envelope are
   *  identical with and without it, and a test asserts that byte for byte
   *  across the fixture set.
   *
   *  It replaces the `compSignal` parameter, which permuted the Situational row
   *  instead. See situational.ts for why that was removed rather than kept
   *  alongside. */
  forThisGame?: ForThisGamePlan | null
): ItemSetExport {
  const items = build.items;
  const meta = itemMeta ?? new Map<number, ItemDetail>();
  const hasPro = !!pro && (pro.items.length > 0 || pro.boots.length > 0);
  const hasOtp = !!otp && (otp.items.length > 0 || otp.boots.length > 0);

  const corePicks = [items.first, items.second, items.third, items.boots, ...items.fourthPlus];
  const optimizedView = resolveOptimizedPathView(items);
  const optimizedPicks = optimizedView.kind === "path" ? optimizedView.path : null;
  // UNFILTERED — Situational swaps deliberately allows non-full items (Dark
  // Seal etc. are exactly where they belong here).
  const situationalPicks = flattenSituational(items);
  const proEntries = hasPro ? [...pro!.boots, ...pro!.items] : [];

  // ── The TWO scale rankings (audit P1-A) ───────────────────────────────────
  // Each is built ONCE, over the ENTIRE union of sources speaking that scale,
  // so a WPA rank means the same thing whether the item surfaced in the core
  // build, the optimized path or the situational pool — and so every candidate
  // below is guaranteed to resolve against its own ranking (toCandidate's
  // fallback branch is unreachable by construction, not by luck).
  // The two rankings are NEVER merged; `Candidate.score` is what crosses
  // between them, and it is a rank position, not a weight.
  const wpaRanking = buildScaleRanking(
    "wpa",
    [...corePicks, ...(optimizedPicks ?? []), ...situationalPicks].map((p) => ({
      id: p.id,
      weight: p.wpa,
    }))
  );
  const shareRanking = buildScaleRanking(
    "share",
    proEntries.map((e) => ({ id: e.itemId, weight: e.share }))
  );
  // A SECOND, independent share ranking for OTP — not an exception to the
  // "one ranking per scale" rule above, an application of it. That rule exists
  // so a rank means the same thing everywhere it is used; pro shares and OTP
  // shares are computed over different game populations, so a single merged
  // ranking would silently compare "63% of 200 pro games" against "71% of 65
  // one-trick games" as if they were the same measurement. Each line reads
  // only its own ranking.
  const otpEntries = hasOtp ? [...otp!.boots, ...otp!.items] : [];

  // Computed HERE, not at the top of the function, because it now classifies
  // every candidate id and so must run after every candidate pool exists. The
  // union below has to be exhaustive: an id `buildLine` can reach but this set
  // never saw is a boot the one-boots invariant cannot enforce against (see
  // `collectBootsIds`). `bootsIds` is not read until the buildLine calls far
  // below, so the move is order-safe.
  const bootsIds = collectBootsIds(
    items,
    hasPro ? pro : null,
    hasOtp ? otp : null,
    [
      ...corePicks.map((p) => p.id),
      ...(optimizedPicks ?? []).map((p) => p.id),
      ...situationalPicks.map((p) => p.id),
      ...proEntries.map((e) => e.itemId),
      ...otpEntries.map((e) => e.itemId),
    ],
    meta
  );

  const otpShareRanking = buildScaleRanking(
    "share",
    otpEntries.map((e) => ({ id: e.itemId, weight: e.share }))
  );

  const corePrimary = fullItemsOnly(fromPicks(corePicks, wpaRanking), meta);
  const optimizedPrimary = optimizedPicks
    ? fullItemsOnly(fromPicks(optimizedPicks, wpaRanking), meta)
    : null;
  // FULL-FILTERED — used only as a fallback/padding pool for the 6-item
  // build lines below, never for the Situational swaps block itself.
  const situationalPoolFull = fullItemsOnly(fromPicks(situationalPicks, wpaRanking), meta);
  // RC-5. Built ONCE, from the champion's own model, and handed to both blocks
  // — the modal slot of an item does not depend on which consensus population
  // is being ordered, and two derivations of one number is how the drift this
  // file's header catalogues starts.
  const wpaSlots = wpaSlotRanks(items);
  const proOrder = consensusPoolOrder(pro, proEntries, {
    // The cross-source prior reads the OTHER source's `orderedIds`. Note that
    // it is one-directional TODAY only because `/api/otp` ships no timelines
    // at all (re-measured 2026-08-28: 0 of 111 Viktor, 0 of 200 Urgot, 0 of
    // 186 Ahri, 0 of 98 Jax); the code is symmetric, so the day that ingest
    // starts fetching timelines a thin PRO block starts being rescued too,
    // with no change here.
    crossSourceOrder: otp?.orderedIds,
    wpaSlots,
  });
  const otpOrder = consensusPoolOrder(otp, otpEntries, {
    crossSourceOrder: pro?.orderedIds,
    wpaSlots,
  });
  const proPool = fullItemsOnly(fromShares(proOrder.entries, shareRanking), meta);
  const otpPool = fullItemsOnly(fromShares(otpOrder.entries, otpShareRanking), meta);

  // General padding priority for any short line: optimized -> situational ->
  // consensus, per the spec's cascade. Buy order's OWN padding overrides this
  // with just the core remainder (see below) — it's the one line that should
  // stay "this build, reordered/filled out," not reach into situational/pro.
  const generalFallback = [optimizedPrimary ?? [], situationalPoolFull, proPool];

  // The OTP line's OWN cascade — `generalFallback` MINUS `proPool`.
  //
  // This array exists because the two are genuinely different rules and sharing
  // one array is what let them drift: the comment above the OTP push site
  // asserted for a release that `proPool` was not in that line's cascade while
  // the code passed `generalFallback`, which contains it. The claim was the
  // right rule and the code was the wrong implementation of it.
  //
  // WHAT THE RULE IS. A block's title is a claim about where its contents came
  // from — the standing rule in this file. "OTP build" claims the champion's
  // one-tricks built these items. Padding it from the PRO consensus produces a
  // line neither population plays: the one-tricks' own picks up front, pro picks
  // behind them, under a label that names only the first group. The champion's
  // own WPA pools (optimized / situational / core) are a different case and stay
  // in: they are not a rival population's build, they are the same champion's
  // own model-ranked data, which is what every other line in this set is already
  // built from.
  //
  // MEASURED DAMAGE, 2026-07-29, live prod across all 218 champion+role combos
  // holding OTP games (harness drove this exact function against /api/build +
  // /api/pros + /api/otp + the live 16.13.1 catalog):
  //   - 1,307 OTP slots emitted; 17 of them (1.3%) came from `proPool`, on 11 of
  //     218 lines (5.0%).
  //   - It is entirely a THIN-SAMPLE defect. At >=50 stored one-trick games: ZERO
  //     pro-sourced slots on 81 lines. At >=20: one line, 2 slots. Below 20
  //     stored games: 10.3% of lines affected, worst case 3 of 6 slots
  //     (Draven Mid, 1 stored game — Bloodthirster / Gunmetal Greaves / Infinity
  //     Edge all arrived from the pro feed).
  //   - The reason it is small is the cascade ORDER, not any guard: `optimized`
  //     and `situational` sit ahead of `proPool` and the situational pool carries
  //     a median of 7 full items, so it absorbs almost every shortfall first.
  //     That is luck, not design — it makes the failure rare and invisible
  //     rather than absent, and it concentrates it exactly where the OTP sample
  //     is thinnest and a false label costs the most.
  //
  // buildLine already SHIPS SHORT rather than inventing when the remaining pools
  // cannot reach six (its step 4), so removing a pool can only ever shorten a
  // line, never leave a hole — verified live: Camille Mid already emits a 5-item
  // OTP line today.
  const otpFallback = [optimizedPrimary ?? [], situationalPoolFull];

  // Every build-line block is COLLECTED first and emitted last, so the
  // cross-family de-dup (audit P1-B) can see all of them at once. Emitting
  // them inline is what made the old de-dup archetype-only: by the time it
  // ran, Core build / Buy order / Pro build / Highest WPA were already in the
  // output array as opaque {type, items} records.
  const lines: LineBlock[] = [];
  let emit = 0;
  const pushLine = (
    type: string,
    family: LineFamily,
    keep: number,
    line: Candidate[],
    /** See `LineBlock.stalePatch`. Passed only by the two consensus lines. */
    stalePatch?: string
  ) => {
    if (line.length === 0) return; // never a genuinely empty shop-panel block
    lines.push({ type, family, keep, emit: emit++, line, ...(stalePatch ? { stalePatch } : {}) });
  };

  // Core build is the ONE block emitted unconditionally, EVEN WHEN EMPTY. That
  // is not an oversight: a total itemMeta fetch failure makes every id unknown,
  // isFullItem excludes them all, and the documented degradation (see its doc
  // comment) is an empty Core build rather than a set with no build in it at
  // all — the block's presence is what tells the user the export ran and found
  // nothing, instead of silently shipping Starting + Situational.
  // Renamed from "Core build" 2026-07-28 so every block names its SOURCE (WPA
  // model / pros / one-tricks / hidden gem) instead of mixing a source-name with
  // a shape-name. Contents unchanged: still the WPA-ranked core order the Builds
  // page shows as its headline, so the in-game panel and the page agree.
  lines.push({
    type: "WPA build",
    family: "wpa",
    keep: FAMILY_KEEP_RANK.wpa,
    emit: emit++,
    line: buildLine(corePrimary, generalFallback, bootsIds),
  });

  if (hasPro) {
    // `corePrimary` LAST, and only for this line: it is the only pool carrying
    // `items.boots`, and without it a champ with no `alts.boots` and no
    // `pro.boots` leaves `findBestBoots` with nothing to find. `buildLine` then
    // takes its never-invent branch and emits SIX full items and no boots at
    // all — live on Yuumi Support, whose Pro build read Dream Maker / Ardent
    // Censer / Mikael's / Moonstone / Echoes / Staff and never told the user to
    // buy boots. Every other line for that champ carried them, because every
    // other line already reaches `corePrimary` one way or another.
    // Last in the cascade so it can supply the missing boots without
    // reordering anything the pro data actually ranked.
    // Same "never a genuinely empty block" guard as Buy order above --
    // `hasPro` only means the SOURCE pro-consensus data was non-empty, not
    // that anything survived the full-items-only filter.
    pushLine(
      consensusBlockTitle("Pro", proOrder.prior),
      "pro",
      FAMILY_KEEP_RANK.pro,
      orderBuiltLine(buildLine(proPool, [...generalFallback, corePrimary], bootsIds), proOrder.lineRanks, bootsIds),
      pro!.stalePatch
    );
  }

  if (hasOtp) {
    // `otpFallback`, NOT `generalFallback` — see that constant for why `proPool`
    // is excluded from this one line and what it measured before it was.
    //
    // `corePrimary` stays LAST for the load-bearing reason the Pro line above
    // documents: it is the only pool guaranteed to carry `items.boots`, so
    // without it a champ whose one-tricks never bought a TRACKED boot would ship
    // a six-full-item line with no boots at all (the Yuumi Support defect). That
    // is not hypothetical on this line — measured live, the boots slot is where
    // most OTP padding actually lands: every Bot-lane one-trick line with a full
    // six-item OTP pool still reaches outside it for footwear.
    pushLine(
      consensusBlockTitle("OTP", otpOrder.prior),
      "otp",
      FAMILY_KEEP_RANK.otp,
      orderBuiltLine(buildLine(otpPool, [...otpFallback, corePrimary], bootsIds), otpOrder.lineRanks, bootsIds),
      otp!.stalePatch
    );
  }

  // ── Hidden gem — the fourth and last category ─────────────────────────────
  // Candidate pool is every pick the CHAMPION's own data offers (core order,
  // optimized path, full alternatives pool) — NOT the pro/OTP pools: those are
  // consensus feeds carrying a share metric, with no winrate and no play-rate
  // baseline to be under-played relative to.
  // Excludes the WPA BUILD's ids and nothing else — deliberately narrower than
  // "everything already emitted" (2026-07-28). Two reasons, and the second is
  // the load-bearing one:
  //   1. "Not thought of by users" is about YOUR recommended build. A pro
  //      picking it up does not make it a mainstream pick for the ladder.
  //   2. The Builds PAGE renders this same block (HiddenGemCard) and has no
  //      pro/OTP data in scope at that point. Excluding pro/OTP ids here would
  //      make the shop and the page disagree about what the gem is — the exact
  //      class of inconsistency this pass exists to remove. One definition,
  //      computed from data both surfaces hold.
  const wpaLineIds = lines[0]?.line.map((c) => c.id) ?? [];
  const wpaBuildIds = new Set<number>(wpaLineIds);
  const gemPicks = selectHiddenGemPicks(
    [...corePicks, ...(optimizedPicks ?? []), ...situationalPicks],
    wpaBuildIds,
    meta
  );
  if (gemPicks.length > 0) {
    // Gems LEAD; the remaining slots fill from the champion's own WPA build,
    // because a two-item recommendation is not a build anyone can play. The
    // title claims the lead items are the find, not the whole line.
    pushLine(
      "Hidden gem",
      "gem",
      FAMILY_KEEP_RANK.gem,
      buildLine(fromPicks(gemPicks, wpaRanking), [corePrimary, ...generalFallback], bootsIds)
    );
  }

  // Resolve blocks that resolved to the same item set (pro and OTP converging
  // is the common case). Since 2026-07-29 that no longer removes a pro or OTP
  // block — both are shown, and the later one is labelled with whose build it
  // matches. Only Hidden gem is still dropped. Emission order is preserved.
  const survivors = dedupeLineBlocks(lines);

  // Starting stays a SLOT, not one of the four build categories: HARD RULE 2
  // (a starter never renders inside a completed-item list) is a standing user
  // directive, and keeping the starter in its own labelled block is the only
  // way to honour it while shipping exactly four build lines.
  // ── "For this game" (0.120.0, user directive) ────────────────────────────
  // A FIFTH build line, and the only one whose contents depend on who the
  // enemy team picked. It is the WPA line above with at most two slots swapped
  // for items chosen against the comp -- see lib/enemyComp/forThisGame.ts for
  // the decision, the spine rule and why the LAST item is what gets dropped.
  //
  // WHY IT IS NOT A LineFamily, and therefore not in `dedupeLineBlocks`. That
  // machinery answers "did two SOURCES land on the same build" -- its whole
  // premise is that pro, otp and the model are rival populations answering one
  // question. This block answers a different question, and its title is a claim
  // about an ADJUSTMENT rather than about a source, so it stays true even when
  // its items coincide with another block's. Collapsing it into Pro build
  // because they happen to match would delete the only comp-aware thing in the
  // set.
  //
  // WHY IT SITS DIRECTLY AFTER `WPA build` rather than first. It is the spine
  // plus an opinion, so reading them adjacent is what makes the opinion legible
  // -- and a JUDGMENT line never leads a MEASURED one in this app (FEATURES.md's
  // honesty posture). Starting first, then WPA build, then this, then the
  // consensus lines, then Situational.
  //
  // EMITTED ONLY WHEN IT CHANGES SOMETHING. A plan that produced no swap (every
  // candidate already in the line at its target position, or the only candidate
  // being the boot the champion already builds) yields no block, because a
  // block titled "For this game" that is byte-identical to the one above it
  // claims an adjustment that did not happen.
  const forThisGameLine =
    forThisGame && wpaLineIds.length > 0
      ? applyForThisGameLine(wpaLineIds, forThisGame, bootsIds)
      : null;
  const emitForThisGame = forThisGameLine !== null && forThisGameLine.swaps.length > 0;

  const blocks: ItemSetBlock[] = [{ type: "Starting", items: [itemRef(items.starter.id)] }];
  for (const b of survivors) {
    blocks.push({ type: blockTitle(b), items: toItemRefs(b.line) });
    if (emitForThisGame && b.family === "wpa") {
      blocks.push({
        type: FOR_THIS_GAME_BLOCK_TITLE,
        items: forThisGameLine!.ids.map((id) => itemRef(id)),
      });
    }
  }

  // ── Situational: blocks LAST, inside the ONE set ──────────────────────────
  // LAST inside the set on purpose. Everything above it is a build you could
  // play start to finish; this is a row of swaps to read after you have one.
  // Putting it above the build lines would make the first thing a user sees
  // mid-game a list of things NOT to buy yet.
  //
  // ── ONE SET. There is no second set, and there was one for 32 minutes ────
  // 0.112.0 also emitted a standalone `CoachBuild <champ> <role> Situational`
  // set. The user saw both in the shop's set dropdown and rejected it:
  // "you added it as a new set i just wanted it in the same default set from
  // coachbuild." So this returns exactly ONE set again, `apply-itemsets`
  // reports `count=1` again, and the shop has nothing to switch between.
  //
  // THE ORPHAN ON DISK CLEANS ITSELF UP, and that is not luck — it is the
  // prune both bridges already run. `ItemSetMergeService.Merge` drops EVERY
  // existing set whose title starts with "CoachBuild" before appending the
  // sets in the current write (companion.ps1's `Merge-ItemSets` does the same,
  // scoped to `champScopedReplacePrefix`, which `CoachBuild <champ> <role>
  // Situational` is inside by construction — see `baseSet`'s constraint 2,
  // which was written for exactly this suffix). So the first export after this
  // ships removes the orphaned set rather than leaving it in the user's shop
  // forever. Pinned by a test that seeds one into a copy of a real 61-set
  // ItemSets.json and asserts it is gone while all 60 foreign sets come back
  // byte-identical.
  //
  // Emitted only when there is something in it. `wpaBuildIds` (computed above
  // for the Hidden gem) is the exclusion set — deliberately the SAME set the
  // gem uses, so "already in your build" means one thing in this file and not
  // two.
  //
  // ONE CALL, TWO CONSUMERS (0.114.0). `picks` is derived HERE, once, and both
  // the shop block and the overlay wire are built from that same array. Do not
  // "tidy" this into two calls: `situationalBlockPicks` applies the WPA-build
  // exclusion, so two independent derivations can return different-LENGTH
  // lists and the overlay would paint each number over the wrong icon. The
  // pairing is asserted index-by-index by a test whose fixture makes the
  // exclusion bite.
  const picks = situationalBlockPicks(items, wpaBuildIds);
  for (const block of situationalBlocks(picks)) blocks.push(block);
  const wire = situationalWire(picks);

  // Spread rather than assigned, so the key is genuinely ABSENT (not
  // `undefined`) for a champion with no alternatives — `"situational" in body`
  // and `JSON.stringify` must both agree there is no such field. Same rule for
  // `forThisGame`: no block means no key, never `[]`.
  return {
    sets: [{ ...baseSet(champ, roleLabel), blocks }],
    ...(wire.length > 0 ? { situational: wire } : {}),
    ...(emitForThisGame ? { forThisGame: forThisGameLine!.swaps } : {}),
  };
}
