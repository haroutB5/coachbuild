// ─────────────────────────────────────────────────────────────────────────────
// supportItem.ts — support-role FINAL item-upgrade resolver (Build page,
// v0.49.0, user request: "for supp also show which supp item to upgrade to").
//
// ── Investigation finding (see HANDOFF-engy.md for the full probe) ─────────
// The support quest-item upgrade is NEVER present in /api/build's data today.
// Verified live across Senna/Nami/Yuumi/Leona/Braum/Thresh (support role):
// `items.starter` is always World Atlas (3865), but NONE of first/second/
// third/fourthPlus/alts ever contains a support-item id at all — champs
// instead get recommended a completely SEPARATE pool of standalone
// "enchanter"/tank items (Staff of Flowing Water, Echoes of Helia, Knight's
// Vow, Locket of the Iron Solari, ...) built from generic components, not
// from the support-quest chain. NOT something this app's own filters
// (isFullItem/isBuildItem, which don't even run on this page — those live in
// itemSetBody.ts's companion item-set export, a separate pipeline) are
// excluding. `findSupportFinalInBuildData` below is a real, honest scan (not
// a stub) so this activates automatically the moment the data ever starts
// surfacing one — but expect it to return null in practice today.
//
// ── CORRECTION (2026-07-26): this is OUR gap, not coachless's ──────────────
// This header used to call the absence "an UPSTREAM DATA GAP (coachless's
// pipeline apparently doesn't observe/attribute a quest-completion pick the
// same way as a normal purchase)". That attribution is WRONG, and believing
// it makes the gap look far more permanent than it is. The real mechanism is
// entirely in this repo, one request parameter wide:
//   - coachless's own catalog (`_research/items.json`) classifies all five
//     finals as `ItemType: 3`. World Atlas is 6, Runic Compass / Bounty of
//     Worlds are 4, legendaries are 1, boots are 2.
//   - `getGlobalItemStatistics` (lib/coachless.ts) takes `itemType` as a
//     REQUEST parameter and does zero client-side filtering — it is a raw
//     passthrough of whatever the endpoint returns.
//   - Every call site in lib/recommend.ts requests itemType 6 (starter), 2
//     (boots) or 1 (legendary). NOTHING anywhere requests itemType 3.
// So the finals can never appear in /api/build because nobody ever asks for
// them — which is also exactly why `items.starter` is ALWAYS World Atlas
// (type 6 IS requested) while the finals never show. Adding a type-3 fetch is
// a one-line change someone might make deliberately to light up the
// `measured` branch below. DO NOT make it without reading the "what breaks"
// list in HANDOFF-engy.md (2026-07-26): the recommend.ts slot loops,
// buildSlotCap.ts's support reservation, and every card that renders
// items.first/second/third/alts all dedupe by EXACT ID ONLY and would each
// happily show two mutually-exclusive finals side by side.
//
// ── The real upgrade tree (verified live, NOT assumed from the brief) ──────
// Pulled from the coachless CDN mirror's item.json (patch 16.13.1,
// `cdn.coachless.gg/static-files/16.13.1/16.13.1/data/en_US/item.json` — the
// same host itemDetail.ts/proAssets.ts already use). The brief's own 2-tier
// description (World Atlas -> Runic Compass -> 5 finals) is off by one tier:
// live data shows a THIRD tier, "Bounty of Worlds", between Runic Compass and
// the 5-item choice:
//   World Atlas (3865, tier 1) --specialRecipe--> Runic Compass (3866, tier 2,
//   specialRecipe:3865) --specialRecipe--> Bounty of Worlds (3867, tier 3,
//   specialRecipe:3866) --into:[3869,3870,3871,3876,3877]--> ONE of the 5
//   finals below, each carrying `from:["3867"]`.
// World Atlas is also the ONLY one of the 5 real support starter chains
// (Spectral Sickle/Steel Shoulderguards/Relic Shield/Harrowing Crescent are
// the other 4) whose tier-3 item has a further `into` — the other 4 chains
// dead-end at a single fixed tier-3 item with no choice to make, which is
// exactly why they're out of scope for "which upgrade to build." Every probed
// support champ's recommended starter was World Atlas, so this is the only
// chain that matters in practice. Re-verify these ids each patch the same way
// (a specialRecipe/into/from re-pull) — coachless's numeric item ids are not
// guaranteed stable across an itemization rework.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse, ChampionRef, Pick as PickType } from "@/lib/types";
import {
  SUPPORT_FINAL_ITEMS,
  SUPPORT_FINAL_ITEM_IDS,
  isSupportFinalItem,
  type SupportItemOption,
} from "@/lib/supportFinalGroup";
import { getCompRating, deriveFallbackRating, type RatedComp } from "@/lib/draft/compRatings";
import { itemIconUrl } from "@/components/proAssets";

/** getCompRating(champId) alone ignores tags for an UNCURATED champion (its
 *  own doc comment: "deliberately the conservative default... a caller that
 *  DOES have real tags... should call deriveFallbackRating directly for a
 *  sharper guess") — this page always has ChampionRef.tags on hand, so use
 *  them: curated row wins when one exists, else derive from this champ's
 *  OWN tags rather than the zero vector getCompRating alone would give. */
function champRating(champ: ChampionRef): RatedComp {
  const curated = getCompRating(champ.id);
  if (!curated.estimated) return curated;
  return { ...deriveFallbackRating(champ.tags ?? []), estimated: true };
}

/** The five finals + their shape are DECLARED in lib/supportFinalGroup.ts and
 *  re-exported here, not declared twice. They moved out of this file on
 *  2026-07-26 when lib/recommend.ts needed the same family semantics: lib/
 *  importing a value out of components/ inverts the dependency direction, and
 *  reaching them through this module would have pulled compRatings and
 *  proAssets into the server engine's graph for the sake of five integers.
 *  This re-export keeps this module's public API (SupportItemCard, the tests)
 *  byte-identical. See that module's header for the full rationale. */
export {
  SUPPORT_FINAL_ITEMS,
  SUPPORT_FINAL_ITEM_IDS,
  isSupportFinalItem,
  type SupportItemOption,
};

export const SUPPORT_STARTER_ID = 3865; // World Atlas
export const SUPPORT_TIER2_ID = 3866; // Runic Compass
export const SUPPORT_QUEST_HUB_ID = 3867; // Bounty of Worlds (into -> the 5 finals)

const ALL_FINAL_IDS = SUPPORT_FINAL_ITEM_IDS;
const FINAL_BY_ID = new Map<number, SupportItemOption>(
  Object.values(SUPPORT_FINAL_ITEMS).map((i) => [i.id, i])
);

export type SupportArchetype = "Enchanter" | "Tank/Engage" | "AP/Poke" | "AD/Aggressive";

export interface SupportItemSuggestion {
  item: SupportItemOption;
  icon: string;
  /** true only when the final item itself was found inside the champ's own
   *  /api/build response — a genuine measured pick, not a judgment call. See
   *  module header: verified always false in practice today, kept as a real
   *  branch (not hardcoded) so it self-activates if upstream data changes. */
  measured: boolean;
  archetype: SupportArchetype;
}

/** Scans every slot the /api/build contract can carry a Pick in (starter,
 *  boots, first/second/third, fourthPlus, and every alts[] array) for one of
 *  the 5 support-item finals, returning the highest-`wpa` match. Pure. */
export function findSupportFinalInBuildData(build: BuildResponse): PickType | null {
  const items = build.items;
  const pool: PickType[] = [
    items.starter,
    items.boots,
    items.first,
    items.second,
    items.third,
    ...items.fourthPlus,
  ];
  if (items.alts) {
    for (const alts of Object.values(items.alts)) pool.push(...alts);
  }
  let best: PickType | null = null;
  for (const p of pool) {
    if (!ALL_FINAL_IDS.has(p.id)) continue;
    if (!best || p.wpa > best.wpa) best = p;
  }
  return best;
}

// ── Fallback classification (data-informed judgment, NOT measured) ─────────
// Curated item-id pools, verified against the SAME live item.json pull as the
// quest chain above (16.13.1) — used only to recognise the champ's OWN
// recommended CORE items (first/second/third/fourthPlus — the same slots
// CoreBuildOrderCard renders; boots/starter/alts deliberately excluded, alts
// are long-tail/low-sample and boots/starter carry no archetype signal here)
// as belonging to a known real-item archetype.
const ENCHANTER_ITEM_IDS = new Set<number>([
  6616, // Staff of Flowing Water
  6620, // Echoes of Helia
  3504, // Ardent Censer
  3107, // Redemption
  2065, // Shurelya's Battlesong
  6617, // Moonstone Renewer
  6621, // Dawncore
  3222, // Mikael's Blessing
]);
const TANK_SUPPORT_ITEM_IDS = new Set<number>([
  2504, // Kaenic Rookern
  2524, // Bandlepipes
  2525, // Protoplasm Harness
  3050, // Zeke's Convergence
  3075, // Thornmail
  3109, // Knight's Vow
  3110, // Frozen Heart
  3190, // Locket of the Iron Solari
]);

function countMatches(ids: ReadonlySet<number>, pool: ReadonlySet<number>): number {
  let n = 0;
  ids.forEach((id) => {
    if (pool.has(id)) n++;
  });
  return n;
}

/** The champ's own real "core" item ids — same scope CoreBuildOrderCard
 *  renders, minus boots/starter (see module header on why). */
function coreItemIds(build: BuildResponse): Set<number> {
  const it = build.items;
  return new Set<number>([
    it.first.id,
    it.second.id,
    it.third.id,
    ...it.fourthPlus.map((p) => p.id),
  ]);
}

/** Judgment fallback for when the build data never surfaces a measured final
 *  (see findSupportFinalInBuildData) — classifies the champ into one of 4
 *  archetypes. Priority: real itemization signal (the champ's own
 *  recommended core items matching a known pool) beats ddragon's coarse
 *  class tags — same "real itemization beats the coarse scale" posture
 *  itemSetBody.ts's resolveDamageFamily already documents (ddragon has no
 *  "Enchanter" tag at all, so a tag-only check can't tell Nami/Yuumi
 *  (Mage+Support, pure enchanters by real itemization) apart from a poke
 *  mage support like Xerath/Zyra (also Mage+Support, but items never match
 *  ENCHANTER_ITEM_IDS) — only the real recommended items make that call
 *  correctly). ddragon tags are the fallback signal when no known-item pool
 *  matches at all (e.g. a champ whose real items are thin/off-meta). */
export function classifySupportArchetype(champ: ChampionRef, build: BuildResponse): SupportArchetype {
  const core = coreItemIds(build);
  const enchanterMatches = countMatches(core, ENCHANTER_ITEM_IDS);
  const tankMatches = countMatches(core, TANK_SUPPORT_ITEM_IDS);
  const tags = champ.tags ?? [];
  const rating = champRating(champ);

  if (enchanterMatches > 0 && enchanterMatches >= tankMatches) return "Enchanter";
  if (tankMatches > 0 && (tags.includes("Tank") || rating.tankiness >= 2)) return "Tank/Engage";
  if (tags.includes("Marksman") || tags.includes("Assassin") || tags.includes("Fighter")) {
    return "AD/Aggressive";
  }
  // Mage/Support-only tags, or no real signal at all -> AP/poke default (the
  // same last-resort-AP posture resolveDamageFamily uses in itemSetBody.ts).
  return "AP/Poke";
}

function finalForArchetype(archetype: SupportArchetype, rating: RatedComp): SupportItemOption {
  switch (archetype) {
    case "Enchanter":
      return SUPPORT_FINAL_ITEMS.dreamMaker;
    case "Tank/Engage":
      // Celestial Opposition (reactive: damage reduction + slow after taking
      // champion damage) vs Solstice Sleigh (proactive: rewards landing
      // slow/immobilize near allies) — both real 16.13.1 items for this
      // niche. Split on the champ's own curated cc/engage rating
      // (lib/draft/compRatings.ts, the same source itemSetBody.ts's
      // TANK_PURE archetype gate already trusts elsewhere on this data
      // path): a hard-CC hard-engage kit (cc>=3 && engage>=3, e.g. Leona/
      // Thresh) leans Solstice Sleigh; a less CC-heavy but still tanky kit
      // leans the more universally-safe Celestial Opposition.
      return rating.cc >= 3 && rating.engage >= 3
        ? SUPPORT_FINAL_ITEMS.solsticeSleigh
        : SUPPORT_FINAL_ITEMS.celestialOpposition;
    case "AD/Aggressive":
      return SUPPORT_FINAL_ITEMS.bloodsong;
    case "AP/Poke":
      return SUPPORT_FINAL_ITEMS.zazzaks;
  }
}

function archetypeForFinalId(id: number): SupportArchetype {
  if (id === SUPPORT_FINAL_ITEMS.dreamMaker.id) return "Enchanter";
  if (id === SUPPORT_FINAL_ITEMS.zazzaks.id) return "AP/Poke";
  if (id === SUPPORT_FINAL_ITEMS.bloodsong.id) return "AD/Aggressive";
  return "Tank/Engage"; // Celestial Opposition / Solstice Sleigh
}

/** The one entry point callers use. Support-role gating (role === 4 / lane
 *  === "support") happens at the CALL SITE (BuildTabContent), not here —
 *  this function is role-agnostic and callable for any champion, so it stays
 *  honestly unit-testable without threading a role param through it.
 *  `ver` is the same versioned CDN folder (e.g. "16.13.1") the page already
 *  resolves via proAssets.versionFromPatch(build.patch) — only used to build
 *  the fallback-branch icon URL; the measured branch reuses the Pick's own
 *  wire-provided icon instead of re-deriving one. */
export function resolveSupportItemSuggestion(
  champ: ChampionRef,
  build: BuildResponse,
  ver: string
): SupportItemSuggestion {
  const measuredPick = findSupportFinalInBuildData(build);
  if (measuredPick) {
    const known = FINAL_BY_ID.get(measuredPick.id);
    if (known) {
      return {
        item: known,
        icon: measuredPick.icon,
        measured: true,
        archetype: archetypeForFinalId(known.id),
      };
    }
  }
  const archetype = classifySupportArchetype(champ, build);
  const rating = champRating(champ);
  const item = finalForArchetype(archetype, rating);
  return { item, icon: itemIconUrl(item.id, ver), measured: false, archetype };
}
