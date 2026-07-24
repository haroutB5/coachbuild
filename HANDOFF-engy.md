<!-- merged into HANDOFF.md 2026-07-23 23:48:37Z; previous content preserved there. Append new rounds below. -->

## 2026-07-24 — 6-slot build-line cap (hard user directive)

**Bug:** `CoreBuildOrderCard`'s CORE ORDER line could render 7 tiles for a
non-bot lane (live-verified Galio MID, championId 3, High Elo: Hextech
Rocketbelt → Imperial Mandate → Riftmaker → Plated Steelcaps (boots) →
Kaenic Rookern → Force of Nature → Randuin's Omen = 6 full items + boots).
Impossible — a League champion has exactly 6 item slots.

**Root cause:** `lib/recommend.ts`'s `ItemsBlock.fourthPlus` was built from
`orderedLegendaries.slice(3, 6)` — up to 3 extra legendaries on top of the
confirmed `first`/`second`/`third` — with no role-aware cap. `CoreBuildOrderCard.tsx`
just concatenates `[first, second, third, boots, ...fourthPlus]`, so any
non-empty `fourthPlus` beyond 2 extra items pushed the non-bot total over 6.

**Fix — single choke point at assembly, not per-component:**
- New pure module `lib/buildSlotCap.ts`: `fullItemCapForRole(role)` (5 for
  Top/Jungle/Mid/Support/Auto; 6 for Bot/ADC — role id `3` per `RoleId`, the
  documented late-game boots-sell exception) and `capExtraFullItems(extra,
  fixedCount, role)` — trims an already best-first-sorted "extra" pool to the
  role's remaining budget, dropping the lowest-value tail, never reordering,
  never fabricating (returns the pool unchanged if it's already short).
- Wired into `lib/recommend.ts` at the two places `ItemsBlock`'s
  full-item lists get assembled:
  - `fourthPlusBests` (line ~396): `capExtraFullItems(orderedLegendaries.slice(3).map(o => o.entry), 3, role)`.
  - `optimizedEntries` (the OPTIMIZED ORDER / "Buy order" chain, line ~484):
    `[leg1Best, ...capExtraFullItems(optimizedRest, 1, role)]` — defensive;
    the optimizer's own depth cap (`buildOptimizedPath(..., 2, ...)`) already
    keeps this ≤3, well under either budget today, but this routes it through
    the same choke point so a future depth increase can't reopen the bug on
    this surface too (the directive named OPTIMIZED ORDER explicitly).
- **`CoreBuildOrderCard.tsx` / `OptimizedPathRow.tsx` — untouched.** They
  just render whatever `ItemsBlock` hands them; capping at assembly means
  every consumer inherits the fix for free.
- **LCU item-set export (`components/hextech/itemSetBody.ts`) — verified,
  NOT changed.** Every build LINE there (`Core build`, `Buy order`, `Pro
  build`, themed archetypes) already funnels through `buildLine()`/
  `buildThemedLine()`, both hard-capped at `LINE_LEN = 6` (5 full + 1 boots)
  **unconditionally, regardless of lane** — confirmed by reading every call
  site (`itemSetBody.ts:1027,1031,1041,898`), none pass a role-derived
  `lineLen`. That's correct behavior, not a gap: an item SET is a real target
  loadout to buy toward (never more than 6 physical slots at once), whereas
  the bot-lane 6-full+boots exception is specifically about a build
  PROGRESSION display that includes a later boots-sell swap — not a
  simultaneous inventory. So the export intentionally stays capped at 6
  total for every lane, bot included. No `companionClient.ts` touched.
- **"No boots in data" — provably unreachable, not fabricated-around.**
  `bootsBest = bestItem(bootsData, ...)` and the guard
  `if (!starterBest || !bootsBest || orderedLegendaries.length < 3) throw
  NotPlayedInRoleError(...)` (recommend.ts ~L380) already 404s BEFORE
  `ItemsBlock` is ever constructed if the champ+role has no boots data at
  all — so `items.boots` is always present downstream. `capExtraFullItems`
  itself has zero boots awareness (tested explicitly — it treats a
  boots-shaped candidate as an ordinary item, never special-cases or
  fabricates one), which is what makes the choke point correct: boots
  correctness is guaranteed one layer up, not duplicated here.

**Result for the Galio fixture:** MID (non-bot, role 2) now renders 3 core +
boots + 2 of the 3 fourth-plus items (Kaenic Rookern, Force of Nature kept;
Randuin's Omen — lowest WPA — dropped) = 6 tiles total. The identical
fourthPlus pool on a BOT-lane champ would keep all 3 extras = 7 tiles
(3+boots+3), per the documented exception.

**Tests:** `lib/__tests__/buildSlotCap.test.ts` (12 new, all green) — Galio-
shaped non-bot fixture (drop lowest-value surplus, order preserved, total=6),
bot-lane exception (total=7, and a 4-candidate pool still trims to 3), thin-
data pass-through (never fabricates), boots-agnosticism, and the
optimized-order chain staying untouched under both budgets. Full suite:
**1524/1524 green** (`npx vitest run`), `tsc --noEmit` clean, `next lint`
clean (pre-existing `<img>` warnings only, unrelated).

**Files touched:** `lib/buildSlotCap.ts` (new), `lib/recommend.ts`,
`lib/types.ts` (doc comment only), `lib/__tests__/buildSlotCap.test.ts` (new).
No version bump, no deploy (per brief — orchestrator ships).
