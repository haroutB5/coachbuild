// ─────────────────────────────────────────────────────────────────────────────
// startingItems.ts — the STARTING/opener item allowlist.
//
// ── Why this lives in lib/ and not components/hextech/ (moved 2026-07-29) ───
// It was declared in components/hextech/proConsensus.ts, next to its first
// consumer, which was fine while every consumer was a component. It stopped
// being fine when lib/otp/featuredBuild.ts needed the same partition: lib/
// importing a VALUE out of components/ inverts the dependency direction, and
// following that chain would have dragged proConsensus.ts's whole module graph
// (components/proAssets and its CDN fetches, components/itemDetail,
// lib/supportFinalGroup, perkSlots) into a module whose only need was eleven
// integers. lib/supportFinalGroup.ts moved out of components/ on 2026-07-26 for
// exactly this reason and documents it at length; this is the same move.
//
// The ids MOVED rather than being duplicated. proConsensus.ts imports and
// re-exports `STARTING_ITEM_ALLOWLIST`, so every existing import site
// (FeaturedOtpCard.tsx, the proConsensus tests) is unchanged and there is still
// exactly ONE declaration of these ids. This file has ZERO imports of its own.
//
// ── What the list is, and its known weakness ────────────────────────────────
// An explicit list of items players commonly FINISH a game holding even though
// they are not "complete" in the recipe-tree sense. Two entries are load-bearing
// on their own terms — Dark Seal (upgrades into Mejai's) and Tear of the Goddess
// (upgrades into Manamune/Archangel's/Winter's Approach/Whispering Circlet) both
// have a real `into`, so an empty-into rule alone would wrongly exclude them.
// The rest are already empty-into and would pass the general completed-item rule
// unaided; they are pinned here as an explicit, patch-proof guarantee.
//
// THIS IS AN ENUMERATION AND IT HAS ROTTED TWICE. Doran's Bow (1086) and
// Doran's Helm (1120) were missing until 2026-07-25, and because both are
// `into: []` nothing else held them out: they shipped inside completed 6-item
// build lines in production (Doran's Bow in Ashe/Jinx/Caitlyn/Lucian/Ezreal
// "Pro build", Doran's Helm in Ornn/Darius/Malphite) and the Pro Consensus card
// rendered "Doran's Bow 43%" in its completed-items grid — the exact display the
// 2026-07-22 Dark Seal directive banned. The structural guard that does not
// depend on anyone maintaining a list is itemSetBody.ts's `isFullItem` lane-
// starter rule (from-nothing + cheap + "Lane"-tagged). Add ids here when you
// notice them; do not rely on this list being sufficient.
// ─────────────────────────────────────────────────────────────────────────────

/** Starting/opener items — see the module header for which entries are
 *  load-bearing today vs. pinned defensively. */
export const STARTING_ITEM_ALLOWLIST = new Set<number>([
  1054, // Doran's Shield
  1055, // Doran's Blade
  1056, // Doran's Ring
  1082, // Dark Seal — upgrades into Mejai's Soulstealer; still a real build choice
  1083, // Cull
  1086, // Doran's Bow — MISSING until 2026-07-25; see the header
  1120, // Doran's Helm — MISSING until 2026-07-25; see the header
  3070, // Tear of the Goddess — upgrades into Manamune/Archangel's/Winter's Approach/Whispering Circlet
  3865, // World Atlas (support starter)
  2049, // Guardian's Amulet (support starter)
  2050, // Guardian's Shroud (support starter)
]);
