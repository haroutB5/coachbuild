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
const SITUATIONAL_CAP = 6;
/** A themed line (Highest WPA / Tanky / Burst) is omitted entirely rather
 *  than padded with off-theme junk when fewer than this many qualifying
 *  (tag-matched, full-item) candidates exist. */
const MIN_THEMED_POOL = 4;

// v0.36.0 — real ddragon tag vocabulary, confirmed against a live
// item.json pull (coachless CDN mirror, 16.13.1, 2026-07-20) before picking
// these — NOT invented. Full tag set observed on purchasable items:
// AbilityHaste, Active, Armor, ArmorPenetration, AttackSpeed, Aura,
// Bilgewater, Boots, Consumable, CooldownReduction, CriticalStrike, Damage,
// GoldPer, Health, HealthRegen, Jungle, Lane, LifeSteal, MagicPenetration,
// MagicResist, Mana, ManaRegen, NonbootsMovement, OnHit, Slow, SpellBlock,
// SpellDamage, SpellVamp, Stealth, Tenacity, Trinket, Vision.
// There is NO "Lethality" tag (Lethality is a stat, not a ddragon tag) —
// real Lethality-class items (Duskblade, Youmuu's, Prowler's, etc.) are
// tagged ArmorPenetration, the closest real substitute for the brief's own
// "Lethality-class" wording. "SpellBlock" (not the newer, much rarer
// "MagicResist" tag — confirmed: SpellBlock covers Spirit Visage/Banshee's
// Veil/Mercury's Treads/etc., MagicResist only a handful of newer items) is
// the MR tag matching the brief's literal "Armor/SpellBlock-tagged" wording.
const TANKY_TAGS = new Set(["Health", "Armor", "SpellBlock"]);
const BURST_TAGS = new Set(["SpellDamage", "Damage", "ArmorPenetration", "MagicPenetration"]);

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
  bootsIds: ReadonlySet<number>
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

  const target = LINE_LEN - (boots ? 1 : 0);
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
 *  via the general optimized→situational→consensus cascade) → Highest WPA /
 *  Tanky / Burst (only when each has ≥4 qualifying full items — see
 *  buildThemedLine) → Situational swaps (the alternates pool, cap 6, exempt
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

  // Themed lines (v0.36.0) — derived entirely from the pools already built
  // above, no new upstream data. All full-item-filtered already (every pool
  // fed into themedUnion is), so buildThemedLine only needs to apply its own
  // tag filter + boots/omission rules on top.
  const themedUnion = unionPool(corePrimary, optimizedPrimary ?? [], situationalPoolFull, proPool);
  const highestWpaLine = buildThemedLine(themedUnion, null, meta, bootsIds);
  const tankyLine = buildThemedLine(themedUnion, TANKY_TAGS, meta, bootsIds);
  const burstLine = buildThemedLine(themedUnion, BURST_TAGS, meta, bootsIds);

  if (highestWpaLine) blocks.push({ type: "Highest WPA", items: toItemRefs(highestWpaLine) });
  if (tankyLine) blocks.push({ type: "Tanky", items: toItemRefs(tankyLine) });
  if (burstLine) blocks.push({ type: "Burst", items: toItemRefs(burstLine) });

  if (situationalPicks.length > 0) {
    blocks.push({
      type: "Situational swaps",
      items: situationalPicks.slice(0, SITUATIONAL_CAP).map((p) => itemRef(p.id)),
    });
  }

  return [{ ...baseSet(champ, roleLabel), blocks }];
}
