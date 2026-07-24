// ─────────────────────────────────────────────────────────────────────────────
// navBadgeModel.ts — pure model for a small "pick available" badge on the
// GlobalNav rail's BUILDS nav item (v0.51 redesign wave A). Separate tiny
// module (not folded into champSelectChipModel.ts) since it answers a
// narrower yes/no question consumed by a different piece of UI (a nav item
// badge dot, not the status chip's label/tone).
// ─────────────────────────────────────────────────────────────────────────────

/** True only while the companion reports live ChampSelect -- the window
 *  during which jumping to Builds is actually useful (a build recommendation
 *  exists to look up). Null (no session/companion) or any other phase ->
 *  false, never a fabricated "still relevant" badge once select ends. */
export function buildsPickBadge(phase: string | null): boolean {
  return phase === "ChampSelect";
}
