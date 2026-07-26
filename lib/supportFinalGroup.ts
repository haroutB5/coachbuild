// ─────────────────────────────────────────────────────────────────────────────
// supportFinalGroup.ts — the support-quest FINAL item FAMILY as a mutually-
// exclusive group: the five ids, membership, the "top one wins, the rest are
// alternatives" collapse, and the pool-level guard the recommendation engine
// applies at its data boundary.
//
// ── The bug this exists to close (user-reported, screenshot-confirmed) ──────
// Pro Consensus's ITEMS grid rendered Zaz'Zak's Realmspike 80% AND Solstice
// Sleigh 20% side by side. Both are support-quest finals. A player can hold
// exactly ONE of the five — Bounty of Worlds (3867) has
// `into: [3869,3870,3871,3876,3877]` and upgrades into precisely one of them
// (verified against a live 16.13.1 item.json pull, 2026-07-26, same coachless
// CDN mirror itemDetail.ts reads). So a grid showing two of them is not
// showing two build choices a pro made together; it is showing ONE choice
// split across a sample, while burning two of six item slots and pushing a
// real item out.
//
// Structurally identical to the v0.28.0 boots carve-out (a split boots
// preference eating two slots) — same fix shape: partition the family OUT of
// the main `items` list into its own field, render it as ONE slot with the
// runners-up stacked under the top pick. This module is the pure, testable
// half of that: ids + membership + ranking, no rendering, no aggregation.
//
// ── Why this lives in lib/ and not components/hextech/ (moved 2026-07-26) ───
// It was born under components/hextech/ next to its first caller
// (proConsensus.ts) and took its five ids by importing `SUPPORT_FINAL_ITEMS`
// from components/hextech/supportItem.ts. That was fine while the only
// consumer was a component. It stopped being fine the moment lib/recommend.ts
// — the server-side recommendation engine — needed the same family semantics
// for `collapseSupportFinalPools` below: lib/ importing a value out of
// components/ inverts the dependency direction, and following the old chain
// (supportFinalGroup -> supportItem -> lib/draft/compRatings +
// components/proAssets) would have dragged a CDN-fetching browser asset
// helper and a curated draft-ratings table into the engine's module graph for
// the sake of five integers.
//
// So the ids MOVED here rather than being duplicated: this file now declares
// `SUPPORT_FINAL_ITEMS` and has ZERO imports of its own. supportItem.ts
// imports and re-exports it, so its own public API (SupportItemCard, tests)
// is unchanged and there is still exactly ONE declaration of the five ids in
// the repo. Re-verify them each patch the way supportItem.ts's header
// describes — a specialRecipe/into/from re-pull; coachless's numeric item ids
// are not guaranteed stable across an itemization rework.
//
// ── Why the ranking is NOT part of supportItem.ts ──────────────────────────
// supportItem.ts is the BUILD-page archetype resolver: it answers "which
// final SHOULD this champion upgrade to," a judgment call over champion kits.
// This module answers a different, purely mechanical question — "which of
// these already-COUNTED ids belong to the same mutually-exclusive family, and
// which one did the sample actually pick most" — over data that is already
// measured. proConsensus.ts (a pure frequency aggregator) and recommend.ts
// (the WPA engine) both need the second and have no business importing the
// first.
// ─────────────────────────────────────────────────────────────────────────────

export interface SupportItemOption {
  id: number;
  name: string;
}

/** The five mutually-exclusive support-quest finals — the ONE declaration of
 *  these ids in the repo (see the module header for why they live here and
 *  not in components/hextech/supportItem.ts, which re-exports this). */
export const SUPPORT_FINAL_ITEMS = {
  dreamMaker: { id: 3870, name: "Dream Maker" },
  zazzaks: { id: 3871, name: "Zaz'Zak's Realmspike" },
  bloodsong: { id: 3877, name: "Bloodsong" },
  celestialOpposition: { id: 3869, name: "Celestial Opposition" },
  solsticeSleigh: { id: 3876, name: "Solstice Sleigh" },
} satisfies Record<string, SupportItemOption>;

/** Derived from `SUPPORT_FINAL_ITEMS`, never re-declared. */
export const SUPPORT_FINAL_ITEM_IDS: ReadonlySet<number> = new Set<number>(
  Object.values(SUPPORT_FINAL_ITEMS).map((i) => i.id)
);

/** Family membership test — "is this id one of the five items a player can
 *  only ever own one of." Deliberately id-only: unlike `isBuildItem`, this
 *  needs NO ddragon metadata, because the family is a closed, known set
 *  rather than something inferred from a recipe tree. That also means it
 *  cannot silently degrade when an item-metadata fetch fails (the failure
 *  mode `isBootsTag` has to guard against). */
export function isSupportFinalItem(itemId: number): boolean {
  return SUPPORT_FINAL_ITEM_IDS.has(itemId);
}

/** The minimum an entry must carry to be ranked here — structurally the same
 *  prefix as `ItemFrequency` (proConsensus.ts), so that type satisfies it
 *  without any adapter. Generic rather than hardcoded to `ItemFrequency` so
 *  this module never has to import the aggregation it serves. */
export interface SupportFinalRankable {
  itemId: number;
  count: number;
}

/** The collapse result: the family occupies ONE slot, and that slot has a
 *  primary pick plus the runners-up it beat.
 *
 *  `alternatives` are the OTHER finals the sample actually observed — real,
 *  separately-counted picks, kept as their own entries with their own counts.
 *  They are NEVER merged with `top` into a combined "the family was built
 *  X% of the time" stat: that number would describe a choice nobody made,
 *  and this data path's whole posture is "never assume, never invent." */
export interface SupportFinalRanking<T extends SupportFinalRankable> {
  top: T;
  alternatives: T[];
}

/** Collapses a mixed list of item entries down to the support-final family,
 *  ranked. Pure, total, and order-independent.
 *
 *  Contract:
 *   - Filters `entries` to family members (`isSupportFinalItem`). Non-family
 *     ids are ignored, never returned — the caller keeps them.
 *   - Re-sorts the survivors itself: count DESC, then itemId ASC. The
 *     deterministic itemId tie-break matches every other ranking in this data
 *     path (proConsensus.ts's `sortEntries`), so a two-way 50/50 split always
 *     renders the same way instead of following Map insertion order. Sorting
 *     here rather than trusting the caller's order means a caller that hands
 *     over an unsorted list still gets a correct answer.
 *   - Returns `null` — not an empty object — when the sample contains NO
 *     family member. Null is what makes "absent, not empty" expressible at
 *     the call site: a champion who never built a support final renders no
 *     slot at all, the same convention `boots`/`starters` already use.
 *   - Does NOT mutate `entries`.
 *   - Applies no display cap. A cap is a rendering decision and belongs with
 *     the other display limits (proConsensus.ts's TOP_* constants), not in
 *     the logic that decides what the sample actually contained. */
export function rankSupportFinals<T extends SupportFinalRankable>(
  entries: readonly T[]
): SupportFinalRanking<T> | null {
  const family = entries
    .filter((e) => isSupportFinalItem(e.itemId))
    .slice()
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.itemId - b.itemId));
  if (family.length === 0) return null;
  return { top: family[0], alternatives: family.slice(1) };
}

// ── The recommendation engine's data-boundary guard ─────────────────────────
//
// WHY THIS EXISTS EVEN THOUGH IT IS A NO-OP TODAY (evidence, 2026-07-26).
// Probed live against api.coachless.gg, patch 16.13.0, six support champions
// (Thresh/Nami/Yuumi/Leona/Braum/Senna), ten requests each: `itemType` is a
// HARD server-side partition, not a hint. Every itemType 1 (legendary) / 2
// (boots) / 6 (starter) response contained ZERO of the five finals; the
// itemType 3 response contained EXACTLY the five and nothing else, and
// widening `itemSlots` did not change that (type-3 slot[1] == type-3
// null-slots). coachless's own catalog (_research/items.json) classifies all
// five as ItemType 3. lib/recommend.ts requests only 6, 2 and 1. So a final
// cannot reach a WPA build line or the situational swaps today.
//
// What it IS protected by is somebody else's taxonomy plus a comment. Two
// ways that ends: a deliberate `itemType: 3` fetch here (supportItem.ts's own
// header openly invites one, to light up its `measured` branch), or coachless
// reclassifying the family upstream — which would need no code change in this
// repo at all. Either way the type-3 pool arrives carrying ALL FIVE finals at
// enormous occurrence (measured: Thresh Solstice Sleigh 282,980 / Celestial
// Opposition 233,952 — both clear any adoption bar by orders of magnitude),
// so the failure would be immediate and loud, not marginal.
//
// And every gate downstream is EXACT-ID ONLY: recommend.ts's `usedItems`
// (core order), the `pathItemIds` exclusion feeding situational swaps,
// itemSetBody.ts's `dedupeById` (only `bootsIds` is grouped there). Each
// would happily seat two mutually-exclusive finals in the same six-slot
// build, and the situational block would offer a "swap" between two items
// only one of which the player can ever own.
//
// Guarding at the POOL boundary rather than patching each of those gates is
// deliberate: it enforces the invariant ("the engine never reasons over more
// than one member of the family") once, where the data enters, so every
// consumer inherits it — including consumers that do not exist yet. Patching
// the gates would fix the instances and leave the invariant unstated.

/** Structural shape of a coachless `ItemEntry` as far as this guard cares.
 *  Kept structural so lib/supportFinalGroup.ts imports nothing at all — see
 *  the module header on why this file has no dependencies. */
export interface SupportFinalPoolEntry {
  itemId: number;
  occurrence: number;
}

/** Collapses the support-final family across a SET of item pools so that at
 *  most ONE of the five survives anywhere in them.
 *
 *  The winner is chosen by `rankSupportFinals` — the same count-DESC /
 *  itemId-ASC rule the Pro Consensus card already collapses this family with,
 *  reused rather than re-implemented — over each id's BEST occurrence in any
 *  single pool. Best-per-id rather than a sum across pools: the pools handed
 *  in are a mix of slot-scoped ([1], [2], [3], [4,5,6]) and null-slot
 *  (starter, boots) queries, so summing would double-count the null-slot
 *  totals against the per-slot ones and let a pool list's SHAPE decide the
 *  winner. Max is the one reading that is stable under adding or removing a
 *  redundant pool.
 *
 *  Losers are stripped from every pool; the winner is kept in every pool it
 *  appeared in (which slot it is best bought in stays the engine's call, not
 *  this function's). Pure: returns a new outer array, never mutates the
 *  inputs, and returns the SAME pool references untouched in the overwhelmingly
 *  common case where the family is absent entirely. */
export function collapseSupportFinalPools<T extends SupportFinalPoolEntry>(
  pools: readonly T[][]
): T[][] {
  const bestByItemId = new Map<number, number>();
  for (const pool of pools) {
    for (const entry of pool) {
      if (!isSupportFinalItem(entry.itemId)) continue;
      const prev = bestByItemId.get(entry.itemId);
      if (prev === undefined || entry.occurrence > prev) {
        bestByItemId.set(entry.itemId, entry.occurrence);
      }
    }
  }
  // The live case today: nothing to collapse — hand the pools straight back.
  if (bestByItemId.size <= 1) return pools.map((p) => p.slice());
  const ranked = rankSupportFinals(
    Array.from(bestByItemId, ([itemId, count]) => ({ itemId, count }))
  );
  const keepId = ranked?.top.itemId;
  return pools.map((pool) =>
    pool.filter((e) => !isSupportFinalItem(e.itemId) || e.itemId === keepId)
  );
}
