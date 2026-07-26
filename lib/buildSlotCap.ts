// ─────────────────────────────────────────────────────────────────────────────
// buildSlotCap.ts — PURE 6-slot game-reality cap for SEQUENTIAL/ORDERED build
// lines (CORE ORDER, OPTIMIZED ORDER). A League champion has exactly 6 item
// slots. A build line depicting more than that (e.g. 6 full items + boots =
// 7 tiles, live-verified on Galio MID: Hextech Rocketbelt → Imperial Mandate
// → Riftmaker → Plated Steelcaps → Kaenic Rookern → Force of Nature →
// Randuin's Omen) shows an impossible inventory.
//
// User rule (hard directive, 2026-07-24): non-bot lanes cap at 5 full items +
// 1 boots. Bot lane (ADC) gets one extra full-item slot — 6 full items + 1
// boots — to account for the real late-game boots-sell pattern (an ADC often
// sells boots for a 6th damage item once ahead; showing that 6th item
// alongside the earlier boots pick in a build PROGRESSION line is honest,
// even though no single moment in the game has all 7 simultaneously).
//
// Kept as its own pure module (no network, no wall-clock) so the cap logic is
// unit-testable in isolation and reusable from any assembly site — the single
// choke point recommend.ts's ItemsBlock construction (and, transitively,
// every renderer/exporter downstream: CoreBuildOrderCard, OptimizedPathRow,
// the LCU item-set export) all inherit it rather than re-deriving it. See
// recommend.ts's own header note at the call sites for why the LCU item-set
// export needs NO separate fix — it already hard-caps every block at 6 total
// slots (5 full + 1 boots) via itemSetBody.ts's `buildLine`/`LINE_LEN`,
// independent of lane, because a "set" is a real target LOADOUT (buy toward
// this), not a boots-sell progression.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleId } from "./types";

/** Bot/ADC lane id per the coachless role enum (lib/types.ts's RoleId):
 *  0=TOP, 1=JUNGLE, 2=MIDDLE, 3=BOTTOM(ADC), 4=UTILITY(SUPPORT), 5=auto. */
const BOT_ROLE_ID: RoleId = 3;
/** Utility/support lane id — same enum. */
const SUPPORT_ROLE_ID: RoleId = 4;

/** Full-item budget EXCLUDING boots.
 *
 *  - Non-bot, non-support: **5** (+ boots = the 6 slots the game has).
 *  - Bot/ADC: **6** (+ boots = 7 tiles) — the boots-sell exception, honest in
 *    a PROGRESSION line even though no single moment holds all seven.
 *  - Support: **4**. A support's quest item (World Atlas → Zaz'Zak's
 *    Realmspike / Bloodsong / …) permanently OCCUPIES one of the six slots and
 *    is surfaced separately by SupportItemCard, so a 5-full-item core order
 *    plus boots plus the support item is 7 real slots — the same impossible
 *    inventory the Galio fixture caught, arriving by a different route (user
 *    report, 2026-07-26: "should be 6 including supp items and boots").
 *
 *  Role 5 ("auto") is treated as non-bot, non-support: it is not an explicit
 *  lane selection, and 5 is the safe budget for an unknown lane.
 *
 *  ── The support budget ASSUMES the quest item is absent from the line ──────
 *  4 is only correct while no support final can appear in the build line
 *  itself. That holds today and is enforced upstream, not here: coachless
 *  classifies the five finals as ItemType 3, lib/recommend.ts requests only
 *  types 6/2/1, and lib/supportFinalGroup.ts's `collapseSupportFinalPools`
 *  guards the boundary if that ever changes (probe evidence in that module's
 *  header). If one DOES reach the line, this reserves the sixth slot for an
 *  item that is already occupying one of the four — the line spends 4 items +
 *  boots = 5 real slots, the sixth is double-reserved and never filled, and
 *  the user loses a genuine sixth-item recommendation while SupportItemCard
 *  renders the same final a second time on its own surface.
 *
 *  This function is deliberately NOT the place to fix that. It is a pure COUNT
 *  cap over an opaque `T[]` — it never sees item ids, and it runs only on the
 *  4th+ tail and the optimizer chain, never on the first/second/third slots
 *  where a final would actually land. Making it id-aware would break its
 *  generic signature to catch a case it cannot observe. The membership
 *  invariant belongs at the data boundary; the count invariant belongs here. */
export function fullItemCapForRole(role: RoleId): number {
  if (role === BOT_ROLE_ID) return 6;
  if (role === SUPPORT_ROLE_ID) return 4;
  return 5;
}

/** Caps an ordered "extra" full-item list (already best-value-first, e.g.
 *  recommend.ts's 4th+ legendary picks or the optimizer's conditioned chain)
 *  against the role's slot budget, given `fixedCount` already-committed
 *  leading slots (the confirmed first/second/third legendary picks, which are
 *  never trimmed — they're the confirmed core, not surplus).
 *
 *  Drops the LOWEST-value surplus entries from the tail — `extra` must
 *  already be sorted best-first, which every caller in this repo's data
 *  pipeline already guarantees (coachless's WPA-sorted pools) — and never
 *  reorders. Never fabricates: if `extra` is shorter than the budget, it is
 *  returned unchanged (a genuinely thin data set stays thin, it is not
 *  padded). */
export function capExtraFullItems<T>(extra: T[], fixedCount: number, role: RoleId): T[] {
  const cap = fullItemCapForRole(role);
  const budget = Math.max(0, cap - fixedCount);
  return extra.slice(0, budget);
}
