// ─────────────────────────────────────────────────────────────────────────────
// bootsItems.ts — THE boots predicate. One rule, one place.
//
// ── Why this file exists ───────────────────────────────────────────────────
// "Is this item boots?" was answered independently in three modules —
// proConsensus.ts (`isBootsTag`/`isBootsFinal`), itemSetBody.ts (`isFullItem`'s
// boots branch) and lib/otp/featuredBuild.ts (`classifyFeaturedItem`) — and all
// three answered it the same way: `tags.includes("Boots")`. Three copies of one
// rule is the same failure mode CLAUDE.md gotcha (dd) records for the /api/pros
// query and FeaturedOtpCard.tsx's header records for item classification: the
// copies agree right up until the day the rule is wrong, and then they are all
// wrong together and no single fix reaches them.
//
// That day arrived. Live ddragon **16.15.1** tags item **3172 Gunmetal Greaves**
// — a tier-3 boot enchant, built from 3006 Berserker's Greaves —
//
//     tags: ["AttackSpeed", "LifeSteal", "NonbootsMovement"]
//
// with **no `Boots` tag**, and (the catalog contradicting itself) a
// `NonbootsMovement` tag on a boot. Every other tier-3 enchant carries `Boots`:
// 3168 Immortal Path, 3170 Swiftmarch, 3171 Crimson Lucidity, 3173 Chainlaced
// Crushers, 3174 Armored Advance, 3175 Spellslinger's Shoes, 3176 Forever
// Forward. 3172 is the only one that does not. Verified against a live pull of
// ddragon 16.15.1, 2026-07-29, by walking the full transitive `into` closure
// from 1001 Boots — the gap is exactly one item across the whole family.
//
// ── What it cost ───────────────────────────────────────────────────────────
// A tag-only rule classifies 3172 as a plain completed item, so:
//   - it takes a COMPLETED-ITEM slot on the Pro/OTP consensus grids, pushing a
//     real item out;
//   - it is invisible to the boots slot, so the "top boots" lists rank the
//     champion's rare boots while their actual boot is missing;
//   - and, worst, `itemSetBody.ts`'s one-boots-per-line invariant cannot see it,
//     so a build line ships TWO pairs of boots into the user's shop.
// Measured live against prod `/api/pros` on 2026-07-29: **Yone mid held 3172 in
// 178 of 200 games (89%)**, Yasuo mid 132/200, Vayne mid 20/31, Tryndamere mid
// 11/13, Yone bot 112/200 — 18 champion/role feed combos in a 23-champion probe.
// This was never a Draven-only edge case.
//
// ── The rule, and why it is ancestry rather than an id list ────────────────
// An id list rots. `STARTING_ITEM_ALLOWLIST` shipped Doran's Bow inside
// completed build lines twice (lib/startingItems.ts), and CLAUDE.md gotcha (y)
// records curated ids silently renaming under us. So the rule is structural:
//
//     an item is boots if it is Boots-TAGGED, or if anything it is BUILT FROM
//     is boots.
//
// Every boot in the game descends from 1001 Boots, which is Boots-tagged, so the
// recipe chain is the anchor and a missing tag anywhere above tier 1 is
// self-healing. It also cannot over-reach: nothing outside the boots tree builds
// from a Boots-tagged item. Measured over the ENTIRE live 16.15.1 catalog, the
// ancestry clause reclassifies exactly ONE item that the tag alone missed —
// 3172 — and zero others. A blast radius of one, verified rather than assumed.
//
// ── BOOTS_ID_EXCEPTIONS is the degradation path, not decoration ────────────
// The ancestry clause needs to look 3172's PARENT (3006) up in the item catalog.
// Two real call sites cannot always supply one: `classifyFeaturedItem` is called
// from FeaturedOtpCard.tsx with a single item's metadata and no map, and
// `getItemDetailMap` can degrade (components/itemDetail.ts's localStorage cache
// normalizes a stale entry to `from: []`, which is exactly the field the chain
// walks). Without a catalog the ancestry clause silently answers "not boots" and
// the bug is back on that path only — the worst kind, because the other paths
// would still be right and the disagreement is invisible.
//
// So the ONE id whose catalog entry is known-wrong is also pinned by id. It is
// not an allowlist of "boots we remembered"; it is a list of "places the catalog
// lies", each entry carrying what the catalog says and what is true. Same
// posture as lib/snowballStacks.ts's enumeration: small, closed, and documented
// at the point a reader would otherwise assume it was an oversight.
//
// ── The two questions this module answers, and why they are different ──────
// `isBootsItem`  — "is this in the boots family at all?" INCLUDES tier-1 1001.
//                  Used for PARTITIONING (which grid slot does this belong in)
//                  and for the one-boots-per-line invariant, where a tier-1
//                  Boots occupying the boots slot is still correct behaviour.
// `isFinalBootsItem` — "is this a finished boots choice?" EXCLUDES tier-1 1001
//                  via the `from.length > 0` clause. Used for COMPLETED-ITEM
//                  rules, where raw Boots is a mid-build component. That clause
//                  is load-bearing and pre-dates this file: without it 1001
//                  (Boots-tagged, built from nothing) would count as a real
//                  boots pick and could take a slot in a six-item loadout.
// Do not collapse them. They were one function once and the distinction is why
// proConsensus.ts needed both `isBootsTag` and `isBootsFinal`.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemDetail } from "@/components/itemDetail";

/** ddragon's tag for the boots family. Declared once so no consumer writes the
 *  string literal again — a grep for `"Boots"` outside this file should find
 *  only prose, and `lib/__tests__/bootsItems.test.ts` asserts exactly that. */
export const BOOTS_TAG = "Boots";

/**
 * Ids the live catalog gets WRONG, pinned so the classification survives a
 * catalog lookup we cannot perform (see the module header's degradation note).
 *
 * - `3172` **Gunmetal Greaves** — tier-3 boot enchant, `from: ["3006"]`
 *   (Berserker's Greaves). ddragon 16.15.1 tags it
 *   `["AttackSpeed","LifeSteal","NonbootsMovement"]` — no `Boots`, and a
 *   `NonbootsMovement` tag it directly contradicts. Every one of the other seven
 *   tier-3 enchants (3168/3170/3171/3173/3174/3175/3176) carries `Boots`.
 *   Verified against a live ddragon 16.15.1 pull, 2026-07-29.
 *
 * REMOVING AN ENTRY: only once the live catalog has been re-checked and the tag
 * is actually back. The ancestry rule already covers this id whenever a catalog
 * is available, so an entry going stale costs nothing — but deleting one that is
 * still wrong reopens the bug on every catalog-less call site at once.
 */
export const BOOTS_ID_EXCEPTIONS: ReadonlySet<number> = new Set<number>([3172]);

/** The item catalog, keyed by id — `getItemDetailMap`'s shape. Optional at every
 *  call site; absent simply means the ancestry clause cannot run. */
export type ItemCatalog = ReadonlyMap<number, ItemDetail>;

/** Guarded `tags` read — this data ultimately comes from JSON.parse'd
 *  localStorage (components/itemDetail.ts) and a real prod incident (v0.27.2)
 *  had `tags`/`from` arriving `undefined` against a type that says otherwise. */
function tagsOf(meta: ItemDetail | undefined): string[] {
  return meta && Array.isArray(meta.tags) ? meta.tags : [];
}

function fromOf(meta: ItemDetail | undefined): string[] {
  return meta && Array.isArray(meta.from) ? meta.from : [];
}

/** Recipe depth is 3 in the live game (1001 -> tier 2 -> tier 3). 6 leaves room
 *  for a future tier without ever walking a pathological chain; the `seen` set
 *  handles a cyclic/self-referential catalog entry independently. */
const MAX_RECIPE_DEPTH = 6;

/**
 * True when `itemId` is a boots item — TAGGED, ancestrally built from one, or a
 * pinned catalog exception. Includes tier-1 1001 Boots; see
 * `isFinalBootsItem` when you need "a finished boots choice" instead.
 *
 * @param itemId  the id being classified
 * @param meta    that id's own metadata, or `undefined` if unknown
 * @param catalog the full item map, for the ancestry clause. OMITTING IT IS
 *                SAFE but weaker — the rule falls back to tag + exception list,
 *                which still catches every id we know the catalog lies about.
 *                Pass it wherever one is in scope.
 *
 * An id with NO metadata at all is never boots (the "never assume, never invent"
 * default the whole item-classification chain uses) unless it is pinned.
 */
export function isBootsItem(itemId: number, meta: ItemDetail | undefined, catalog?: ItemCatalog): boolean {
  if (BOOTS_ID_EXCEPTIONS.has(itemId)) return true;
  if (!meta) return false;
  if (tagsOf(meta).includes(BOOTS_TAG)) return true;
  if (!catalog) return false;
  return builtFromBoots(meta, catalog, 0, new Set<number>([itemId]));
}

/** Does any transitive `from` ancestor carry the boots tag (or sit in the
 *  exception list)? Walks ids as numbers — ddragon's `from` is string ids and
 *  the catalog is number-keyed. */
function builtFromBoots(meta: ItemDetail, catalog: ItemCatalog, depth: number, seen: Set<number>): boolean {
  if (depth >= MAX_RECIPE_DEPTH) return false;
  for (const raw of fromOf(meta)) {
    const parentId = Number(raw);
    if (!Number.isFinite(parentId) || seen.has(parentId)) continue;
    seen.add(parentId);
    if (BOOTS_ID_EXCEPTIONS.has(parentId)) return true;
    const parent = catalog.get(parentId);
    if (!parent) continue;
    if (tagsOf(parent).includes(BOOTS_TAG)) return true;
    if (builtFromBoots(parent, catalog, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * True when `itemId` is a FINISHED boots choice — boots (per `isBootsItem`) that
 * was built from something.
 *
 * The `from.length > 0` clause excludes raw tier-1 1001 Boots, which is a
 * mid-build component, and is why a completed-item rule must call this rather
 * than `isBootsItem`. It also, deliberately, excludes the Boots-tagged
 * non-Summoner's-Rift oddities the catalog carries with empty recipes (1111
 * Jarvan I's, 2422 Slightly Magical Footwear, the 550xxx debug items that carry
 * literally every tag) — behaviour this file inherited from proConsensus.ts's
 * `isBootsFinal` and preserves exactly.
 */
export function isFinalBootsItem(
  itemId: number,
  meta: ItemDetail | undefined,
  catalog?: ItemCatalog
): boolean {
  if (!meta) return false;
  if (fromOf(meta).length === 0) return false;
  return isBootsItem(itemId, meta, catalog);
}
