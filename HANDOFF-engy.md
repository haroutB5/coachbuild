<!-- merged into HANDOFF.md 2026-07-26 11:44:39Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engy — support-quest final collapse (Pro Consensus)

**Date:** 2026-07-26
**Model:** claude-opus-5
**Version:** unchanged at v0.61.2 (no bump, no CHANGELOG edit, no commit, no deploy — urgot ships)

---

## The bug

Pro Consensus's ITEMS grid rendered **Zaz'Zak's Realmspike 80%** and **Solstice Sleigh 20%** at the
same time. Both are support-quest FINALS. Bounty of Worlds (3867) has
`into: [3869, 3870, 3871, 3876, 3877]` and upgrades into **exactly one** of them, so a player can
never own two. The grid was spending two of its six slots on a single choice split across the
sample, pushing a real item out.

Structurally identical to the v0.28.0 boots carve-out (a split boots preference eating two slots)
and the 2026-07-22 starters carve-out. Same fix shape, deliberately.

---

## Probe findings — TWO corrections to documented assumptions

Re-pulled the live `16.13.1` `item.json` from the coachless CDN mirror before writing anything
(`cdn.coachless.gg/static-files/16.13.1/16.13.1/data/en_US/item.json`).

### Correction 1 — what actually excludes 3866/3867 is NOT `into`

The briefed mechanism ("they have non-empty `into`") is only half true, and the false half is the
load-bearing half.

| id | name | `into` | `purchasable` | what actually excludes it |
|---|---|---|---|---|
| 3866 | Runic Compass | **absent entirely** | `false` | `purchasable === false` — **ONLY** |
| 3867 | Bounty of Worlds | `[3869,3870,3871,3876,3877]` | `false` | either check |

`itemDetail.ts`'s `normalizeCachedItemDetail` coerces a missing `into` to `[]`, and `isBuildItem`'s
final rule is `Array.isArray(meta.into) && meta.into.length === 0` → **true**. So if anyone removes
or reorders the `purchasable === false` check believing the `into` rule covers the intermediate
tiers, **Runic Compass leaks straight into the items grid**. Both tiers are also `specialRecipe`
upgrades, not `from`-recipe ones, so nothing else in the filter chain would catch them either. Now
pinned by a test that encodes the real per-id shape rather than the intuitive one.

Also confirmed: **all five finals pass `isBuildItem` on their own merits** — `from: ["3867"]`, `into`
absent (→ `[]`), `purchasable: true`, no `Boots` tag. That is *why* the duplication was possible; it
was never a filter failure, it was a missing partition. World Atlas (3865) is `purchasable: true` and
allowlisted, so it still lands in `starters`. Partition precedence (boots → starters → support
finals) is a **construction guarantee**, not luck: no final carries the `Boots` tag or sits in the
allowlist.

### Correction 2 — the "upstream data gap" is OURS, one parameter wide

`supportItem.ts`'s header claimed the finals never appear in `/api/build` because of "an UPSTREAM
DATA GAP (coachless's pipeline apparently doesn't observe/attribute a quest-completion pick...)".
**That attribution is wrong.** Verified in-repo, three facts:

1. Coachless's own catalog (`_research/items.json`) classifies all five finals as **`ItemType: 3`**.
   World Atlas is `6`, Runic Compass / Bounty of Worlds are `4`, legendaries `1`, boots `2`.
2. `getGlobalItemStatistics` (`lib/coachless.ts`) takes `itemType` as a **request parameter** and
   does zero client-side filtering — raw passthrough.
3. Every call site in `lib/recommend.ts` requests itemType `6`, `2` or `1`.
   **Nothing anywhere requests itemType 3.** (`coachless.ts`'s own doc comment only enumerates
   `1=legendary, 2=boots, 6=starter` — type 3 is not even named.)

The finals can never appear because nobody asks for them. That also cleanly explains why
`items.starter` is *always* World Atlas (type 6 IS requested) while the finals never show. This makes
"upstream starts supplying it tomorrow" **much more likely than the header implied** — it is a
one-line change someone might make deliberately, to light up `SupportItemCard`'s `measured` branch.

**I corrected that header comment in `supportItem.ts` (doc-only, zero behavior change)** and pointed
it at the "what breaks" list below. Revert with `git checkout components/hextech/supportItem.ts` if
you'd rather ship it separately.

---

## Files changed

| File | Change |
|---|---|
| `components/hextech/supportFinalGroup.ts` | **NEW** — the pure helper (membership + collapse) |
| `components/hextech/proConsensus.ts` | new `supportFinals` model field + partition + module-header section |
| `components/hextech/ProConsensusCard.tsx` | new `SupportFinalStackTile`, rendered as ONE slot in the Items row |
| `components/hextech/itemSetsApply.ts` | folds `supportFinals.top` back into the LCU Pro-line input (non-regression) |
| `components/hextech/itemSetBody.ts` | doc-only: `ProConsensusItemsInput.items` now carries at most one final |
| `components/hextech/supportItem.ts` | **doc-only** — corrected the false "upstream data gap" root cause |
| `components/__tests__/proConsensus.test.ts` | +15 tests |
| `components/__tests__/itemSetsApply.test.ts` | +1 test, fixture gains the two final ids |

No version bump, no CHANGELOG, no commit, no deploy.

---

## The helper's exact contract

`components/hextech/supportFinalGroup.ts`

```ts
export const SUPPORT_FINAL_ITEM_IDS: ReadonlySet<number>
export function isSupportFinalItem(itemId: number): boolean
export interface SupportFinalRankable { itemId: number; count: number }
export interface SupportFinalRanking<T extends SupportFinalRankable> { top: T; alternatives: T[] }
export function rankSupportFinals<T extends SupportFinalRankable>(
  entries: readonly T[]
): SupportFinalRanking<T> | null
```

- **Ids imported from `SUPPORT_FINAL_ITEMS` (`supportItem.ts`), never re-declared.** Dependency runs
  one way (`supportFinalGroup` → `supportItem`), no cycle; `supportItem`'s private `ALL_FINAL_IDS`
  left untouched.
- `isSupportFinalItem` is **id-only, needs no ddragon metadata** — the family is a closed known set,
  not something inferred from a recipe tree. Unlike `isBootsTag` it therefore cannot silently degrade
  when the item-metadata fetch fails.
- `rankSupportFinals` filters to family members, **re-sorts them itself** (count desc, then `itemId`
  asc — the same deterministic tie-break as `sortEntries`), returns `top` + `alternatives`. Sorting
  internally means a caller handing over an unsorted list still gets a correct answer.
- Returns **`null`, not an empty object**, when the sample has no family member — that is what makes
  "absent, not empty" expressible at the call site (a champion who never built a final renders **no
  slot at all**, same convention as `boots`/`starters`).
- **Does not mutate** the input. **Applies no display cap** — it reports what the sample genuinely
  contained; capping is a rendering decision.

### Why its own module, not `supportItem.ts`

`supportItem.ts` is the BUILD-page **archetype resolver** — it pulls `lib/draft/compRatings` +
`components/proAssets` to answer *"which final should this champion upgrade to"*, a judgment call
over champion kits. This module answers a different, purely mechanical question over already-measured
data. `proConsensus.ts` is a pure frequency aggregator and has no business importing the first.

Checked the import direction first as instructed: only **one** file under `lib/` imports from
`@/components/` (`lib/lastChampion.ts`, type-only), so `components → lib` is the house direction and
a `lib/` home would have been backwards. Both new/edited modules stay under `components/`.

---

## Model + render

```ts
supportFinals: SupportFinalRanking<ItemFrequency> | null   // on ProConsensusModel
```

- Shares divide by **`itemsSampleSize`**, same denominator as `items`/`boots`/`starters` (that
  field's doc comment explains why: live-ingested prostage rows carry `final_items = '[]'`).
- **Percentages are never merged or re-normalised** into a combined family stat. 80% and 20% stay
  80% and 20%; a "the family was built 100% of the time" number would describe a choice nobody made.
  Pinned by an explicit assertion.
- Capped at `TOP_SUPPORT_FINALS_LIMIT = 3` (top + 2 alternatives), applied **at the model boundary**,
  never inside the helper. Applied to the flattened top-then-alternatives order, so the cap trims the
  weakest runners-up and **can never drop the top pick**.
- `SupportFinalStackTile` follows `BootsStackTile` exactly (same `w-[72px]` column, same `w-11 h-11`
  / `size=44` tiles) so it reflows in the same Items flex-wrap row. Two deliberate differences: an
  **"or" rule** between the top pick and the alternatives, because these are mutually exclusive where
  stacked boots are merely a split preference; and alternatives render dimmed with an aria-label
  reading "an alternative support-quest upgrade" (the "or" rule is `aria-hidden` — the exclusivity is
  already in each label, so screen readers don't hear it twice).
- Renders between the boots stack and the main items. For every non-support champion `supportFinals`
  is `null` and **the card's layout is byte-identical to before**.

---

## Tests

`components/__tests__/proConsensus.test.ts` — 15 new:

- **USER BUG REPRO** — the literal 8/2 Zaz'Zak's/Solstice split → one slot + one alternative, both
  finals gone from `items`, Rocketbelt's slot freed, shares un-merged.
- single final → top, no alternatives; zero finals → `null` (absent-not-empty), plus the N=0 model
  assertion.
- **REGRESSION PIN** — generic over all five real ids from `SUPPORT_FINAL_ITEMS`, so a future 6th
  final or a reordered partition fails here rather than in production.
- deterministic tie-break — the *higher* id is seen first (so it leads Map insertion order) and the
  lower id must still win.
- cap at 3, top pick never dropped.
- **order-of-checks guard** — World Atlas stays a `starter`; 3866/3867 stay excluded, with the
  fixture encoding the real per-id exclusion mechanism (Correction 1 above).
- boots/starters partitions unaffected; `itemsSampleSize` is the denominator.

Plus 7 direct `rankSupportFinals` unit tests (empty, no-family, ignores non-family, sorts an
adversarially-ordered input, non-mutating, no self-cap, `isSupportFinalItem` boundary).

`components/__tests__/itemSetsApply.test.ts` — 1 new: exactly one final reaches the Pro build line,
it *is* present (the non-regression half), and the share-desc invariant still holds.

### Live-metadata runtime probe (throwaway, deleted after running)

Drove the reported shape through the real aggregation using the **actual live `item.json`**, not a
hand-written fixture:

```
items      : [ "Shurelya's Battlesong 100%", 'Locket of the Iron Solari 100%',
               "Mikael's Blessing 100%", 'Dawncore 100%' ]
boots      : []
starters   : [ 'World Atlas 100%' ]
supportTop : Zaz'Zak's Realmspike 80%
supportAlts: [ 'Solstice Sleigh 20%' ]
```

Exactly the reported symptom, gone: one slot, honest 80/20, 3866/3867 absent from every list, World
Atlas still a starter.

---

## Gate result — `verify-fix.sh`, verbatim

```
=== verify-fix: coachbuild ===

  [PASS] tsc -b clean
  [PASS] lint clean (warnings: 0)
  [PASS] tests 1618 passed
  [PASS] build clean
  [PASS] sw (public/sw.js) versioned via ?v= registration param (side cache coachbuild-icons-v1 is deliberately unversioned)
  [PASS] manifest present (public/manifest.webmanifest)

verify-fix: ALL CHECKS PASSED
```

*(Re-run after the doc-only `supportItem.ts` edit — see the final run in the session log.)*

---

## What I did NOT verify

**No browser smoke test.** The repo has **zero `.test.tsx` files** — component rendering is
deliberately untested here (vitest 4's oxc transform can't parse JSX outside its default scope, a
constraint `proConsensus.ts`'s own header documents), so there was no render-test harness to extend.
Reproducing the visual on a dev server would also need a live `/api/pros` sample that actually
contains two finals for one champion, which I can't force locally. The JSX compiles (`build clean`)
and the model layer is pinned by the live-metadata probe above, but **`SupportFinalStackTile` has not
been seen rendered.** Worth one puppeteer pass on a support champion before ship.

---

## ALSO REPORTED — family-duplication on other surfaces (NOT fixed)

**Separate ship decision.** Headline: **nothing in `lib/` or `components/hextech/` de-duplicates by
upgrade family except today's two fixes.** Every other guard is exact-id only. The family is kept off
those surfaces today purely by the missing `itemType: 3` request (Correction 2), which is *not* a
correctness guard.

| Surface (file · symbol) | Status | Mechanism |
|---|---|---|
| `lib/recommend.ts` · `buildRecommendations` | **POSSIBLE in code**, unreachable today | Dedup is exact-id only in three places — `usedItems`, `pathItemIds`, `usedM` (all `Set<number>` of raw ids). A 3870 in the slot-1 pool and a 3871 in the slot-2 pool both clear every filter. Nothing in the file knows 3867 exists. |
| `lib/buildSlotCap.ts` · `capExtraFullItems` / `fullItemCapForRole` | **Cannot help** | Generic `<T>`, only `.slice(0, budget)` — a *count* cap, never inspects ids. Worse: `fullItemCapForRole` returns 4 for role 4 *because it assumes the final is absent from the list* ("surfaced separately by SupportItemCard"). If a final ever appears inline, that reservation double-counts. Structurally the right choke point, but it has no family logic to lean on. |
| `components/hextech/itemSetBody.ts` · `buildLine` | **POSSIBLE in code** | The "no duplicates" invariant is `dedupeById` — exact ids. The only *grouped* concept is `bootsIds`. Two finals are, to `buildLine`, two ordinary distinct full items; the padding loop's `used.has(id) \|\| bootsIds.has(id)` skip passes the second one. |
| `itemSetBody.ts` · `isFullItem` | **Deliberately admits the family** | The `from.length === 0` clause in the lane-starter rule is documented as load-bearing precisely so the 400g `Lane`-tagged finals stay full items (they're built *from* World Atlas). Confirmed live: all five return `true`. |
| `itemSetBody.ts` · Core / Buy order / Highest WPA | **POSSIBLE if type-3 lands** | `themedUnion = unionPool(corePrimary, optimizedPrimary, situationalPoolFull, proPool)` could then hold two or three finals at once (one from core, one from alts, one from pro) and emit them side by side. |
| `itemSetBody.ts` · Situational swaps block | **Weakest surface** | `situationalPicks.slice(0, SITUATIONAL_CAP).map(itemRef)` runs on raw `flattenSituational` output with **no** `isFullItem` filter, no `bootsIds` handling, no family dedup — all documented as intentional ("swap SUGGESTIONS, not a worn loadout"). Defensible for boots; **wrong for this family** — you can't swap between 3870 and 3871, you can only ever have built one. |
| `itemSetBody.ts` · archetype lines (`TANK_PURE`) | **Latent** | All five carry `Health` and no damage tag → all five match `TANK_PURE`, and `categoryDefaultPool` sweeps them in. Today they sort last (gold desc, 400g) and `curatedFill`'s 8 valid Tank ids are reached before `catalogFill` — unreachable **by arithmetic, not by a guard**. A partially-loaded `itemMeta` that drops enough curated Tank ids would pad two 400g finals into a Tank line. Precedent exists: `categoryDefaultPool`'s own `metaHasTag(m, "Boots")` early-return was added because catalog fill previously leaked a second pair of boots. |
| `components/hextech/situational.ts` · `flattenSituational` | exact-id only (`seen: Set<number>`) | Shared root of both the LCU Situational block and the web card. |
| `CoreBuildOrderCard.tsx`, `ItemPath.tsx`, `SituationalCard.tsx`, `live/LivePanel.tsx` + `live/compHighlight.ts` | all exact-id at best | Render `items.first/second/third/fourthPlus/alts` (and `alts.*`) verbatim; `selectCompAwareHighlights` is contractually a *reorder*, so it inherits and can promote a second final to the front. |
| `components/hextech/supportItem.ts` · `findSupportFinalInBuildData` | **Correct by construction** | Scans every slot and returns the single highest-`wpa` match — collapses to one. The only build-page reader that already understands the family. |
| Pro Consensus card + LCU Pro build line | **FIXED today** | Real guard: `aggregateProConsensus`'s `isSupportFinalItem` partition + `resolveProConsensusForSets` folding only `supportFinals.top`. Note the guard lives *entirely upstream* — any future caller hand-constructing `ProConsensusItemsInput` reopens it, which is why I added that warning to the shape's doc comment. |

### If someone adds the `itemType: 3` fetch tomorrow

In severity order: (a) `recommend.ts`'s slot loops emit two finals into `first`/`second`/
`fourthPlus`/`alts`; (b) `buildSlotCap.ts`'s support budget of 4 becomes wrong because its
reservation assumption is violated; (c) `CoreBuildOrderCard`, `ItemPath`, `SituationalCard` and the
LCU `Core build` / `Buy order` / `Highest WPA` / `Situational swaps` blocks all render both;
(d) `SupportItemCard` starts showing `measured: true` for one final while the core order shows a
different one — a **visible self-contradiction on the same page**. Only the Pro Consensus card and
the LCU Pro build line stay correct.

**Recommendation for the separate ship:** the fix is cheap and already built — `isSupportFinalItem`
is pure, id-only and needs no metadata, so `rankSupportFinals` (or just the membership test) can drop
straight into `flattenSituational`'s `seen` loop and `recommend.ts`'s `usedItems` gate. Doing it
*before* anyone adds the type-3 fetch is far cheaper than after.
