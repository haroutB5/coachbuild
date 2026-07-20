// ─────────────────────────────────────────────────────────────────────────────
// itemSetBody.ts — pure builder for the companion's POST /apply-itemsets body
// (item-sets feature round, 2026-07-20 — wire contract extension of
// runeApplyBody.ts's own pattern). Up to THREE LCU item sets per
// champion+role: Core (always, from the base build), Optimized (only when
// items.optimizedPath genuinely differs from the core order — reuses
// optimizedPath.ts's own "confirmed vs path" definition so a set titled
// "Optimized" is never a silent duplicate of Core), Pro (only when the
// caller supplies pro-consensus item data — see ProConsensusItemsInput below
// for why that's a separate async concern, not something this pure builder
// fetches itself).
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
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, BuildResponse, ItemsBlock } from "@/lib/types";
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
 *  isn't part of the /api/build BuildResponse contract at all). */
export interface ProConsensusItemsInput {
  items: { itemId: number; share: number }[];
  boots: { itemId: number; share: number }[];
}

const SITUATIONAL_CAP = 6;
const PRO_CAP = 8;

function slugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "x";
}

function itemRef(id: number, count = 1): ItemSetItem {
  return { id: String(id), count };
}

function baseSet(champ: ChampionRef, roleLabel: string, variant: string, titleSuffix: string): Omit<ItemSet, "blocks"> {
  return {
    uid: `coachbuild-${slugPart(champ.name)}-${slugPart(roleLabel)}-${variant}`,
    title: `CoachBuild ${champ.name} ${roleLabel} — ${titleSuffix}`,
    type: "custom",
    map: "any",
    mode: "any",
    associatedMaps: [],
    associatedChampions: [champ.id],
    preferredItemSlots: [],
    sortrank: 0,
  };
}

function buildCoreSet(champ: ChampionRef, roleLabel: string, items: ItemsBlock): ItemSet {
  // "Core build order" mirrors CoreBuildOrderCard.tsx's own displayed
  // sequence exactly (first -> second -> third -> boots -> fourthPlus) —
  // same vocabulary the user already sees on the BUILD tab, not a
  // reinvented ordering.
  const coreOrder = [items.first, items.second, items.third, items.boots, ...items.fourthPlus];
  const situational = flattenSituational(items).slice(0, SITUATIONAL_CAP);

  const blocks: ItemSetBlock[] = [
    { type: "Starting", items: [itemRef(items.starter.id)] },
    { type: "Core build order", items: coreOrder.map((p) => itemRef(p.id)) },
  ];
  if (situational.length > 0) {
    blocks.push({ type: "Situational", items: situational.map((p) => itemRef(p.id)) });
  }

  return { ...baseSet(champ, roleLabel, "core", "Core"), blocks };
}

function buildOptimizedSet(champ: ChampionRef, roleLabel: string, items: ItemsBlock): ItemSet | null {
  // Reuses the EXACT "does this genuinely differ from core" rule
  // CoreBuildOrderCard's UI already applies (via OptimizedPathRow) — a set
  // titled "Optimized" that was actually identical to "Core" would just be a
  // confusing duplicate write into the client.
  const view = resolveOptimizedPathView(items);
  if (view.kind !== "path") return null;
  return {
    ...baseSet(champ, roleLabel, "optimized", "Optimized"),
    blocks: [{ type: "Optimized order", items: view.path.map((p) => itemRef(p.id)) }],
  };
}

function buildProSet(champ: ChampionRef, roleLabel: string, pro: ProConsensusItemsInput): ItemSet | null {
  const combined = [...pro.boots, ...pro.items].sort((a, b) => b.share - a.share).slice(0, PRO_CAP);
  if (combined.length === 0) return null;
  return {
    ...baseSet(champ, roleLabel, "pro", "Pro"),
    blocks: [{ type: "Pro consensus", items: combined.map((e) => itemRef(e.itemId)) }],
  };
}

/** Up to 3 item sets for the current champion+role. Core is always present
 *  (BuildResponse always carries items.first/second/third/boots/starter).
 *  Optimized only when items.optimizedPath genuinely differs from Core.
 *  Pro only when the caller supplies pro-consensus data (absent/null when
 *  that fetch failed or came back empty). "Top 3 if available" — this NEVER
 *  pads to 3 and NEVER invents a variant that doesn't have real data behind
 *  it; the result is 1, 2, or 3 sets depending on what's actually there. */
export function buildItemSets(
  champ: ChampionRef,
  roleLabel: string,
  build: BuildResponse,
  pro?: ProConsensusItemsInput | null
): ItemSet[] {
  const sets: ItemSet[] = [buildCoreSet(champ, roleLabel, build.items)];

  const optimized = buildOptimizedSet(champ, roleLabel, build.items);
  if (optimized) sets.push(optimized);

  if (pro) {
    const proSet = buildProSet(champ, roleLabel, pro);
    if (proSet) sets.push(proSet);
  }

  return sets.slice(0, 3);
}
