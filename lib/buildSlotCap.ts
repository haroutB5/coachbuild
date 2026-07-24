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

/** Full-item budget EXCLUDING boots. Non-bot lanes: 5. Bot lane: 6 (the
 *  boots-sell exception). Role 5 ("auto") is treated as non-bot — it is not
 *  an explicit ADC selection. */
export function fullItemCapForRole(role: RoleId): number {
  return role === BOT_ROLE_ID ? 6 : 5;
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
