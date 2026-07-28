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
// v0.36.0 — three more user-driven changes:
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
//   3. Three THEMED lines (Highest WPA / Tanky / Burst) derived from
//      EXISTING data only (no new upstream fetch) — see buildThemedLine's
//      doc comment for the tag vocabulary (confirmed against a live
//      item.json pull, not invented) and the ≥4-qualifying-items omission
//      rule.
//
// v0.43.0 — user feedback ("add the item categories even if not with big
// sample size... create builds for each champ and item category you think
// is best"): the old binary Tanky/Burst pair is REPLACED by a fuller
// archetype vocabulary — Tank / AP/Mage / AD/Lethality / Attack Speed
// (On-hit) / Support-Utility — see CATEGORY_DEFS below. Two things changed
// from the old themed-line model:
//   1. Emission is now archetype-GATED, not just pool-size-gated — a
//      category only appears when it's SENSIBLE for the champion (a
//      lib/draft/compRatings.ts curated rating signal, e.g. tankiness>=1
//      for Tank, OR the champ's own ddragon tags from ChampionRef.tags) OR
//      the champ's real item data already shows usage of that tag (the
//      live-data escape hatch — see buildCategoryLine's doc comment). This
//      is what keeps a Yuumi from getting an AD/Lethality line just because
//      the whole roster is being swept for a build.
//   2. Thin data (fewer than MIN_THEMED_POOL real qualifying items) is no
//      longer an omission reason for a category that IS sensible — it's a
//      FILL trigger instead (buildCategoryLine's low-data path), titled
//      "<Category> (low data)" so the UI never presents a judgment fill as
//      measured. Highest WPA is UNCHANGED — still built by buildThemedLine
//      below exactly as before (byte-identical regression pin), still
//      omitted below MIN_THEMED_POOL like every pre-v0.43.0 themed line.
//
// v0.47.0 — user feedback (screenshot of a durable-AP "tank mage" Viktor:
// Rylai's/Blackfire + Sorc + Riftmaker + Abyssal + Rabadon's; "even if it
// categorically doesn't work for Viktor, still I want to see potential builds
// for 'tank mage' Viktor"): the v0.43.0 "sensible-for-champ" gate that HID
// Tank from mages was too conservative — it suppressed off-meta-but-coherent
// archetypes the user explicitly wants shown. REPLACED by a DAMAGE-FAMILY-
// scoped model (see "Damage-type-scoped archetype vocabulary" below):
//   1. A champion's damage family (AP vs AD) is inferred from their OWN
//      recommended items' damage tags (resolveDamageFamily) — the strongest
//      client-available signal (ChampionRef carries no ddragon info block;
//      real itemization beats the coarse info.attack/magic scale anyway and
//      classifies AP assassins/fighters like Fizz/Mordekaiser correctly).
//   2. EVERY archetype inside the champ's family is emitted regardless of
//      meta popularity; a cross-family one is NEVER emitted (no AD/Lethality
//      or On-hit line for an AP mage — those items don't scale with AP). The
//      correct exclusion the old gate had (no AD line for Viktor) is kept;
//      the over-conservative one (no durable-AP line for Viktor) is not.
//   3. Archetypes: AP family = AP/Mage (balanced default) / AP Burst (glass
//      cannon) / Tank Mage (durable AP — the user's screenshot). AD family =
//      Bruiser (AD) / Lethality-Assassin / Crit-Marksman / On-hit, emitted in
//      the champ's AD sub-lean. Tank (pure) = universal, actual tanks only.
//      Support/Utility is dropped (enchanters resolve to the AP family).
//      Highest WPA is UNCHANGED (buildThemedLine, byte-identical pin).
//
// v0.48.0 — user feedback (screenshot of Viktor's in-client sets): (1) "AP/Mage"
// and "AP Burst" showed the IDENTICAL 4 items — "don't duplicate, show one and
// name it appropriately, and make sure it doesn't happen for other champs"; and
// (2) the Tank Mage build "isn't a good build and it's not 6 items". Three
// changes (all in this module, no companion change → web-only ship):
//   1. Category lines are FULL 6-item builds now (CATEGORY_LINE_LEN 4 → 6) —
//      the v0.46.0 4-item cap was a payload measure the 413 stale-set prune
//      made unnecessary; item count is no longer what bounds the byte size
//      (CATEGORY_MAX_EMIT caps the NUMBER of category blocks — verified a
//      maximal 6×4 set stays well under 4096 B). buildArchetypeLine now pads
//      every data-first line to a full build.
//   2. A GENERAL de-dup (dedupeArchetypeLines) runs for EVERY champ: after all
//      archetype lines are built, near-duplicate lines collapse to one, keeping
//      the higher-priority name (ARCHETYPE_PRIORITY). Viktor's AP/Mage ==
//      AP Burst collapses to just "AP/Mage"; a champ whose builds genuinely
//      differ keeps both. Pure + unit-tested (nearDuplicateLines).
//   3. The "variant" archetypes (Tank Mage, Bruiser (AD)) are now
//      CURATED-POOL-DRIVEN, not data-first (Archetype.curated) — they exist to
//      show an off-meta durable build the champ's data does NOT reflect, so
//      they're built from a hand-ranked durable pool (Rylai's/Riftmaker/Cosmic
//      Drive/Abyssal/Zhonya's/Rod of Ages for Tank Mage), NOT the champ's
//      burst-leaning real items. That makes them coherent AND distinct from the
//      standard build so they survive de-dup. The STANDARD builds (AP/Mage,
//      Crit/Marksman, Lethality, On-hit) stay data-first. VERIFIED root cause:
//      the pre-v0.48.0 Tank Mage did NOT pull burst items (match already
//      excluded them) — it was starved (only the champ's 1-2 real durable
//      items) and capped at 4; the fix is the curated pool + 6 items.
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
//          and exactly one place in this file does it (orderByMetric, which
//          takes the scale as an explicit parameter). The nesting is
//          deliberate: `c.raw.weight` is loud enough to catch in review, where
//          the old bare `c.weight` read like a neutral ranking number.
//       2. A block whose TITLE claims a metric is now ORDERED BY THAT METRIC
//          (orderByMetric): items carrying the metric rank first, sorted by
//          it; items that do not carry it are appended as FILL and can never
//          interleave above a metric-bearing item. "Highest WPA" keeps its
//          name because it can now honestly claim it.
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
//   P1-C — A CURATED VARIANT COULD NEVER BE LABELLED, AT ANY FILL LEVEL.
//     `buildArchetypeLine` had `const lowData = arch.curated ? false : ...`.
//     Live: Ornn Top's `Bruiser (AD)` was the BRUISER_AD.pool array verbatim
//     in declaration order — zero measured items — sitting directly above
//     `On-hit (low data)`, which is equally fabricated and IS labelled. A bare
//     title next to a "(low data)" one reads as measured by implication, which
//     is HARD RULE 4 ("a curated/estimated value is always labeled as such")
//     violated in the user's client. The old code's REASONING was sound
//     though — a curated variant is a judgment build, not a thin measurement —
//     so flipping the boolean would just lie in the other direction. The fix
//     is a THIRD state driven by the real reason (see ArchetypeEvidence):
//     zero measured non-boots items -> "(suggested)"; some but below
//     MIN_CATEGORY_MEASURED -> "(low data)"; a line the champ's own data fills
//     -> plain title. It applies to CURATED and DATA-FIRST archetypes alike —
//     the label follows the evidence, not the flag. "Suggested" is not new
//     vocabulary: components/hextech/SupportItemCard.tsx already renders
//     "Suggested — <archetype> build, not measured" for exactly this case.
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
// ── Boots identification (why this is structural, not tag-based) ──────────
// The brief for this restructure pointed at proConsensus.ts's
// `isBootsTag`/`isBootsFinal` (tags-based, via ItemDetail metadata fetched
// through getItemDetailMap) as "the boots detection the codebase already
// has." That fetch is real but lives one layer up (itemSetsApply.ts /
// proConsensus.ts) and operates on ItemDetail objects — v0.34.1 shipped this
// module against `Pick` (lib/types.ts) alone, which carries no `tags` field,
// so boots detection there had to be structural (items.boots / alts.boots /
// pro.boots). v0.36.0 now ALSO threads real ItemDetail metadata in (for the
// full-item rule and themed-line tag classification — see below), so boots
// detection stays exactly as it was (structural — those three sources are
// still the authoritative "this id is boots" signal; ItemDetail's own
// "Boots" tag is used only inside isFullItem's tier-2-boots special case,
// not to re-derive the boots-id set itself).
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, BuildResponse, ItemsBlock, Pick as PickType } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";
import { getCompRating, type RatedComp } from "@/lib/draft/compRatings";
import { flattenSituational } from "./situational";
import { resolveOptimizedPathView } from "./optimizedPath";

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
}

const LINE_LEN = 6;
/** v0.48.0 — archetype CATEGORY lines are now FULL 6-item builds (5 items +
 *  1 boots), same as Core/Buy order/Pro/Highest WPA. They were capped at 4 in
 *  v0.46.0 as a payload measure; the v0.46.0 413 fix's stale-set prune (the PUT
 *  now carries only the CURRENT champ+role set, not an accumulation) freed the
 *  byte budget, and a category line truncated to 4 read as an incomplete/"bad"
 *  build (user report: the Viktor Tank Mage showed only 4 items and looked
 *  wrong). A build must be a full build — so the item count is NOT what we cap;
 *  CATEGORY_MAX_EMIT caps the NUMBER of category blocks instead, which is what
 *  actually bounds the set's byte size (verified: a maximal 6-item × 4-category
 *  set stays well under the 4096 B LCU per-object ceiling — see the byte-budget
 *  tests). The 1-boots rule is preserved. */
const CATEGORY_LINE_LEN = 6;
const SITUATIONAL_CAP = 6;
/** A themed line (Highest WPA / Tanky / Burst) is omitted entirely rather
 *  than padded with off-theme junk when fewer than this many qualifying
 *  (tag-matched, full-item) candidates exist. */
const MIN_THEMED_POOL = 4;

// ── Damage-type-scoped archetype vocabulary (v0.47.0) ───────────────────────
// Tags below are the real ddragon vocabulary, confirmed against a live
// item.json pull (coachless CDN mirror, 16.13.1) — NOT invented. There is NO
// "Lethality" tag (it's a stat); real Lethality-class items (Duskblade/
// Youmuu's/Serylda's) are tagged ArmorPenetration. "SpellBlock" (not the
// rarer "MagicResist") is the MR durability tag.

/** Damage-identifying tags — used ONLY to infer a champion's family from
 *  their own recommended items (resolveDamageFamily). AttackSpeed/OnHit count
 *  as AD (physical carries). */
const AP_DAMAGE_TAGS = new Set(["SpellDamage", "MagicPenetration"]);
const AD_DAMAGE_TAGS = new Set([
  "Damage",
  "CriticalStrike",
  "ArmorPenetration",
  "AttackSpeed",
  "OnHit",
]);
/** Durability tags — the "tank" half of a durable build (tank mage / bruiser
 *  / pure tank). */
const DURABILITY_TAGS = new Set(["Health", "Armor", "SpellBlock"]);

type DamageFamily = "AP" | "AD";

/** True iff `meta` carries the given tag. */
function metaHasTag(meta: ItemDetail | undefined, tag: string): boolean {
  return !!meta && Array.isArray(meta.tags) && meta.tags.includes(tag);
}

/** One damage-type archetype. `family` scopes it (AP/AD, or "universal" for
 *  pure Tank). `match(meta)` recognises a champ's OWN real items that embody
 *  the archetype (the MEASURED signal). `pool` is a curated list of real LoL
 *  item ids that DEFINE the archetype — the FILL source when a champ's real
 *  matched items are thin; every id is re-validated against itemMeta
 *  (isFullItem), so a wrong/legacy id degrades to the catalog-wide `match`
 *  fallback rather than surfacing garbage, and the curated list is trusted
 *  verbatim (NOT re-filtered through `match`) so a genuinely-on-archetype
 *  item whose tags don't literally satisfy the predicate — e.g. Abyssal Mask
 *  in Tank Mage, a pure-MR item with no SpellDamage tag — is still included.
 *  `fits(champTags, rating)` is the WITHIN-FAMILY sub-lean gate (AD only; AP
 *  archetypes always emit their full set; pure Tank gates on real tankiness). */
interface Archetype {
  title: string;
  family: DamageFamily | "universal";
  match: (meta: ItemDetail) => boolean;
  pool: number[];
  fits: (champTags: string[], rating: RatedComp) => boolean;
  /** v0.48.0 — CURATED-DRIVEN vs DATA-FIRST.
   *  A "variant" archetype (Tank Mage, Bruiser (AD)) exists precisely to show
   *  a coherent build the champ's META DATA does NOT reflect — the user's
   *  standing directive to surface off-meta potential builds by judgment. Its
   *  line is therefore driven by the curated `pool` (real itemization
   *  knowledge, hand-ranked), NOT by the champ's own (burst-leaning) real
   *  data — which is exactly what makes it (a) a genuinely durable/coherent
   *  build and (b) distinct from the standard build so it survives de-dup. The
   *  champ's OWN items that genuinely satisfy `match` (durable-AP items a mage
   *  actually builds) still rank first — they're both on-archetype AND
   *  measured — but the champ's off-archetype items are never pulled in
   *  (they fail `match`). A curated variant is labelled honestly as the plain
   *  archetype title (never "(low data)"): it's a deliberate judgment build,
   *  not a thin measurement.
   *  A DATA-FIRST archetype (AP/Mage, AP Burst, Crit/Marksman, Lethality,
   *  On-hit, pure Tank) reflects the champ's real meta itemization: real
   *  matched items rank first, padded to a full build from the curated pool,
   *  and it carries the measured/"(low data)" distinction. */
  curated: boolean;
}

// Curated item pools — hand-ranked best-first from real LoL itemization
// knowledge (patch ~16.13). These are FILL sources for thin-data champs; the
// primary content of every line is always the champ's own measured items, so
// a wrong/legacy id degrades gracefully (see Archetype.pool doc) — it never
// surfaces garbage, just falls through to the catalog-wide `match` fallback.
const AP_MAGE: Archetype = {
  title: "AP/Mage",
  family: "AP",
  match: (m) => hasAnyTag(m, AP_DAMAGE_TAGS),
  // Standard/balanced mage core, hand-ranked best-first: Luden's, Liandry's,
  // Shadowflame, Rabadon's, Void Staff, Zhonya's (one defensive cap). Kept
  // deliberately BURST/standard-leaning (not stacked with durable-AP items)
  // so it stays visibly distinct from the curated Tank Mage build.
  pool: [6655, 6653, 4645, 3089, 3135, 3157],
  fits: () => true,
  curated: false,
};
const AP_BURST: Archetype = {
  title: "AP Burst",
  family: "AP",
  // Glass cannon: AP damage with NO durability tag.
  match: (m) => hasAnyTag(m, AP_DAMAGE_TAGS) && !hasAnyTag(m, DURABILITY_TAGS),
  // Luden's, Shadowflame, Stormsurge, Rabadon's, Void Staff, Horizon Focus,
  // Lich Bane — pure penetration/amp burst.
  pool: [6655, 4645, 4646, 3089, 3135, 4628, 3100],
  fits: () => true,
  curated: false,
};
const TANK_MAGE: Archetype = {
  title: "Tank Mage",
  family: "AP",
  // Durable AP: an AP item that ALSO builds durability (the user's exact
  // screenshot archetype — Rylai's/Riftmaker/Abyssal + Zhonya's Viktor).
  match: (m) => metaHasTag(m, "SpellDamage") && hasAnyTag(m, DURABILITY_TAGS),
  // CURATED durable-AP build, hand-ordered durable-core -> defense -> damage
  // cap: Rod of Ages, Riftmaker, Rylai's (durable AP core) / Cosmic Drive,
  // Liandry's (durable damage) / Zhonya's, Abyssal Mask (defense) / Rabadon's
  // (damage cap). Abyssal is a pure-MR item with NO SpellDamage tag — trusted
  // verbatim (curatedArchetypePool does NOT re-filter through `match`).
  // AUDIT 2026-07-26: id was 3001, which the comment always meant as "Abyssal
  // Mask" but is really Evenshroud (purchasable:false in 16.13.1 regardless —
  // confirmed live against the real ddragon catalog). Abyssal Mask's real id
  // is 8020. isFullItem's purchasable check already kept the wrong/dead id
  // from ever surfacing in a build — it just silently shrank the pool to 7/8 —
  // see curatedArchetypePool's dead-id warn for the structural guard.
  pool: [6657, 4633, 3116, 4629, 6653, 3157, 8020, 3089],
  fits: () => true,
  curated: true,
};
const BRUISER_AD: Archetype = {
  title: "Bruiser (AD)",
  family: "AD",
  // Health + AD.
  match: (m) =>
    hasAnyTag(m, new Set(["Damage", "ArmorPenetration"])) && hasAnyTag(m, DURABILITY_TAGS),
  // CURATED durable-AD build, hand-ordered: Stridebreaker, Black Cleaver,
  // Sundered Sky (bruiser core) / Death's Dance, Sterak's Gage (defense) /
  // Titanic Hydra, Trinity Force, Hullbreaker (damage/utility). Distinct from
  // the crit/lethality data builds by construction.
  pool: [6631, 3071, 6610, 6333, 3053, 3748, 3078, 3181],
  fits: (tags) => tags.includes("Fighter"),
  curated: true,
};
const LETHALITY: Archetype = {
  title: "Lethality/Assassin",
  family: "AD",
  // Squishy burst AD: armor-pen (lethality-class) OR pure Damage with no
  // durability / attack-speed / crit (a caster-AD item, not a marksman or
  // bruiser one).
  match: (m) =>
    metaHasTag(m, "ArmorPenetration") ||
    (metaHasTag(m, "Damage") &&
      !hasAnyTag(m, DURABILITY_TAGS) &&
      !metaHasTag(m, "AttackSpeed") &&
      !metaHasTag(m, "CriticalStrike")),
  // The Collector, Eclipse, Serylda's, Youmuu's, Profane Hydra, Hubris, Edge
  // of Night, Serpent's Fang.
  // AUDIT 2026-07-26: id was 6691 (Duskblade of Draktharr) — confirmed dead,
  // purchasable:false in 16.13.1 against the real ddragon catalog (its
  // reworked successor, Opportunity/6701, is ALSO dead this patch). Swapped
  // for The Collector (6676) — same execute/burst-AD niche, purchasable,
  // already trusted verbatim elsewhere in this module (Crit/Marksman's own
  // curated pool) so sharing it across two adjacent archetypes is not new.
  pool: [6676, 6692, 6694, 3142, 6698, 6697, 3814, 6695],
  fits: (tags) => tags.includes("Assassin"),
  curated: false,
};
const CRIT_MARKSMAN: Archetype = {
  title: "Crit/Marksman",
  family: "AD",
  match: (m) => metaHasTag(m, "CriticalStrike"),
  // Infinity Edge, Rapid Firecannon, Statikk Shiv, Lord Dominik's,
  // Bloodthirster, Shieldbow, Phantom Dancer, The Collector, Mortal Reminder.
  pool: [3031, 3094, 3087, 3036, 3072, 6673, 3046, 6676, 3033],
  fits: (tags) => tags.includes("Marksman"),
  curated: false,
};
const ON_HIT: Archetype = {
  title: "On-hit",
  family: "AD",
  match: (m) => hasAnyTag(m, new Set(["AttackSpeed", "OnHit"])),
  // Blade of the Ruined King, Wit's End, Guinsoo's, Kraken Slayer, Runaan's,
  // Trinity Force.
  pool: [3153, 3091, 3124, 6672, 3085, 3078],
  fits: (tags) => tags.includes("Marksman") || tags.includes("Fighter"),
  curated: false,
};
const TANK_PURE: Archetype = {
  title: "Tank",
  family: "universal",
  // Pure durability, not primarily a damage item.
  match: (m) =>
    hasAnyTag(m, DURABILITY_TAGS) &&
    !metaHasTag(m, "SpellDamage") &&
    !hasAnyTag(m, new Set(["Damage", "CriticalStrike", "ArmorPenetration"])),
  // Sunfire, Thornmail, Randuin's, Spirit Visage, Heartsteel, Frozen Heart,
  // Warmog's Armor, Abyssal Mask.
  // AUDIT 2026-07-26: TWO ids were wrong here, both confirmed live against
  // the real 16.13.1 catalog. (1) 3193 (Gargoyle Stoneplate) is dead
  // (purchasable:false) — swapped for Warmog's Armor (3083), a live pure-HP
  // tank staple, same "not primarily a damage item" theme. (2) 3001 — same
  // Evenshroud-vs-Abyssal-Mask id mix-up as TANK_MAGE above; fixed to 8020.
  pool: [3068, 3075, 3143, 3065, 3084, 3110, 3083, 8020],
  // Actual tanks only (the v0.47.0 brief: "high tankiness rating").
  fits: (tags, rating) => tags.includes("Tank") || rating.tankiness >= 3,
  curated: false,
};

const AP_ARCHETYPES: Archetype[] = [AP_MAGE, AP_BURST, TANK_MAGE];
const AD_ARCHETYPES: Archetype[] = [BRUISER_AD, LETHALITY, CRIT_MARKSMAN, ON_HIT];

/** v0.48.0 — de-dup keep-priority (lower index = higher priority = the name
 *  KEPT when two archetype lines collapse into one). The user-reported bug:
 *  Viktor's "AP/Mage" and "AP Burst" showed the IDENTICAL item list — because
 *  both are data-first and his real items are pure burst, so both resolve to
 *  the same picks. The de-dup below detects that and emits ONE block, keeping
 *  the higher-priority name. Standard builds outrank the off-meta variants
 *  (Tank Mage, Bruiser) so that when a variant DOES accidentally overlap a
 *  standard build, the standard name survives — but a properly curated variant
 *  is distinct by construction and is never the one dropped. AP/Mage outranks
 *  AP Burst, so Viktor's collapse keeps "AP/Mage". */
const ARCHETYPE_PRIORITY: readonly string[] = [
  "Tank",
  "AP/Mage",
  "Crit/Marksman",
  "Lethality/Assassin",
  "AP Burst",
  "On-hit",
  "Tank Mage",
  "Bruiser (AD)",
];
function archetypePriority(title: string): number {
  const i = ARCHETYPE_PRIORITY.indexOf(title);
  return i < 0 ? ARCHETYPE_PRIORITY.length : i;
}

/** v0.48.0 — true when two built lines are near-duplicate BUILDS. Boots are
 *  excluded from the comparison — two genuinely different builds routinely
 *  share the champ's one boots pick, and a build is defined by its ~5 non-boots
 *  items, not its boots. Three conditions, ALL required:
 *    1. similar length (|A| - |B| <= 1) — a 3-item line and a 1-item line are
 *       different builds, not duplicates, even if one contains the other;
 *    2. they differ by at most one item within the smaller set
 *       (inter >= min-1) — catches the real bug's near-misses (AP/Mage vs
 *       AP Burst differing only in the last, differently-padded slot), not
 *       just byte-identical lines;
 *    3. they actually share something (inter >= 1) — without this a size-1
 *       set trivially satisfies `inter >= min-1 == 0` and every thin line
 *       would falsely collapse into every other (the Jinx Lethality-vs-Crit
 *       false positive).
 *  A curated variant (Tank Mage: durable AP; Bruiser: durable AD) shares at
 *  most 1-2 items with the standard build of its family, so it is never a
 *  near-duplicate; and dedupeArchetypeLines additionally never compares across
 *  curated-ness, so a variant is doubly protected from being dropped. */
function nearDuplicateLines(
  a: Candidate[],
  b: Candidate[],
  bootsIds: ReadonlySet<number>
): boolean {
  const sa = new Set(a.filter((c) => !bootsIds.has(c.id)).map((c) => c.id));
  const sb = new Set(b.filter((c) => !bootsIds.has(c.id)).map((c) => c.id));
  if (sa.size === 0 || sb.size === 0) return false;
  if (Math.abs(sa.size - sb.size) > 1) return false;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let inter = 0;
  small.forEach((id) => {
    if (large.has(id)) inter++;
  });
  return inter >= 1 && inter >= small.size - 1;
}

/** v0.48.0 — collapse near-duplicate archetype lines to one each, keeping the
 *  higher-priority name (ARCHETYPE_PRIORITY). Greedy over priority: the
 *  highest-priority survivor of any near-dup cluster is kept; lower-priority
 *  near-dups are dropped. The kept archetypes are returned in the caller's
 *  ORIGINAL emission order (block order preserved for the UI). Pure — no I/O,
 *  deterministic (priority is a total order, emission order is stable). */
function dedupeArchetypeLines<T extends { arch: Archetype; line: Candidate[] }>(
  entries: T[],
  bootsIds: ReadonlySet<number>
): T[] {
  const byPriority = [...entries].sort(
    (x, y) => archetypePriority(x.arch.title) - archetypePriority(y.arch.title)
  );
  const kept: T[] = [];
  for (const cand of byPriority) {
    // Only collapse lines of the SAME curated-ness. A curated VARIANT (Tank
    // Mage, Bruiser) is a deliberate off-meta build meant to sit ALONGSIDE the
    // standard build of its family — it must never be deduped away by a
    // standard line just because they happen to share items (e.g. a mage whose
    // AP/Mage fill reached for a durable item that also lives in Tank Mage).
    // The user-reported dup was two DATA-FIRST siblings (AP/Mage == AP Burst);
    // that's what this collapses. Variant-vs-variant can still collapse (rare).
    if (
      kept.some(
        (k) => k.arch.curated === cand.arch.curated && nearDuplicateLines(cand.line, k.line, bootsIds)
      )
    )
      continue;
    kept.push(cand);
  }
  const keptArch = new Set(kept.map((k) => k.arch));
  return entries.filter((e) => keptArch.has(e.arch));
}

// ── Cross-FAMILY de-dup (audit P1-B) ────────────────────────────────────────
// dedupeArchetypeLines above only ever compared archetype lines to each other,
// and only after Core build / Buy order / Pro build / Highest WPA had already
// been pushed — so the v0.48.0 user complaint ("don't duplicate, show one and
// name it appropriately, and make sure it doesn't happen for other champs")
// kept firing BETWEEN families, 11 times across 23 live champions. The two
// dedups are complementary and both stay: the archetype one is FUZZY (collapses
// near-misses that differ by a single padded slot, boots ignored — that is the
// Viktor AP/Mage-vs-AP-Burst case it was built for), this one is EXACT and
// spans every family.

/** Which build-line family a block belongs to. Order of declaration is the
 *  canonical EMISSION order and, for everything but the archetypes, also the
 *  keep-priority order — the block a user reads first is the one that survives
 *  a collision. Archetypes break the tie among themselves by
 *  ARCHETYPE_PRIORITY, not by emission order (unchanged from v0.48.0). */
// FOUR build categories, and only four (user directive 2026-07-28). The shop
// panel used to carry Core build + Buy order + Pro build + OTP build + Highest
// WPA + up to 4 damage-archetype categories + Situational swaps — up to nine
// blocks to triage mid-champ-select. The four that survive each answer a
// DIFFERENT question:
//
//   wpa  — what the app's own WPA model recommends (the Builds page headline)
//   pro  — what professionals actually built
//   otp  — what the champion's one-tricks actually built
//   gem  — what almost nobody builds but wins when they do (selectHiddenGemPicks)
//
// Rank order is collision priority for dedupeLineBlocks, which only collapses
// IDENTICAL item sets: when pro and otp converge the user sees one block, and
// the surviving label is the more informative one. `gem` is last on purpose —
// if the hidden gem equals a headline build it was never hidden, and the block
// should disappear rather than repeat.
//
// The archetype/themed machinery further down this file is now UNREACHABLE from
// buildItemSets (nothing calls buildThemedLine / buildArchetypeLine /
// resolveDamageFamily / selectArchetypes / curatedArchetypePool / unionPool /
// archetypeBlockTitle any more). It is left in place deliberately rather than
// ripped out in the same commit: it is ~500 lines interleaved with live helpers,
// and a line-range deletion attempt cut a live construct in half. Removing it is
// a separate mechanical pass with tsc as the oracle.
type LineFamily = "wpa" | "pro" | "otp" | "gem";

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
}

function idSetKey(line: Candidate[]): string {
  return Array.from(new Set(line.map((c) => c.id))).sort((a, b) => a - b).join(",");
}

function idOrderKey(line: Candidate[]): string {
  return line.map((c) => c.id).join(",");
}

/** Two blocks are duplicates when they carry the IDENTICAL ITEM SET,
 *  ORDER-INSENSITIVE.
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
 *  the same item set genuinely is the same recommendation twice, in any order. */
function duplicateBlocks(a: LineBlock, b: LineBlock): boolean {
  return idSetKey(a.line) === idSetKey(b.line);
}

/** Collapse duplicate build-line blocks across ALL families, keeping whichever
 *  comes first in canonical emission order. Deterministic: `keep` is a total
 *  order (family rank, then ARCHETYPE_PRIORITY within archetypes, then the
 *  emission index as a final tiebreak), and the survivors are returned in
 *  emission order so the block layout the user sees never depends on the
 *  dedup's internal traversal. */
function dedupeLineBlocks(blocks: LineBlock[]): LineBlock[] {
  const byKeep = [...blocks].sort((x, y) => x.keep - y.keep || x.emit - y.emit);
  const kept: LineBlock[] = [];
  for (const cand of byKeep) {
    if (kept.some((k) => duplicateBlocks(k, cand))) continue;
    kept.push(cand);
  }
  return kept.sort((x, y) => x.emit - y.emit);
}

/** A real per-champ matched-item count at/above which an archetype line is
 *  presented as MEASURED (no "(low data)" suffix): enough of the champ's OWN
 *  data to fill every non-boots slot, so nothing is padded in from judgment.
 *
 *  Derived from CATEGORY_LINE_LEN rather than hardcoded, because hardcoding it
 *  is what broke it. It was a literal 3, justified by a comment reading
 *  "CATEGORY_LINE_LEN is 4 (3 non-boots + 1 boots)" — true when written, but
 *  the line length was raised 4 -> 6 in v0.48.0 and this constant was not.
 *  A line then needed 5 real non-boots items, so 3 measured + 2 curated-fill
 *  cleared the bar and shipped WITHOUT the "(low data)" suffix: Yuumi Support's
 *  "AP Burst" presented Luden's Echo and Shadowflame — pure fill on an
 *  enchanter — as measured. Judgment-filled entries must be labelled; tying the
 *  threshold to the length means the next length change can't silently unlabel
 *  them again. */
const MIN_CATEGORY_MEASURED = CATEGORY_LINE_LEN - 1;

/** How much of an archetype line the CHAMPION'S OWN DATA actually paid for
 *  (audit P1-C). Three states, because two could not tell the truth:
 *
 *  - `measured`  — the champ's own matched items fill every non-boots slot.
 *                  Plain title.
 *  - `low-data`  — some measured items, but below MIN_CATEGORY_MEASURED, so
 *                  curated/catalog judgment filled the rest. "(low data)".
 *  - `suggested` — ZERO measured non-boots items. The line is the curated pool
 *                  verbatim: a build we think is coherent, not one this champ's
 *                  data shows anyone playing. "(suggested)".
 *
 *  WHY A THIRD STATE. The old rule was `arch.curated ? false : ...` — a
 *  curated variant could never be labelled at ANY fill level, so Ornn Top's
 *  100%-fabricated `Bruiser (AD)` sat bare directly above the equally
 *  fabricated `On-hit (low data)`, inviting the user to read Bruiser as the
 *  better-evidenced of the two. The signal was inverted. But flipping the flag
 *  would have been just as wrong in the other direction: the old code's
 *  reasoning ("a judgment build is not a thin measurement") is correct, it was
 *  only attached to the wrong variable. `curated` describes where the ITEMS
 *  came from; the label has to describe what the EVIDENCE is — so the label
 *  now follows the evidence for curated and data-first archetypes alike.
 *
 *  "Suggested" is the house word for exactly this, not new vocabulary:
 *  components/hextech/SupportItemCard.tsx already renders
 *  "Suggested — <archetype> build, not measured". */
type ArchetypeEvidence = "measured" | "low-data" | "suggested";

function evidenceFor(realNonBootsCount: number): ArchetypeEvidence {
  if (realNonBootsCount === 0) return "suggested";
  if (realNonBootsCount < MIN_CATEGORY_MEASURED) return "low-data";
  return "measured";
}

function archetypeBlockTitle(title: string, evidence: ArchetypeEvidence): string {
  if (evidence === "suggested") return `${title} (suggested)`;
  if (evidence === "low-data") return `${title} (low data)`;
  return title;
}

/** Worst-case block-count guard (companion side wants ~10 blocks max):
 *  Starting/Core/Buy order/Pro build/Highest WPA/Situational already account
 *  for up to 6 blocks; capping archetypes at 4 keeps the theoretical worst
 *  case at 10. AP always selects <= 4 (pure Tank + 3 AP archetypes); only an
 *  AD champ with no sub-lean tags (full AD spread) plus a pure-Tank gate can
 *  reach 5. When more than 4 are selected, keep pure Tank plus the family
 *  archetypes with the MOST real per-champ data; declaration order preserved
 *  for the survivors. */
const CATEGORY_MAX_EMIT = 4;

function slugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "x";
}

function itemRef(id: number, count = 1): ItemSetItem {
  return { id: String(id), count };
}

// ── Candidate: the one shape `buildLine`/themed-line construction operate
// on ───────────────────────────────────────────────────────────────────────
// Unifies Pick (wpa-ranked — Core/Optimized/Situational's native shape),
// pro-consensus entries (share-ranked) and the curated/catalog fill pools
// (gold-ranked) behind one type, so the dedup/boots-fix/padding/ranking logic
// below is written ONCE, not once per pool type.
//
// THE INVARIANT THIS TYPE EXISTS TO ENFORCE (audit P1-A, see header):
//   `score` is the ONLY ranking axis. `raw.weight` is PROVENANCE and must
//   never be compared against another candidate's unless `raw.scale` is
//   identical — because -3.94 (a real live WPA) and 0.67 (a real live pro
//   share) are not two points on one number line, and the module spent three
//   releases pretending they were.
//   Exactly ONE function in this file compares raw weights (orderByMetric),
//   and it takes the scale as an explicit parameter so the comparison is
//   provably within-scale. Everything else — unionPool, buildLine,
//   findBestBoots, buildThemedLine, buildArchetypeLine — sorts on `score`.

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
// And a fourth, structural: anything already emitted in the WPA / Pro / OTP
// lines is excluded outright. If a "hidden" pick is what pros build, it is not
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
  const eligible = pool.filter(
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

/** Score an ALREADY-ORDERED gold-scale fill pool by its position. The curated
 *  archetype pools are hand-ranked best-first (the declaration order IS the
 *  ranking, not the gold cost), and categoryDefaultPool sorts by gold before
 *  calling this — either way the array order is the intended ranking, so the
 *  score is derived from it directly. */
function scoreByPosition(entries: { id: number; goldTotal: number }[]): Candidate[] {
  return entries.map((e, i) => ({
    id: e.id,
    score: 1 / (1 + i),
    raw: { weight: e.goldTotal, scale: "gold" as const },
  }));
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
 *  - Boots special case (mirrors proConsensus.ts's isBootsFinal exactly):
 *    a Boots-tagged item with a non-empty `from` (built from something) is
 *    a legitimate final choice even though the 2026 boots rework gives
 *    every tier-2 boot an optional tier-3 enchant `into` — "stopped at
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

function isFullItem(itemId: number, meta: ItemDetail | undefined): boolean {
  if (!meta) return false;
  if (meta.purchasable === false) return false;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const from = Array.isArray(meta.from) ? meta.from : [];
  const into = Array.isArray(meta.into) ? meta.into : [];
  if (tags.includes("Boots") && from.length > 0) return true;
  const goldTotal = typeof meta.goldTotal === "number" ? meta.goldTotal : Number.POSITIVE_INFINITY;
  if (from.length === 0 && goldTotal <= LANE_STARTER_MAX_GOLD && tags.includes("Lane")) return false;
  return into.length === 0;
}

function fullItemsOnly(cands: Candidate[], itemMeta: ReadonlyMap<number, ItemDetail>): Candidate[] {
  return cands.filter((c) => isFullItem(c.id, itemMeta.get(c.id)));
}

function hasAnyTag(meta: ItemDetail | undefined, tagSet: ReadonlySet<string>): boolean {
  if (!meta) return false;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  return tags.some((t) => tagSet.has(t));
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
 *  5. Reinsert the boots pick after the first 3 non-boots items — mirrors
 *     the historical first/second/third → boots → rest convention rather
 *     than always trailing it. */
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

  const insertAt = Math.min(3, others.length);
  return [...others.slice(0, insertAt), boots, ...others.slice(insertAt)];
}

/** Best-RANK-wins union of several already full-item-filtered pools, deduped
 *  by id — the shared candidate pool every themed/archetype line ranks within.
 *  Keeping the best evidence an id has across sources is the original,
 *  correct intent; what was wrong (audit P1-A) is that it used to compare RAW
 *  weights, so a 0.67 pro share lost to a 2.11 WPA and a 0.9 pro share beat a
 *  0.4 WPA — comparisons with no meaning. It now compares `score`, the
 *  reciprocal rank WITHIN each id's own scale, which is commensurable.
 *
 *  Ties keep the EARLIER pool's candidate (strict `>`), and callers pass pools
 *  in a fixed priority order, so the union is deterministic. Note that an id
 *  present in two scales keeps whichever scale ranked it better — which is why
 *  a metric-claiming block must resolve its metric from the scale's own
 *  ranking table (orderByMetric) and not from the winning candidate's `raw`. */
function unionPool(...pools: Candidate[][]): Candidate[] {
  const best = new Map<number, Candidate>();
  for (const pool of pools) {
    for (const c of pool) {
      const existing = best.get(c.id);
      if (!existing || c.score > existing.score) best.set(c.id, c);
    }
  }
  return Array.from(best.values());
}

/** A metric a block's TITLE claims. `valueOf` returns the metric's raw value
 *  for an id, or undefined when the item simply does not carry that metric
 *  (e.g. a pro-consensus-only item has no WPA — the champ's own build data
 *  never scored it). `scale` is what makes the raw comparison below legal:
 *  every value `valueOf` returns lives on that one number line. */
interface MetricLens {
  scale: WeightScale;
  valueOf: (id: number) => number | undefined;
}

/** Order a pool for a block whose title CLAIMS a metric (audit P1-A).
 *
 *  Rule: items carrying the metric come FIRST, ordered by it; items lacking it
 *  are appended as FILL and may NEVER interleave above a metric-bearing item.
 *  Before this existed, "Highest WPA" ranked on the mixed weight axis, so a
 *  pro-consensus item with no measured WPA at all could sit 3rd in a block
 *  whose name is a claim about WPA ordering. A block that silently means
 *  something other than its own title is a lie the user has no way to detect,
 *  which is the class this closes.
 *
 *  The `b.v - a.v` comparison is the ONE raw-weight comparison in this file,
 *  and it is safe because every value came from the same `metric.scale`. */
function orderByMetric(pool: Candidate[], metric: MetricLens): Candidate[] {
  const bearing: { c: Candidate; v: number; i: number }[] = [];
  const fill: { c: Candidate; i: number }[] = [];
  pool.forEach((c, i) => {
    const v = metric.valueOf(c.id);
    if (v === undefined) fill.push({ c, i });
    else bearing.push({ c, v, i });
  });
  bearing.sort((a, b) => b.v - a.v || a.i - b.i);
  fill.sort((a, b) => b.c.score - a.c.score || a.i - b.i);
  return [...bearing.map((x) => x.c), ...fill.map((x) => x.c)];
}

/** v0.36.0 — the "Highest WPA" line. `pool` is already full-item-filtered
 *  (buildItemSets's themedUnion). Omitted entirely (returns null) below
 *  MIN_THEMED_POOL candidates rather than padded with judgment fill.
 *
 *  Audit P1-A: the ordering now goes through `orderByMetric`, so the block
 *  genuinely IS ordered by the metric its title names — measured WPA first in
 *  descending order, then any pro-consensus-only item as trailing FILL. The
 *  boots pick is likewise the highest-WPA boots rather than the highest raw
 *  mixed weight.
 *
 *  The one thing the title does NOT claim is the boots SLOT position: boots is
 *  reinserted after the first 3 items by the same layout convention every
 *  other line in this module uses (see buildLine step 5) — that is a shop-panel
 *  reading order, not a ranking statement, and the boots chosen is still the
 *  metric's own best. */
function buildThemedLine(
  pool: Candidate[],
  metric: MetricLens,
  bootsIds: ReadonlySet<number>
): Candidate[] | null {
  if (pool.length < MIN_THEMED_POOL) return null;

  const ordered = orderByMetric(pool, metric);
  const nonBoots = ordered.filter((c) => !bootsIds.has(c.id));
  const boots = ordered.find((c) => bootsIds.has(c.id)) ?? null;

  const target = LINE_LEN - (boots ? 1 : 0);
  const top = nonBoots.slice(0, target);
  if (!boots) return top;

  const insertAt = Math.min(3, top.length);
  return [...top.slice(0, insertAt), boots, ...top.slice(insertAt)];
}

/** v0.47.0 — catalog-wide (NOT champ-scoped) full-item pool matching an
 *  archetype's own `match` predicate, ranked by total gold cost: a cheap,
 *  honest "this is a real, substantial item" proxy, deliberately NOT a claim
 *  of measured performance (the "(low data)" title suffix is what keeps this
 *  honest — see buildArchetypeLine). Last-resort fill when a champ has thin
 *  real data AND the curated pool didn't resolve. */
function categoryDefaultPool(
  itemMeta: ReadonlyMap<number, ItemDetail>,
  match: (meta: ItemDetail) => boolean
): Candidate[] {
  const out: { id: number; goldTotal: number }[] = [];
  itemMeta.forEach((m, id) => {
    if (!isFullItem(id, m)) return;
    // A fill pool only ever supplies NON-BOOTS padding slots (the one-boots
    // machinery resolves the boots slot separately, from the champ's own
    // pool). A boots-tagged item must never leak in here — e.g. Mercury's
    // Treads / Plated Steelcaps carry a durability tag and would otherwise
    // match the pure-Tank archetype and pad in as a SECOND pair of boots
    // (the champ's recommended boots isn't the catalog's boots), reopening
    // the "2 boots in one line" bug on a line whose bootsIds set (the
    // recommended boots only) doesn't know this catalog boot is boots.
    if (metaHasTag(m, "Boots")) return;
    if (!match(m)) return;
    out.push({ id, goldTotal: m.goldTotal });
  });
  // Gold desc IS this pool's ranking (see doc above); the id tiebreak keeps a
  // catalog sweep deterministic across Map-iteration orders.
  out.sort((a, b) => b.goldTotal - a.goldTotal || a.id - b.id);
  return scoreByPosition(out);
}

/** AUDIT 2026-07-26 — a curated pool id going dead (purchasable:false in a
 *  later patch) used to fail completely silently: isFullItem already
 *  excludes it (see its own `meta.purchasable === false` check), so the pool
 *  just quietly shrank by one — exactly how ids 3001/6691/3193 rotted in
 *  16.13.1 without anyone noticing until a live audit compared them by hand
 *  against the real ddragon catalog. A hardcoded id LIST is what rotted here
 *  (the lesson recorded 2026-07-25 for isFullItem's starter partition); the
 *  structural fix is to check the catalog's own `purchasable` field and warn
 *  on the class, not just patch the three known instances. Dedupes per
 *  process (a warm lambda serving many requests only warns once per id) —
 *  this is a loud dev/ops signal, not a per-request budget concern. Absence
 *  from the map entirely is NOT warned here — that's the ordinary
 *  not-yet-loaded/version-mismatch case every other lookup in this module
 *  already tolerates silently, not evidence of a dead id. */
const warnedDeadCuratedIds = new Set<number>();

/** v0.47.0 — the curated archetype pool resolved against real item metadata:
 *  full items only, hand-ranked order preserved (best-first by construction,
 *  which IS "ranked by quality + tag fit"). Trusted verbatim: NOT re-filtered
 *  through the archetype's `match` predicate, so an on-archetype item whose
 *  tags don't literally satisfy the predicate (Abyssal Mask in Tank Mage) is
 *  kept. A wrong/legacy id absent from itemMeta simply drops out. */
function curatedArchetypePool(
  arch: Archetype,
  itemMeta: ReadonlyMap<number, ItemDetail>
): Candidate[] {
  const out: { id: number; goldTotal: number }[] = [];
  for (const id of arch.pool) {
    const m = itemMeta.get(id);
    if (m && m.purchasable === false && !warnedDeadCuratedIds.has(id)) {
      warnedDeadCuratedIds.add(id);
      console.warn(
        `[itemSetBody] curated pool id ${id} ("${m.name}") in archetype "${arch.title}" is purchasable:false in the current catalog — the pool has silently shrunk by one. Replace it.`
      );
    }
    if (!m || !isFullItem(id, m)) continue;
    if (metaHasTag(m, "Boots")) continue; // fill pools never supply boots (see categoryDefaultPool)
    out.push({ id, goldTotal: m.goldTotal });
  }
  // Hand-ranked declaration order IS the ranking here — scored by POSITION, not
  // by gold, so a cheap-but-core item (Black Cleaver) is never demoted beneath
  // an expensive late one just because it costs less.
  return scoreByPosition(out);
}

/** v0.47.0 — infer a champion's damage FAMILY. Primary signal: the champ's
 *  OWN recommended full items' damage tags (the strongest client-available
 *  signal — it reflects real itemization, so it classifies AP assassins/
 *  fighters like Fizz/Mordekaiser correctly where their ddragon class tag
 *  would not). Tie / no damage-tagged items -> ddragon class tags (Mage/
 *  Support -> AP; Marksman/Assassin/Fighter -> AD). Last resort -> AP (a
 *  tag-less, damage-item-less champ is almost always a utility/enchanter or
 *  tank, AP-family).
 *
 *  NOTE (the v0.47.0 brief asked to "prefer info.magic>info.attack"): ddragon's
 *  info block is SERVER-ONLY (lib/staticData.ts getChampionMeta) and NOT on
 *  ChampionRef's wire contract, so it isn't available in this pure client
 *  module without new API plumbing. The real-item signal used here is strictly
 *  BETTER for this purpose than the coarse 1-10 info scale (info misclassifies
 *  hybrid champs; actual recommended items do not), so no info plumbing was
 *  added — see HANDOFF-engy for the tradeoff.
 *
 *  `confident` is true when the family came from real damage items OR a
 *  damage class tag (Mage/Support/Marksman/Assassin/Fighter) — a genuine
 *  signal that the champ deals that damage type. It's false ONLY for the
 *  last-resort default (a champ with no damage items AND no damage class tag —
 *  a pure tank/utility champ), which lets buildItemSets suppress catalog-fill
 *  damage archetypes it can't stand behind (a pure tank should get its Tank
 *  line, not a nonsensical "AP/Mage (low data)"). */
function resolveDamageFamily(
  champ: ChampionRef,
  realFullItems: Candidate[],
  itemMeta: ReadonlyMap<number, ItemDetail>
): { family: DamageFamily; confident: boolean } {
  let ap = 0;
  let ad = 0;
  for (const c of realFullItems) {
    const m = itemMeta.get(c.id);
    if (!m) continue;
    if (hasAnyTag(m, AP_DAMAGE_TAGS)) ap++;
    if (hasAnyTag(m, AD_DAMAGE_TAGS)) ad++;
  }
  // Audit follow-up (2026-07-26) — a bare ap!==ad tie-break let a SINGLE
  // incidentally-tagged item decide the whole family. Live repro: Leona/Braum/
  // Nautilus/Rell (real ddragon tags ["Tank","Support"]) all landed at
  // ap=0/ad=1 or ap=1/ad=0 -- one item each, e.g. the support Artifact item
  // Bandlepipes (id 2524), which is a generic durability item every support
  // can pick regardless of the champion's own damage type, but carries an
  // incidental "AttackSpeed" stat tag -- enough to satisfy AD_DAMAGE_TAGS and
  // (because ap!==ad was the ONLY gate) claim `confident: true`, skipping the
  // tag-based fallback that would have correctly read "Support" -> AP.
  // FAMILY_TALLY_MARGIN requires the item signal to be a real majority (>=2
  // more matched items on one side) before it overrides the champion's own
  // ddragon class tags. Verified live across 27 champions (8 supports named
  // in the brief + Rell/Rakan/Thresh/Pyke/Senna/Karma/Sona + AD/AP controls +
  // 5 non-support tanks): every genuine AD/AP carry (Draven ad=15, Ahri
  // ap=14, Pyke ad=10, Senna ad=10 vs ap=2) clears this margin by a wide
  // margin untouched; every single-item false positive (Leona, Braum,
  // Nautilus, Rell, all margin=1) now falls through to the tag branch below
  // and resolves correctly. A margin of exactly 2 (Shen: ad=3/ap=1) is left
  // item-driven, unchanged from today -- outside the briefed scope and not
  // demonstrated wrong.
  const FAMILY_TALLY_MARGIN = 2;
  if (Math.abs(ap - ad) >= FAMILY_TALLY_MARGIN) {
    return { family: ap > ad ? "AP" : "AD", confident: true };
  }
  const tags = champ.tags ?? [];
  if (tags.includes("Mage") || tags.includes("Support")) return { family: "AP", confident: true };
  if (tags.includes("Marksman") || tags.includes("Assassin") || tags.includes("Fighter")) {
    return { family: "AD", confident: true };
  }
  return { family: "AP", confident: false };
}

/** v0.47.0 — the ordered archetypes to emit for a champion: pure Tank (if an
 *  ACTUAL tank) + the champ's damage family. AP always emits its full
 *  3-archetype set (AP/Mage, AP Burst, Tank Mage); AD emits the sub-lean
 *  archetypes its class tags fit, falling back to the full AD spread when a
 *  champ has no AD sub-lean tag (e.g. resolved to AD purely via its items).
 *  A cross-family archetype is NEVER included — the core of the redesign. */
function selectArchetypes(
  family: DamageFamily,
  champTags: string[],
  rating: RatedComp
): Archetype[] {
  const out: Archetype[] = [];
  if (TANK_PURE.fits(champTags, rating)) out.push(TANK_PURE);
  if (family === "AP") {
    out.push(...AP_ARCHETYPES);
  } else {
    const subs = AD_ARCHETYPES.filter((a) => a.fits(champTags, rating));
    out.push(...(subs.length > 0 ? subs : AD_ARCHETYPES));
  }
  return out;
}

/** v0.48.0 — build one archetype line as a FULL 6-item build (5 items + 1
 *  boots), through the same one-boots / isFullItem machinery every other line
 *  uses. Two modes (see Archetype.curated):
 *
 *  DATA-FIRST (AP/Mage, AP Burst, Crit/Marksman, Lethality, On-hit, pure Tank):
 *  the champ's OWN matched items rank first, then the line is PADDED to a full
 *  build from the curated pool, then catalog `match` defaults.
 *
 *  CURATED-DRIVEN (Tank Mage, Bruiser (AD)): the build is defined by the
 *  curated pool, NOT the champ's (off-archetype) real data. The champ's own
 *  items that genuinely satisfy `match` (durable-AP items a mage actually
 *  builds) still rank first — on-archetype AND measured — but his
 *  off-archetype burst items are never pulled in (they fail `match`), and the
 *  curated pool defines the rest of a coherent, ordered durable build.
 *
 *  Either way the champ's own real boots are folded in so a line never strands
 *  itself boots-less, and a line that resolves to boots-only (no archetype
 *  content anywhere in reach) returns empty so buildItemSets omits the block.
 *
 *  Audit P1-C: the honesty label is now THREE-state and is computed the SAME
 *  WAY for curated and data-first archetypes — see ArchetypeEvidence. */
function buildArchetypeLine(
  pool: Candidate[],
  arch: Archetype,
  itemMeta: ReadonlyMap<number, ItemDetail>,
  bootsIds: ReadonlySet<number>
): { line: Candidate[]; evidence: ArchetypeEvidence } {
  const realMatched = byScoreDesc(
    pool.filter((c) => {
      const m = itemMeta.get(c.id);
      return m ? arch.match(m) : false;
    })
  );
  const realNonBoots = realMatched.filter((c) => !bootsIds.has(c.id));
  const hasRealBoots = realMatched.some((c) => bootsIds.has(c.id));
  const overallBoots = byScoreDesc(pool.filter((c) => bootsIds.has(c.id)))[0] ?? null;

  const curatedFill = curatedArchetypePool(arch, itemMeta);
  const catalogFill = categoryDefaultPool(itemMeta, arch.match);

  // Primary = the champ's real matched (on-archetype) items, weight-ranked,
  // plus his own boots when the matched set had none — identical for both
  // modes (a curated variant still leads with the champ's genuine durable
  // items). The curated pool then completes the build for a variant, or pads a
  // short standard line to a full 6.
  const primary = overallBoots && !hasRealBoots ? [...realMatched, overallBoots] : realMatched;
  const line = buildLine(primary, [curatedFill, catalogFill], bootsIds, CATEGORY_LINE_LEN);
  if (line.filter((c) => !bootsIds.has(c.id)).length === 0)
    return { line: [], evidence: "measured" };

  return { line, evidence: evidenceFor(realNonBoots.length) };
}

function toItemRefs(cands: Candidate[]): ItemSetItem[] {
  return cands.map((c) => itemRef(c.id));
}

/** One id set covering every position the contract already knows is
 *  "boots" — see module header for why this is structural, not tag-based. */
function collectBootsIds(
  items: ItemsBlock,
  pro?: ProConsensusItemsInput | null,
  otp?: ProConsensusItemsInput | null
): Set<number> {
  const ids = new Set<number>([items.boots.id]);
  for (const alt of items.alts?.boots ?? []) ids.add(alt.id);
  if (pro) for (const b of pro.boots) ids.add(b.itemId);
  // OTP boots must be in this set too, or buildLine cannot RECOGNISE an
  // OTP-favoured boot as boots and the one-boots rule silently mis-classifies
  // it as a full item — the same class of defect the Yuumi missing-boots bug
  // came from on the Pro line.
  if (otp) for (const b of otp.boots) ids.add(b.itemId);
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

/** ONE item set per champion+role — Core/Buy order/Pro/themed/Situational
 *  are all BLOCKS (in-game shop-panel lines) inside it, not separate sets.
 *  See module header for the "3 sets → 1 set" restructure and the v0.36.0
 *  full-item / rename / themed-lines follow-up.
 *
 *  `itemMeta` (v0.36.0, optional — defaults to empty) is the SAME
 *  ItemDetail map components/itemDetail.ts's getItemDetailMap already
 *  resolves (itemSetsApply.ts fetches it; see that module). Powers TWO
 *  things: (1) the full-items-only filter on every 6-item build line
 *  (isFullItem), (2) themed-line tag classification (hasAnyTag). Starting
 *  and Situational swaps never consult it — unaffected either way.
 *
 *  EVERY build-line block below is additionally subject to the cross-family
 *  de-dup (audit P1-B, dedupeLineBlocks): a block whose ITEM SET already
 *  appeared in a higher-priority block is dropped, so "the gate says emit it"
 *  is necessary but not sufficient. Keep-priority is the emission order below;
 *  the Core build / Buy order pair is the one order-SENSITIVE comparison.
 *
 *  Block order: Starting (exempt from the 6-rule — 1-3 items) → Core build
 *  (always — the ONE block emitted even when empty, see its push site) → Buy
 *  order (only when
 *  resolveOptimizedPathView says it genuinely differs from Core — same rule
 *  the old buildOptimizedSet used — padded to 6 with the CORE remainder
 *  specifically, so it reads as "same build, refined order" rather than
 *  pulling in situational/pro noise) → Pro build (only when pro-consensus
 *  data resolves, boots-deduped to the single highest-share pick, padded
 *  via the general optimized→situational→consensus cascade) → Highest WPA
 *  (only when the whole pool has ≥4 qualifying full items — see
 *  buildThemedLine; ORDERED BY WPA since the audit, so the title is a
 *  checkable claim) → up to CATEGORY_MAX_EMIT damage-type archetypes
 *  (v0.47.0 — family-scoped: pure Tank if an actual tank, then the champ's AP
 *  set [AP/Mage, AP Burst, Tank Mage] or AD set [Bruiser (AD),
 *  Lethality/Assassin, Crit/Marksman, On-hit]; never a cross-family line; thin
 *  data fills via buildArchetypeLine and gets a "(low data)" or "(suggested)"
 *  title suffix instead of being dropped — see ArchetypeEvidence)
 *  → Situational swaps
 *  (the alternates pool, cap 6, exempt
 *  from BOTH the one-boots rule AND the full-items rule — these are swap
 *  SUGGESTIONS, not a worn loadout, so a stacking item or several boots
 *  options side by side is the intended shape, not a bug). */
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
  otp?: ProConsensusItemsInput | null
): ItemSet[] {
  const items = build.items;
  const meta = itemMeta ?? new Map<number, ItemDetail>();
  const hasPro = !!pro && (pro.items.length > 0 || pro.boots.length > 0);
  const hasOtp = !!otp && (otp.items.length > 0 || otp.boots.length > 0);
  const bootsIds = collectBootsIds(items, hasPro ? pro : null, hasOtp ? otp : null);

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
  const proPool = fullItemsOnly(
    fromShares([...proEntries].sort((a, b) => b.share - a.share), shareRanking),
    meta
  );
  const otpPool = fullItemsOnly(
    fromShares([...otpEntries].sort((a, b) => b.share - a.share), otpShareRanking),
    meta
  );

  // General padding priority for any short line: optimized -> situational ->
  // consensus, per the spec's cascade. Buy order's OWN padding overrides this
  // with just the core remainder (see below) — it's the one line that should
  // stay "this build, reordered/filled out," not reach into situational/pro.
  const generalFallback = [optimizedPrimary ?? [], situationalPoolFull, proPool];

  // Every build-line block is COLLECTED first and emitted last, so the
  // cross-family de-dup (audit P1-B) can see all of them at once. Emitting
  // them inline is what made the old de-dup archetype-only: by the time it
  // ran, Core build / Buy order / Pro build / Highest WPA were already in the
  // output array as opaque {type, items} records.
  const lines: LineBlock[] = [];
  let emit = 0;
  const pushLine = (type: string, family: LineFamily, keep: number, line: Candidate[]) => {
    if (line.length === 0) return; // never a genuinely empty shop-panel block
    lines.push({ type, family, keep, emit: emit++, line });
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
    pushLine("Pro build", "pro", FAMILY_KEEP_RANK.pro, buildLine(proPool, [...generalFallback, corePrimary], bootsIds));
  }

  if (hasOtp) {
    // Same cascade shape as the Pro line above, and `corePrimary` last for the
    // same load-bearing reason: it is the only pool guaranteed to carry
    // `items.boots`, so without it a champ whose one-tricks never bought a
    // tracked boot would ship a six-full-item line with no boots at all (the
    // Yuumi Support defect). `proPool` is NOT in this cascade — padding an OTP
    // line with pro items would produce a build neither group actually plays,
    // and the block's label would then be a false claim about its own contents.
    pushLine("OTP build", "otp", FAMILY_KEEP_RANK.otp, buildLine(otpPool, [...generalFallback, corePrimary], bootsIds));
  }

  // ── Hidden gem — the fourth and last category ─────────────────────────────
  // Candidate pool is every pick the CHAMPION's own data offers (core order,
  // optimized path, full alternatives pool) — NOT the pro/OTP pools: those are
  // consensus feeds carrying a share metric, with no winrate and no play-rate
  // baseline to be under-played relative to.
  const emittedIds = new Set<number>();
  for (const l of lines) for (const c of l.line) emittedIds.add(c.id);
  const gemPicks = selectHiddenGemPicks(
    [...corePicks, ...(optimizedPicks ?? []), ...situationalPicks],
    emittedIds,
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

  // Collapse any two blocks that resolved to the IDENTICAL item set (pro and
  // OTP converging is the common case). Emission order is preserved.
  const survivors = dedupeLineBlocks(lines);

  // Starting stays a SLOT, not one of the four build categories: HARD RULE 2
  // (a starter never renders inside a completed-item list) is a standing user
  // directive, and keeping the starter in its own labelled block is the only
  // way to honour it while shipping exactly four build lines.
  const blocks: ItemSetBlock[] = [{ type: "Starting", items: [itemRef(items.starter.id)] }];
  for (const b of survivors) blocks.push({ type: b.type, items: toItemRefs(b.line) });

  return [{ ...baseSet(champ, roleLabel), blocks }];
}
