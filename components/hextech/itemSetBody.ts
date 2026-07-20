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
// proConsensus.ts) and operates on ItemDetail objects — this module only
// ever sees `Pick` (lib/types.ts), which carries no `tags` field at all, so
// a tags check here is a type error, not an oversight. The pattern this
// module CAN reuse structurally is the one ItemPath.tsx already uses for
// its own `isBoots` badge: `items.boots` is a dedicated, always-known-boots
// slot, and `items.alts?.boots` is the dedicated alternate-boots pool —
// both are boots by POSITION in the contract, not by inspecting the item
// itself. `collectBootsIds` below builds one id set from those two sources
// plus (when supplied) `pro.boots`, which proConsensus.ts's tags-based
// partition already resolved for us upstream — so the tags check still
// happens, just before this module ever sees the data, exactly once, not
// re-derived per Pick with no metadata to derive it from.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, BuildResponse, ItemsBlock, Pick as PickType } from "@/lib/types";
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
 *  tags-based check — see this module's header for why that matters. */
export interface ProConsensusItemsInput {
  items: { itemId: number; share: number }[];
  boots: { itemId: number; share: number }[];
}

const LINE_LEN = 6;
const SITUATIONAL_CAP = 6;

function slugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "x";
}

function itemRef(id: number, count = 1): ItemSetItem {
  return { id: String(id), count };
}

// ── Candidate: the one shape `buildLine` operates on ────────────────────────
// Unifies Pick (wpa-ranked — Core/Optimized/Situational's native shape) and
// pro-consensus entries (share-ranked) behind {id, weight} so the dedup/
// boots-fix/padding logic below is written ONCE, not once per pool type.
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
 *  items with EXACTLY ONE pair of boots.
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

/** ONE item set per champion+role — Core/Optimized/Pro/Situational are now
 *  BLOCKS (in-game shop-panel lines) inside it, not separate sets. See
 *  module header for the "3 sets → 1 set, 3 blocks" restructure and the two
 *  live bugs it fixes.
 *
 *  Block order: Starting (exempt from the 6-rule — 1-3 items) → Core build
 *  (always, 6 items/1 boots) → Optimized order (only when
 *  resolveOptimizedPathView says it genuinely differs from Core — same rule
 *  the old buildOptimizedSet used — padded to 6 with the CORE remainder
 *  specifically, so it reads as "same build, refined order" rather than
 *  pulling in situational/pro noise) → Pro build (only when pro-consensus
 *  data resolves, boots-deduped to the single highest-share pick, padded
 *  via the general optimized→situational→consensus cascade) → Situational
 *  swaps (the alternates pool, cap 6, exempt from the one-boots rule —
 *  these are swap SUGGESTIONS, not a worn loadout, so several boots options
 *  side by side is the intended shape, not a bug). */
export function buildItemSets(
  champ: ChampionRef,
  roleLabel: string,
  build: BuildResponse,
  pro?: ProConsensusItemsInput | null
): ItemSet[] {
  const items = build.items;
  const hasPro = !!pro && (pro.items.length > 0 || pro.boots.length > 0);
  const bootsIds = collectBootsIds(items, hasPro ? pro : null);

  const corePrimary = fromPicks([items.first, items.second, items.third, items.boots, ...items.fourthPlus]);

  const optimizedView = resolveOptimizedPathView(items);
  const optimizedPrimary = optimizedView.kind === "path" ? fromPicks(optimizedView.path) : null;

  const situationalPicks = flattenSituational(items);
  const situationalPool = fromPicks(situationalPicks);

  const proPool = hasPro
    ? fromShares([...pro!.boots, ...pro!.items].sort((a, b) => b.share - a.share))
    : [];

  // General padding priority for any short line: optimized -> situational ->
  // consensus, per the spec's cascade. Optimized's OWN padding overrides this
  // with just the core remainder (see below) — it's the one line that should
  // stay "this build, reordered/filled out," not reach into situational/pro.
  const generalFallback = [optimizedPrimary ?? [], situationalPool, proPool];

  const blocks: ItemSetBlock[] = [
    { type: "Starting", items: [itemRef(items.starter.id)] },
    { type: "Core build", items: toItemRefs(buildLine(corePrimary, generalFallback, bootsIds)) },
  ];

  if (optimizedPrimary) {
    const optimizedLine = buildLine(optimizedPrimary, [corePrimary], bootsIds);
    blocks.push({ type: "Optimized order", items: toItemRefs(optimizedLine) });
  }

  if (hasPro) {
    const proLine = buildLine(proPool, generalFallback, bootsIds);
    blocks.push({ type: "Pro build", items: toItemRefs(proLine) });
  }

  if (situationalPicks.length > 0) {
    blocks.push({
      type: "Situational swaps",
      items: situationalPicks.slice(0, SITUATIONAL_CAP).map((p) => itemRef(p.id)),
    });
  }

  return [{ ...baseSet(champ, roleLabel), blocks }];
}
