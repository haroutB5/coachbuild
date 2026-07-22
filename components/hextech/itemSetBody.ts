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
 *  tags-based check — see this module's header for why that matters. Note
 *  `items`/`boots` are ALLOWLIST-INCLUSIVE (proConsensus.ts's
 *  STARTING_ITEM_ALLOWLIST) — this module's own `isFullItem` re-filters
 *  before anything reaches a build LINE; see the v0.36.0 header note. */
export interface ProConsensusItemsInput {
  items: { itemId: number; share: number }[];
  boots: { itemId: number; share: number }[];
}

const LINE_LEN = 6;
/** v0.46.0 (413 payload fix, lever 2) — the archetype CATEGORY lines
 *  (Tank / AP/Mage / AD/Lethality / Attack Speed / Support-Utility) are
 *  capped SHORTER than the primary build lines: 4 items (3 core items + 1
 *  boots) instead of 6. A category line is a "if you want to itemize this
 *  way, here are the key pieces" hint, not a full recommended build — its
 *  first 3-4 items already carry the archetype intent, and the extra 2
 *  slots were mostly padding that inflated every set's byte size. Trimming
 *  them (and NOT the real Core/Buy order/Pro/Highest WPA lines, which stay
 *  at LINE_LEN) shrinks each CoachBuild set enough that even several sets
 *  stay well under the LCU item-sets PUT size limit that was returning 413
 *  (see companion.ps1's Merge-ItemSets for the complementary set-count
 *  bound). The 1-boots rule is preserved. */
const CATEGORY_LINE_LEN = 4;
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
  // Luden's, Shadowflame, Rabadon's, Void Staff, Liandry's, Zhonya's,
  // Rylai's, Riftmaker — a broad, standard mage core.
  pool: [6655, 4645, 3089, 3135, 6653, 3157, 3116, 4633],
  fits: () => true,
};
const AP_BURST: Archetype = {
  title: "AP Burst",
  family: "AP",
  // Glass cannon: AP damage with NO durability tag.
  match: (m) => hasAnyTag(m, AP_DAMAGE_TAGS) && !hasAnyTag(m, DURABILITY_TAGS),
  // Luden's, Shadowflame, Rabadon's, Void Staff, Stormsurge, Horizon Focus,
  // Lich Bane — pure penetration/amp burst.
  pool: [6655, 4645, 3089, 3135, 4646, 4628, 3100],
  fits: () => true,
};
const TANK_MAGE: Archetype = {
  title: "Tank Mage",
  family: "AP",
  // Durable AP: an AP item that ALSO builds durability (the user's exact
  // screenshot archetype — Rylai's/Riftmaker/Abyssal + Zhonya's Viktor).
  match: (m) => metaHasTag(m, "SpellDamage") && hasAnyTag(m, DURABILITY_TAGS),
  // Rylai's, Riftmaker, Rod of Ages, Cosmic Drive, Zhonya's, Abyssal Mask,
  // Liandry's, Hextech Rocketbelt — AP + health/resist.
  pool: [3116, 4633, 6657, 4629, 3157, 3001, 6653, 3152],
  fits: () => true,
};
const BRUISER_AD: Archetype = {
  title: "Bruiser (AD)",
  family: "AD",
  // Health + AD.
  match: (m) =>
    hasAnyTag(m, new Set(["Damage", "ArmorPenetration"])) && hasAnyTag(m, DURABILITY_TAGS),
  // Sterak's, Death's Dance, Black Cleaver, Stridebreaker, Titanic Hydra,
  // Trinity Force, Sundered Sky, Hullbreaker.
  pool: [3053, 6333, 3071, 6631, 3748, 3078, 6610, 3181],
  fits: (tags) => tags.includes("Fighter"),
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
  // Duskblade, Eclipse, Serylda's, Youmuu's, Profane Hydra, Hubris, Edge of
  // Night, Serpent's Fang.
  pool: [6691, 6692, 6694, 3142, 6698, 6697, 3814, 6695],
  fits: (tags) => tags.includes("Assassin"),
};
const CRIT_MARKSMAN: Archetype = {
  title: "Crit/Marksman",
  family: "AD",
  match: (m) => metaHasTag(m, "CriticalStrike"),
  // Infinity Edge, Rapid Firecannon, Statikk Shiv, Lord Dominik's,
  // Bloodthirster, Shieldbow, Phantom Dancer, The Collector, Mortal Reminder.
  pool: [3031, 3094, 3087, 3036, 3072, 6673, 3046, 6676, 3033],
  fits: (tags) => tags.includes("Marksman"),
};
const ON_HIT: Archetype = {
  title: "On-hit",
  family: "AD",
  match: (m) => hasAnyTag(m, new Set(["AttackSpeed", "OnHit"])),
  // Blade of the Ruined King, Wit's End, Guinsoo's, Kraken Slayer, Runaan's,
  // Trinity Force.
  pool: [3153, 3091, 3124, 6672, 3085, 3078],
  fits: (tags) => tags.includes("Marksman") || tags.includes("Fighter"),
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
  // Gargoyle Stoneplate, Abyssal Mask.
  pool: [3068, 3075, 3143, 3065, 3084, 3110, 3193, 3001],
  // Actual tanks only (the v0.47.0 brief: "high tankiness rating").
  fits: (tags, rating) => tags.includes("Tank") || rating.tankiness >= 3,
};

const AP_ARCHETYPES: Archetype[] = [AP_MAGE, AP_BURST, TANK_MAGE];
const AD_ARCHETYPES: Archetype[] = [BRUISER_AD, LETHALITY, CRIT_MARKSMAN, ON_HIT];

/** A real per-champ matched-item count at/above which an archetype line is
 *  presented as MEASURED (no "(low data)" suffix). CATEGORY_LINE_LEN is 4
 *  (3 non-boots + 1 boots), so 3 real non-boots matches fills the line from
 *  the champ's own data alone. */
const MIN_CATEGORY_MEASURED = 3;

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
// Unifies Pick (wpa-ranked — Core/Optimized/Situational's native shape) and
// pro-consensus entries (share-ranked) behind {id, weight} so the dedup/
// boots-fix/padding/ranking logic below is written ONCE, not once per pool
// type. "Top-6 by WPA" (the themed-line spec's own wording) means "top-6 by
// `weight`" in this model — wpa and share have always been this module's
// one shared ranking axis, not something themed lines need to reinterpret.
interface Candidate {
  id: number;
  weight: number;
}

function fromPicks(picks: PickType[]): Candidate[] {
  return picks.map((p) => ({ id: p.id, weight: p.wpa }));
}

function fromShares(entries: { itemId: number; share: number }[]): Candidate[] {
  return entries.map((e) => ({ id: e.itemId, weight: e.share }));
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
 *  - Everything else: a genuine recipe-tree leaf (`into` empty) is full;
 *    ANY non-empty `into` — including every STARTING_ITEM_ALLOWLIST id —
 *    is excluded. No allowlist escape hatch here. */
function isFullItem(itemId: number, meta: ItemDetail | undefined): boolean {
  if (!meta) return false;
  if (meta.purchasable === false) return false;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const from = Array.isArray(meta.from) ? meta.from : [];
  const into = Array.isArray(meta.into) ? meta.into : [];
  if (tags.includes("Boots") && from.length > 0) return true;
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
    if (options.length > 0) {
      return options.reduce((best, c) => (c.weight > best.weight ? c : best));
    }
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

  let boots: Candidate | null =
    primaryBoots.length > 0
      ? primaryBoots.reduce((best, c) => (c.weight > best.weight ? c : best))
      : null;

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

/** Highest-weight-wins union of several already full-item-filtered pools,
 *  deduped by id — the shared candidate pool every themed line ranks
 *  within. Keeping the MAX weight seen for an id (not first-seen) credits
 *  an item its best evidence when it shows up in multiple sources (e.g.
 *  both Core and Pro-consensus) with different weights. */
function unionPool(...pools: Candidate[][]): Candidate[] {
  const best = new Map<number, Candidate>();
  for (const pool of pools) {
    for (const c of pool) {
      const existing = best.get(c.id);
      if (!existing || c.weight > existing.weight) best.set(c.id, c);
    }
  }
  return Array.from(best.values());
}

/** v0.36.0 — Highest WPA / Tanky / Burst themed lines. `pool` is already
 *  full-item-filtered (buildItemSets's themedUnion); `tagSet === null`
 *  means "Highest WPA" (no tag filter, just top-6 by weight across the
 *  whole pool). Boots: prefer the highest-weight boots candidate that ALSO
 *  matches the theme (a themed boots pick, when one exists); otherwise fall
 *  back to the overall best boots in `pool` (any theme) rather than
 *  shipping a themed line with zero boots. Omits the line entirely (returns
 *  null — never pads with off-theme junk) when fewer than MIN_THEMED_POOL
 *  qualifying (tag-matched, full-item) candidates exist. */
function buildThemedLine(
  pool: Candidate[],
  tagSet: ReadonlySet<string> | null,
  itemMeta: ReadonlyMap<number, ItemDetail>,
  bootsIds: ReadonlySet<number>
): Candidate[] | null {
  const themed = tagSet ? pool.filter((c) => hasAnyTag(itemMeta.get(c.id), tagSet)) : pool;
  if (themed.length < MIN_THEMED_POOL) return null;

  const nonBoots = themed.filter((c) => !bootsIds.has(c.id)).sort((a, b) => b.weight - a.weight);
  const themedBoots = themed
    .filter((c) => bootsIds.has(c.id))
    .sort((a, b) => b.weight - a.weight)[0];
  const overallBoots = pool
    .filter((c) => bootsIds.has(c.id))
    .sort((a, b) => b.weight - a.weight)[0];
  const boots = themedBoots ?? overallBoots ?? null;

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
  const out: Candidate[] = [];
  itemMeta.forEach((m, id) => {
    if (!isFullItem(id, m)) return;
    if (!match(m)) return;
    out.push({ id, weight: m.goldTotal });
  });
  return out.sort((a, b) => b.weight - a.weight);
}

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
  const out: Candidate[] = [];
  for (const id of arch.pool) {
    const m = itemMeta.get(id);
    if (!m || !isFullItem(id, m)) continue;
    out.push({ id, weight: m.goldTotal });
  }
  return out;
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
  if (ap !== ad) return { family: ap > ad ? "AP" : "AD", confident: true };
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

/** v0.47.0 — build one archetype line. Real per-champ matched items (the
 *  champ's OWN recommended items embodying this archetype) rank first; a line
 *  with >= MIN_CATEGORY_MEASURED real non-boots matches is MEASURED, otherwise
 *  it's a "(low data)" FILL: real matches, then the curated archetype pool,
 *  then catalog-wide `match` defaults — all through the same one-boots/
 *  isFullItem machinery every other line uses, capped at CATEGORY_LINE_LEN (4).
 *  The champ's own real boots are always folded in so a fill never strands
 *  itself boots-less. */
function buildArchetypeLine(
  pool: Candidate[],
  arch: Archetype,
  itemMeta: ReadonlyMap<number, ItemDetail>,
  bootsIds: ReadonlySet<number>
): { line: Candidate[]; lowData: boolean } {
  const realMatched = pool
    .filter((c) => {
      const m = itemMeta.get(c.id);
      return m ? arch.match(m) : false;
    })
    .sort((a, b) => b.weight - a.weight);
  const realNonBoots = realMatched.filter((c) => !bootsIds.has(c.id));
  const overallBoots =
    pool.filter((c) => bootsIds.has(c.id)).sort((a, b) => b.weight - a.weight)[0] ?? null;

  if (realNonBoots.length >= MIN_CATEGORY_MEASURED) {
    const themedBoots = realMatched.filter((c) => bootsIds.has(c.id))[0] ?? null; // already weight-desc
    const boots = themedBoots ?? overallBoots;
    const target = CATEGORY_LINE_LEN - (boots ? 1 : 0);
    const top = realNonBoots.slice(0, target);
    if (!boots) return { line: top, lowData: false };
    const insertAt = Math.min(3, top.length);
    return { line: [...top.slice(0, insertAt), boots, ...top.slice(insertAt)], lowData: false };
  }

  const hasRealBoots = realMatched.some((c) => bootsIds.has(c.id));
  const primary = overallBoots && !hasRealBoots ? [...realMatched, overallBoots] : realMatched;
  const curatedFill = curatedArchetypePool(arch, itemMeta);
  const catalogFill = categoryDefaultPool(itemMeta, arch.match);
  const line = buildLine(primary, [curatedFill, catalogFill], bootsIds, CATEGORY_LINE_LEN);
  // A line that resolved to boots-only (no real archetype content anywhere in
  // reach — sparse itemMeta, or a family that the champ has zero on-archetype
  // items for) is meaningless: return empty so buildItemSets omits the block
  // rather than shipping a "shop line" that's just a pair of boots.
  if (line.filter((c) => !bootsIds.has(c.id)).length === 0) return { line: [], lowData: true };
  return { line, lowData: true };
}

function toItemRefs(cands: Candidate[]): ItemSetItem[] {
  return cands.map((c) => itemRef(c.id));
}

/** One id set covering every position the contract already knows is
 *  "boots" — see module header for why this is structural, not tag-based. */
function collectBootsIds(items: ItemsBlock, pro?: ProConsensusItemsInput | null): Set<number> {
  const ids = new Set<number>([items.boots.id]);
  for (const alt of items.alts?.boots ?? []) ids.add(alt.id);
  if (pro) for (const b of pro.boots) ids.add(b.itemId);
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
 *  Block order: Starting (exempt from the 6-rule — 1-3 items) → Core build
 *  (always, 6 full items/1 boots) → Buy order (only when
 *  resolveOptimizedPathView says it genuinely differs from Core — same rule
 *  the old buildOptimizedSet used — padded to 6 with the CORE remainder
 *  specifically, so it reads as "same build, refined order" rather than
 *  pulling in situational/pro noise) → Pro build (only when pro-consensus
 *  data resolves, boots-deduped to the single highest-share pick, padded
 *  via the general optimized→situational→consensus cascade) → Highest WPA
 *  (only when the whole pool has ≥4 qualifying full items — see
 *  buildThemedLine, UNCHANGED since v0.36.0) → up to CATEGORY_MAX_EMIT
 *  damage-type archetypes (v0.47.0 — family-scoped: pure Tank if an actual
 *  tank, then the champ's AP set [AP/Mage, AP Burst, Tank Mage] or AD set
 *  [Bruiser (AD), Lethality/Assassin, Crit/Marksman, On-hit]; never a
 *  cross-family line; thin data fills via buildArchetypeLine and gets a
 *  "(low data)" title suffix instead of being dropped) → Situational swaps
 *  (the alternates pool, cap 6, exempt
 *  from BOTH the one-boots rule AND the full-items rule — these are swap
 *  SUGGESTIONS, not a worn loadout, so a stacking item or several boots
 *  options side by side is the intended shape, not a bug). */
export function buildItemSets(
  champ: ChampionRef,
  roleLabel: string,
  build: BuildResponse,
  pro?: ProConsensusItemsInput | null,
  itemMeta?: ReadonlyMap<number, ItemDetail>
): ItemSet[] {
  const items = build.items;
  const meta = itemMeta ?? new Map<number, ItemDetail>();
  const hasPro = !!pro && (pro.items.length > 0 || pro.boots.length > 0);
  const bootsIds = collectBootsIds(items, hasPro ? pro : null);

  const corePrimaryRaw = fromPicks([items.first, items.second, items.third, items.boots, ...items.fourthPlus]);
  const corePrimary = fullItemsOnly(corePrimaryRaw, meta);

  const optimizedView = resolveOptimizedPathView(items);
  const optimizedPrimaryRaw = optimizedView.kind === "path" ? fromPicks(optimizedView.path) : null;
  const optimizedPrimary = optimizedPrimaryRaw ? fullItemsOnly(optimizedPrimaryRaw, meta) : null;

  // UNFILTERED — Situational swaps deliberately allows non-full items (Dark
  // Seal etc. are exactly where they belong here).
  const situationalPicks = flattenSituational(items);
  // FULL-FILTERED — used only as a fallback/padding pool for the 6-item
  // build lines below, never for the Situational swaps block itself.
  const situationalPoolFull = fullItemsOnly(fromPicks(situationalPicks), meta);

  const proPoolRaw = hasPro
    ? fromShares([...pro!.boots, ...pro!.items].sort((a, b) => b.share - a.share))
    : [];
  const proPool = fullItemsOnly(proPoolRaw, meta);

  // General padding priority for any short line: optimized -> situational ->
  // consensus, per the spec's cascade. Buy order's OWN padding overrides this
  // with just the core remainder (see below) — it's the one line that should
  // stay "this build, reordered/filled out," not reach into situational/pro.
  const generalFallback = [optimizedPrimary ?? [], situationalPoolFull, proPool];

  const blocks: ItemSetBlock[] = [
    { type: "Starting", items: [itemRef(items.starter.id)] },
    { type: "Core build", items: toItemRefs(buildLine(corePrimary, generalFallback, bootsIds)) },
  ];

  if (optimizedPrimary) {
    const optimizedLine = buildLine(optimizedPrimary, [corePrimary], bootsIds);
    // v0.36.0: the data-availability gate above (optimizedView differs from
    // core) is independent of the NEW full-items-only filter -- if every
    // candidate here happens to fail isFullItem (e.g. a totally degraded
    // itemMeta fetch), don't ship a technically-present but genuinely empty
    // shop-panel line.
    if (optimizedLine.length > 0) blocks.push({ type: "Buy order", items: toItemRefs(optimizedLine) });
  }

  if (hasPro) {
    const proLine = buildLine(proPool, generalFallback, bootsIds);
    // Same "never a genuinely empty block" guard as Buy order above --
    // `hasPro` only means the SOURCE pro-consensus data was non-empty, not
    // that anything survived the full-items-only filter.
    if (proLine.length > 0) blocks.push({ type: "Pro build", items: toItemRefs(proLine) });
  }

  // Themed lines — derived entirely from the pools already built above, no
  // new upstream data. All full-item-filtered already (every pool fed into
  // themedUnion is). Highest WPA (v0.36.0, UNCHANGED) uses buildThemedLine
  // directly; the damage-type archetypes (v0.47.0) use buildArchetypeLine.
  const themedUnion = unionPool(corePrimary, optimizedPrimary ?? [], situationalPoolFull, proPool);
  const highestWpaLine = buildThemedLine(themedUnion, null, meta, bootsIds);
  if (highestWpaLine) blocks.push({ type: "Highest WPA", items: toItemRefs(highestWpaLine) });

  // v0.47.0 — damage-type-scoped archetypes. The champ's family (AP vs AD) is
  // inferred from their OWN recommended items (themedUnion); every archetype
  // inside that family is emitted (never a cross-family one), plus pure Tank
  // when the champ is an actual tank. See the archetype vocabulary + the
  // resolveDamageFamily/selectArchetypes helpers above.
  const rating = getCompRating(champ.id);
  const champTags = champ.tags ?? [];
  const { family, confident } = resolveDamageFamily(champ, themedUnion, meta);
  const selected = selectArchetypes(family, champTags, rating);

  // Trim to CATEGORY_MAX_EMIT: keep universal pure Tank, then the family
  // archetypes with the most real per-champ data; declaration order preserved.
  const withData = selected.map((arch) => ({
    arch,
    poolLen: themedUnion.filter((c) => {
      const m = meta.get(c.id);
      return m ? arch.match(m) : false;
    }).length,
  }));
  let chosen = withData;
  if (withData.length > CATEGORY_MAX_EMIT) {
    const keep = new Set<Archetype>();
    for (const w of withData) if (w.arch.family === "universal") keep.add(w.arch);
    const ranked = withData
      .filter((w) => w.arch.family !== "universal")
      .sort((a, b) => b.poolLen - a.poolLen);
    for (const w of ranked) {
      if (keep.size >= CATEGORY_MAX_EMIT) break;
      keep.add(w.arch);
    }
    chosen = withData.filter((w) => keep.has(w.arch));
  }

  for (const { arch, poolLen } of chosen) {
    // A damage archetype with NO real per-champ items is only worth a
    // catalog-fill "(low data)" line when the champ's family is CONFIDENT
    // (item- or class-tag-confirmed). A pure tank/utility champ that only
    // defaulted into AP should get its Tank line, not a hollow "AP/Mage
    // (low data)" filled from the catalog. Pure Tank (universal) is exempt —
    // it's gated on real tankiness, not on a family guess.
    if (arch.family !== "universal" && !confident && poolLen === 0) continue;
    const { line, lowData } = buildArchetypeLine(themedUnion, arch, meta, bootsIds);
    if (line.length === 0) continue; // never a genuinely empty block
    blocks.push({ type: lowData ? `${arch.title} (low data)` : arch.title, items: toItemRefs(line) });
  }

  if (situationalPicks.length > 0) {
    blocks.push({
      type: "Situational swaps",
      items: situationalPicks.slice(0, SITUATIONAL_CAP).map((p) => itemRef(p.id)),
    });
  }

  return [{ ...baseSet(champ, roleLabel), blocks }];
}
