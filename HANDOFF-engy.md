<!-- merged into HANDOFF.md 2026-07-29 11:36:47Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engy, 2026-07-29 (signal layer: OTP cascade, competing slots, snowball stacks)

Scope owned: `lib/**` and non-JSX `.ts` under `components/`, plus tests. No `.tsx` touched.

**Gate:** `npx tsc -b` clean. `npx vitest run` → **136 files, 2068 tests, all green**
(2067 before this pass). `npx next lint` → pre-existing `<img>` warnings only, no errors.

---

## 1. The OTP line padded itself with pro items

`components/hextech/itemSetBody.ts`. The comment above the OTP push site claimed
`proPool` was not in that line's cascade; the code passed `generalFallback`, which
contains it. The claim was the right rule and the code was the wrong implementation.

### Measured damage — the numbers, not an estimate

Harness drove the **real `buildItemSets`** against live prod (`/api/build` + `/api/pros`
+ `/api/otp`) plus the live 16.13.1 catalog, over **every champion+role in
`coachbuild.otp_matches` that holds any OTP games — 218 combos.** Slot attribution is
the cascade order itself (otp → optimized → situational → pro → core), so a slot counts
as pro-sourced only when nothing earlier in the cascade could have supplied it.

| | value |
|---|---|
| OTP slots emitted | 1,307 |
| slots sourced from `proPool` | **17 (1.3%)** |
| lines with >=1 pro-sourced slot | **11 of 218 (5.0%)** |
| lines that pad at all (any source) | 66 of 218 (30.3%) |
| avg pro-sourced slots per line | 0.078 |
| worst line | **3 of 6 slots** — Draven Mid, 1 stored game |

Broken out by how much one-trick data the champion actually has:

| stored OTP games | lines | pro-padded lines | pro-sourced slots |
|---|---|---|---|
| >=50 | 81 | **0** | **0 of 486** |
| >=20 | 121 | 1 | 2 of 726 |
| <20 | 97 | 10 (10.3%) | 15 of 581 |

**The brief's framing was too strong and this is the honest correction.** It is not
"routine" padding and the OTP block was not drifting toward the Pro block by
construction. Every one of the 11 affected lines is a thin-sample champion. The reason
is cascade ORDER, not any guard: `optimized` and `situational` sit ahead of `proPool`
and the situational pool carries a median of 7 full items, so it absorbs nearly every
shortfall first. That is luck rather than design — it made the failure rare and
invisible, and concentrated it exactly where the OTP sample is thinnest and a false
"OTP build" label costs the most.

Every affected line, before the fix:

```
Fiora Bot        (28 games)  2/6 slots  Stormrazor, Endless Hunger
Mordekaiser Jgl  (13 games)  1/6        Dusk and Dawn
Fizz Bot          (7 games)  1/6        Void Staff
Akshan Sup        (6 games)  1/6        Boots of Swiftness
Zyra Mid          (4 games)  2/6        Rylai's, Void Staff
Ivern Sup         (4 games)  1/6        Knight's Vow
Aphelios Top      (2 games)  1/6        Phantom Dancer
MasterYi Mid      (2 games)  1/6        Wit's End
Brand Jgl         (2 games)  2/6        Liandry's, Zhonya's
Zed Bot           (1 game)   2/6        Serpent's Fang, Lord Dominik's
Draven Mid        (1 game)   3/6        Bloodthirster, Gunmetal Greaves, Infinity Edge
```

Most real OTP padding is **the boots slot**, not items: every Bot-lane one-trick line
with a full six-item OTP pool still reaches outside it for footwear, because
`aggregateProConsensus` returns up to 6 items + 2 boots and the boots half is often empty.

### The change

New `otpFallback = [optimizedPrimary, situationalPoolFull]` — `generalFallback` minus
`proPool`. `corePrimary` still appended LAST (the Yuumi Support defect: it is the only
pool guaranteed to carry `items.boots`). The champion's own WPA pools stay in: they are
not a rival population's build, they are the same champion's model-ranked data.

`buildLine` already ships short rather than inventing when the pools cannot reach six
(its step 4) — verified live, not assumed: Camille Mid already emitted a 5-item OTP line
before this change.

### Re-measured after the fix

The 11 affected combos, re-run through the same harness: **0 pro-sourced slots on all
11.** Aphelios Top now honestly emits **5 items instead of a padded 6** — the intended
behaviour change. The others refill from the champion's own core/situational pools.

### Mirror problem on the Pro line — checked, does not exist

`otpPool` has never been in `generalFallback`, so the Pro line cannot reach it. Pinned by
a test rather than left as an assertion. **No change made.** The `buildItemSets` doc
comment did claim a symmetry ("each pads via … the other consensus") that was false in
BOTH directions; that doc now writes out all four cascades exactly.

---

## 2. Mutually exclusive items now share ONE slot

**The contract was already in the tree**, uncommitted, from the round that was stopped:
`lib/buildSlots.ts` + `lib/__tests__/buildSlots.test.ts` +
`components/hextech/buildSlotView.ts` + `BuildSlotList.tsx`, with three live callers
(`proConsensus.ts`, `lib/otp/featuredBuild.ts`, `FeaturedOtpCard.tsx`). It implements
`BuildSlot`/`BuildSlotOption` with exactly the field names and semantics the brief
specifies. I kept it and hardened it rather than rewriting — replacing a measured, tested
module the frontend already codes against would have been churn, not correctness.

### Exported signatures (unchanged, as briefed)

```ts
export interface BuildSlotOption { itemId: number; games: number; pct: number; }
export interface BuildSlot { primary: BuildSlotOption; alternatives: BuildSlotOption[]; sampleGames: number; }

export function resolveBuildSlots(
  gameItems: readonly (readonly number[])[],
  sampleGames: number,
  opts?: { include?: (itemId: number) => boolean; maxSlots?: number; maxAlternatives?: number; minPct?: number }
): BuildSlot[];
```

`sampleGames` is a REQUIRED parameter, not derived from `gameItems.length`: it must be
the same denominator the rest of the card quotes, or a slot's "46%" and the item list's
"46%" describe different populations. That divergence is the v0.73.1 class of bug.

### Thresholds, and one deviation from the brief

| constant | value | why |
|---|---|---|
| `COMPETES_MAX_LIFT` | 0.35 | measured; sits in an empty quarter of a bimodal distribution over 193 pairs |
| `MIN_EXPECTED_COOCCURRENCE` | 3 games | the honesty guard — "never together" means nothing when chance expects 0.9 |
| `MIN_SAMPLE_GAMES` | 20 item-bearing games | **added this pass** — see below |
| `DEFAULT_MIN_PCT` | 15% | equal to the band the threshold was measured over; lower extrapolates past the evidence |

**DEVIATION, stated plainly: the module uses LIFT, not the joint rate the brief named.**
Lift = observed_together / expected_together_if_independent. The brief's joint rate
(Jaccard) separates the same two populations on this corpus, and every pair it found (all
at exactly 0 co-occurrence) has lift 0 and is caught here too — nothing is lost. Where
they disagree, lift is the STRICTER of the two:

```
A in 50% of games, B in 50%, together in 10%   joint 0.11 "competing"   lift 0.40 not competing
A in 20%,          B in 20%, together in  2%   joint 0.05 "competing"   lift 0.50 not competing
```

In both, the items co-occur about as often as chance predicts, and the joint rate calls
them exclusive only because they are not built that often in absolute terms. Grouping two
items that genuinely stack is a fabrication — the build then shows five items where the
player buys six — so the measure that refuses those cases is the right one. Both
statistics and the reasoning are written into the module header.

**`MIN_SAMPLE_GAMES = 20`, added this pass, is the floor the brief asked to be stated.**
Be clear about what it is: the statistical work is done by `MIN_EXPECTED_COOCCURRENCE`,
which is per-pair and strictly better than any blanket sample size. This floor earns its
place on one case the pair guard lets through — 10 games with A in 6 and B in 5 expects
exactly 3 shared games (clears the guard) while pigeonhole FORCES them to share at least
one, at which point lift is 0.33 and a contested slot appears out of arithmetic rather
than behaviour. That pigeonhole floor is scale-invariant, so no larger number fixes it;
20 is a product judgement ("not enough games to have an opinion"), not a significance
test, and it is documented as such.

### Tie-break, documented as asked

An item mutually exclusive with two primaries attaches to the **more-built** one. Greedy,
highest build rate first, so the assignment is deterministic and the stronger claim wins.
Pinned by a test. Two known limitations are written into the module header rather than
hidden: the loser of a greedy claim can render as "settled" when it does have a
competitor, and a three-way tie has no meaningful go-to (Shen live: 18/18/17%).

### Verified against live data, per champion AND role

Ran the real `resolveBuildSlots` over every champion+role in `otp_matches` with >=40
stored games (**97 combos**): **87 of 413 slots contested (21.1%), on 63 of 97 combos
(64.9%).** The user's own example resolves exactly as he described it:

```
Ahri Mid (n=102)
  [Malignance 70% | Blackfire Torch 25%]   <- the either/or he named
  Zhonya's Hourglass 34%                   <- companion of Malignance, kept apart
  [Lich Bane 29% | Cosmic Drive 26%]       <- a second either/or
  Shadowflame 26%                          <- companion of Blackfire, kept apart
```

It also generalises two fixes this repo previously made by ENUMERATION, without being
told about either: support-quest finals (Maokai Support returns
`[Solstice Sleigh 67% | Celestial Opposition 29%]`) and split boot preferences.

The brief's methodology warning is now in the module header as a rule on callers: mutual
exclusivity is per champion **and role**. Note `scripts/measure-item-cooccurrence.mts`
(the threshold probe, already in the tree) groups by CHAMPION only — fine for a
distribution-shape question, but its per-champion slot output must not be read as what a
surface would render.

---

## 3. Mejai's on the WPA (Build) tab

### Which code path it was

`lib/recommend.ts`, and it is **not** the path v0.76.0 touched. The Pro and OTP tabs
aggregate stored games client-side through `proConsensus.ts`; the WPA build is assembled
server-side from coachless's own WPA-ranked pools. Mejai's reached it as a **per-slot
situational SWAP** (`items.alts.*`), which is why reading first/second/third could not see
it. Measured on prod before the fix:

```
Ahri Mid    alts.second  Mejai's  wpa 1.393   8,149 games  78.5% wr
            alts.third   Mejai's  wpa 0.827  13,948 games  78.4% wr
Annie Mid   alts.second  Mejai's  wpa 3.543     915 games  82.0% wr
Veigar Mid  alts.third   Mejai's  wpa 2.910     715 games  81.5% wr   (TOP of the row)
```

### The fix

One filter, at the pool boundary right after `collapseSupportFinalPools`, reusing
`isSnowballStackItem` from `lib/snowballStacks.ts`. No second list, no second mechanism.

- **One place:** `bestItem`, `topItems` and `itemAlts` all draw from these same pools, so
  it covers the core order, `fourthPlus` and every situational-swap list at once.
- **Before every truncation:** `itemAlts` slices to 3 and `capExtraFullItems` caps the
  tail. Filtering after either would leave a short list with a hole instead of promoting
  the next real item. Pinned by its own test.
- The sequential optimizer and the (dormant, 403) matchup path perform their **own**
  `getGlobalItemStatistics` fetches and never pass through that boundary, so both are
  filtered at their own call sites. Also pinned by a test.
- **`starterData` is deliberately NOT filtered.** Dark Seal (1082) is in the snowball
  family and is a genuine opening purchase; the directive is about build slots, not
  openers. Two tests pin that it still wins the Starting slot when the sample says so AND
  is still excluded from every completed slot.

New file `lib/__tests__/snowballStackBuild.test.ts` (7 tests). **Verified they fail
without the fix**: temporarily neutering `dropSnowballStacks` fails 5 of 7, and the 2 that
still pass are exactly the Dark Seal opener tests — they pin unchanged behaviour, which is
the point.

### Grep audit: no other surface surfaces a snowball stack in a completed slot

Three production call sites, one list, no hardcoded ids anywhere else:

```
lib/snowballStacks.ts:75                      isSnowballStackItem       <- the only rule
lib/recommend.ts:384                          WPA build pools           <- new this pass
components/hextech/proConsensus.ts:996,1042   Pro + OTP consensus       <- v0.76.0
lib/otp/featuredBuild.ts:139                  featured one-trick card   <- v0.76.0
```

`grep -n '\b(3041|1082)\b'` across `lib/` + `components/` + `app/` finds the ids only in
`snowballStacks.ts` (the list), `startingItems.ts` (Dark Seal's pre-existing starter
allowlist entry, correct), doc comments, and tests. Nothing else.

Remaining producers of completed-item lists, and why each is covered:

- `components/hextech/itemSetBody.ts` — no snowball guard of its own and does not need
  one: every pool it reads is now clean at source (BuildResponse from `recommend.ts`,
  pro/OTP inputs from `proConsensus.ts`). Confirmed empirically as well as structurally —
  **0 of 218 live OTP blocks contained Mejai's even BEFORE this pass**, because
  `proConsensus` already dropped it.
- `lib/buildSlots.ts` — its `include` default was `() => true`, so a caller passing raw
  `final_items` with no predicate would have surfaced Mejai's. All three live callers do
  pass a correct classifier, but I made the exclusion **unconditional** inside the
  function (ANDed with the caller's predicate) so the default is safe rather than merely
  unused. Same import, same list. It cannot regress Dark Seal's opener row: this module
  has no opener concept and never produces one.
- `lib/heroStats.ts`, `lib/patchMovers.ts` — fetch `itemType 6` (starters) only, for
  win-rate maths. No build slots.

---

## OPEN — a real live defect found while measuring, NOT fixed (out of brief)

**`3172` Gunmetal Greaves is a tier-3 boot enchant that ddragon does not tag as boots.**
Live 16.13.1 catalog:

```
3168 Immortal Path           tags ["LifeSteal","SpellVamp","Boots"]              from ["3008"]
3170 Swiftmarch              tags ["Boots"]                                       from ["3009"]
3171 Crimson Lucidity        tags ["CooldownReduction","Boots"]                   from ["3158"]
3175 Spellslinger's Shoes    tags ["Boots","MagicPenetration"]                    from ["3020"]
3172 Gunmetal Greaves        tags ["AttackSpeed","LifeSteal","NonbootsMovement"]  from ["3006"]   <- no "Boots"
```

Every tags-based boots check in the app therefore misclassifies it as an ordinary full
item: `proConsensus.ts`'s `isBootsTag`/`isBootsFinal` file it into `items` instead of
`boots`; `itemSetBody.ts`'s `collectBootsIds` never learns the id, so `buildLine`'s
one-boots rule cannot see it; `featuredBuild.ts`'s `classifyFeaturedItem` returns
`completed`.

Observed live, not theorised: the Draven Mid OTP line shipped **Swiftmarch AND Gunmetal
Greaves in one six-slot loadout** — two pairs of boots, the exact bug the v0.34.1
restructure exists to prevent. (That specific instance disappeared with the Task 1 fix
because Gunmetal Greaves arrived via `proPool`; the underlying misclassification is
untouched and will resurface anywhere else the id appears.)

Not fixed here because there is no single choke point — three independent classifiers own
"is this boots" (`proConsensus.isBootsTag`/`isBootsFinal`, `itemSetBody.collectBootsIds`,
`featuredBuild.classifyFeaturedItem`) and a correct fix is a shared rule across files
another agent is editing in parallel. Minimal fix: an id override beside the boots check,
in the shape of gotcha (e)'s rune-icon exceptions, plus a catalog probe on every patch
bump. Same class as gotcha (y): curated/tag-derived item facts rot silently.

## Cleanup owed

The safety gate blocked file deletion (it points at a dead `S:/AI/urgot` path), so seven
untracked scratch harnesses are still in `scripts/`, all prefixed `_tmp-`:
`_tmp-probe.mjs`, `_tmp-probe-mejais.mjs`, `_tmp-probe-boots.mjs`, `_tmp-summarize.mjs`,
`_tmp-summarize2.mjs`, `_tmp-measure-otp.mts`, `_tmp-validate-slots.mts`. None is imported
by anything. Delete before commit. (`scripts/measure-item-cooccurrence.mts` is NOT one of
mine — it is the threshold probe the module header cites and should stay.)

## Wiki

No `wiki/` directory in this project. Proposed CLAUDE.md updates:

- Data pipeline map: add `lib/buildSlots.ts` — measured mutual-exclusivity grouping
  (lift-based), consumed by Pro Consensus, the featured one-trick card, and the OTP card.
- New gotcha: ddragon's `tags` are not a reliable boots signal — `3172` Gunmetal Greaves
  is a tier-3 boot with no `Boots` tag (see OPEN above).
- Near gotcha (dd): the OTP item-set line pads from `otpFallback`, NOT `generalFallback`;
  all four cascades are written out in `buildItemSets`'s doc comment.

---

# Boots classification fix — 3172 Gunmetal Greaves (engy, 2026-07-29, second pass)

Closes the OPEN item above ("ddragon `tags` are not a reliable boots signal"). Scope was
`lib/**` and non-JSX `.ts` under `components/`; no `.tsx` touched.

## What the live catalog actually says

Probed ddragon **16.15.1** directly (2026-07-29) by walking the full transitive `into`
closure from `1001` Boots — 20 items — plus a global scan for `Boots`- and
`NonbootsMovement`-tagged ids outside it.

| tier | ids | `Boots` tag? |
|---|---|---|
| 1 | 1001 | yes |
| 2 | 3005, 3006, 3008, 3009, 3010, 3020, 3047, 3111, 3117, 3158 | yes, all |
| 3 | 3168, 3170, 3171, 3173, 3174, 3175, 3176 | yes, all |
| 3 | **3172 Gunmetal Greaves** | **NO** |

`3172` is `{ tags: ["AttackSpeed","LifeSteal","NonbootsMovement"], from: ["3006"], into: [],
purchasable: true }`. The catalog contradicts itself — a `NonbootsMovement` tag on a boot.
**It is the only gap in the family**; the previous agent's report was correct and complete
on that point. `3010/3013/3117/3176` are `purchasable: false` and are excluded upstream
anyway.

Outside the tree, `Boots`-tagged ids exist but are not Summoner's Rift build items:
`1111` Jarvan I's, `2422` Slightly Magical Footwear, the `223xxx`/`771xxx`/`773xxx` mode
variants, and the `550xxx` debug items (which carry *every* tag, `Boots` and `Consumable`
both). All have `from: []`, so they fail the final-boots rule exactly as they did before —
behaviour unchanged, deliberately.

## Live exposure — this was never a Draven-only edge case

Swept prod `/api/pros` and `/api/otp` over 23 champions x 6 roles. **18 feed/role combos
carried 3172.** Worst:

| champ/role | 3172 build rate | other boots in sample |
|---|---|---|
| **Yone mid** | **178 / 200 (89%)** | 3173 x8, 3174 x7, 3168 x1, 3006 x1 |
| Yasuo mid | 132 / 200 (66%) | 3170 x24, 3174 x18, 3173 x15 |
| Yone bot | 112 / 200 | 3006 x59, 3173 x4, 3174 x4 |
| Vayne mid | 20 / 31 | 3168 x4, 3170 x4 |
| Tryndamere mid | 11 / 13 | 3168 x1 |

So on Yone mid the champion's *actual* boot was absent from the boots slot, was eating a
completed-item slot, and was invisible to the one-boots invariant simultaneously.

**Draven mid did NOT reproduce** on the current feed: `/api/otp?championId=119&role=2`
returns one game with items, holding 3170 and no 3172. The reported symptom is real as a
mechanism and the feed has simply moved since it was measured. Reported as a data point,
not a contradiction.

**The WPA line is unaffected.** coachless never surfaces 3172 in any `ItemsBlock` — checked
26 champion/role combos via prod `/api/build`, zero hits, so `items.boots` and the legendary
slots were never involved. The exposure was entirely Pro/OTP consensus and the featured card.

## The shared predicate

**`lib/bootsItems.ts`** — `isBootsItem(itemId, meta, catalog?)` and
`isFinalBootsItem(itemId, meta, catalog?)`. Two functions, not one, because the codebase
genuinely asks two questions: partition ("which grid slot", includes tier-1 1001) vs
completed-item ("is this a finished pick", excludes 1001 via `from.length > 0`). That split
pre-dates this change — it is why proConsensus needed both `isBootsTag` and `isBootsFinal`.

Rule: **Boots-tagged, OR anything it is built FROM is boots** (recursive over `from`, depth
cap 6, cycle-guarded). Every boot descends from 1001, which is tagged, so the recipe chain
is the anchor and a missing tag above tier 1 is self-healing. Measured over the entire live
catalog, the ancestry clause reclassifies **exactly one** item — 3172 — and zero others.

`BOOTS_ID_EXCEPTIONS = {3172}` is kept as the **degradation path, not decoration**: the
ancestry clause needs the PARENT in a catalog map, and two call sites cannot always supply
one (`FeaturedOtpCard.tsx`'s include predicate passes no map; a stale localStorage entry
normalizes to `from: []`). Without the pin the bug would silently return on those paths only
— the worst kind, since the others would still be right. Documented per-entry with what the
catalog says vs what is true, in the style of `lib/snowballStacks.ts`.

## Call sites now routed through it

| file | was | now |
|---|---|---|
| `components/hextech/proConsensus.ts` | private `isBootsTag` (5 sites) + `isBootsFinal` | both **deleted**; `isBoots(itemId)` closure -> `isBootsItem`, `isBuildItem` -> `isFinalBootsItem`. `isBuildItem` takes an optional 3rd `catalog` arg (back-compatible). |
| `lib/otp/featuredBuild.ts` | `tags.includes("Boots") && from.length > 0` | `isFinalBootsItem`; `classifyFeaturedItem` takes an optional 3rd `catalog` arg, and `buildFeaturedView` passes its `meta` map. |
| `components/hextech/itemSetBody.ts` | `isFullItem`'s inline tag check | `isFinalBootsItem`, with `itemMeta` threaded through `fullItemsOnly`. |
| `components/hextech/itemSetBody.ts` | `collectBootsIds` — **positional only** | positional sources **plus** a classified pass over every candidate id. See below. |

### `collectBootsIds` is the fix that closes the class, not just the instance

`collectBootsIds` was never a tag classifier — it collected ids from slots the contract
already *calls* boots (`items.boots`, `alts.boots`, `pro.boots`, `otp.boots`). That is
exactly why the two-boots line shipped: 3172 was partitioned upstream into `pro.items`/
`otp.items`, so it reached the set through no boots slot at all and `buildLine` counted it
as a full item.

Fixing the upstream partition removes today's instance. It does not remove the class — the
invariant would still be resting on a producer being right. So `collectBootsIds` now unions
the positional sources with `isBootsItem` run over **every candidate id from every pool**
(core picks, optimized path, situational, pro entries, OTP entries). The two sources fail in
opposite directions and both are kept on purpose: positional survives a total metadata-fetch
failure, classified survives a wrong upstream partition. `bootsIds` moved down in
`buildItemSets` so it runs after every pool exists; it is not read until the `buildLine`
calls far below, so the move is order-safe.

## Tests — `lib/__tests__/bootsItems.test.ts`, 28 tests

Fixtures are the **verbatim live 16.15.1 catalog records** for 31 ids (real recipes, tags,
gold). Load-bearing twice: 3172's exact tag list *is* the bug, and the negative controls
(3046 Phantom Dancer, 3086 Zeal, 3041 Mejai's) only prove anything because they carry the
real `NonbootsMovement` tag that must never be read as a boots signal.

Covers: every tier-2 and tier-3 boot classified both ways; 3172 by ancestry AND by pin with
no catalog; tier-1 1001 boots-but-not-final; no over-reach onto `NonbootsMovement` items or
boot components; a wrecked localStorage-shaped `ItemDetail`; all three call sites agreeing;
the top-three-boots slot seeing 3172; the two-boots line reduced to one; the invariant on
*every* emitted block; the Yuumi no-tracked-boot defect still fixed; never-invent-boots.

**Mutation-verified, not assumed** (each mutation applied, suite run, then reverted):
- tag-only rule + no exceptions + no ancestry -> **7 tests fail**
- `collectBootsIds` classified pass removed -> **2 tests fail** (both two-boots tests)
- plain-literal second predicate re-added to `featuredBuild.ts` -> **guard test fails**

The first version of the two-boots assertions was **circular** — it filtered the emitted ids
with `isBootsItem`, the very predicate under test, so mutating the predicate moved code and
assertion together and the test stayed green while the app shipped two boots. Caught by the
mutation run and rewritten against a hardcoded `REAL_BOOTS_IDS` list. Worth remembering: an
invariant test must not use the classifier it is guarding.

The no-second-predicate guard is a source-text regex over 10 consumer files (comments
stripped). **What it cannot see, stated plainly:** it catches the form a developer would
actually write (`tags.includes("Boots")`) and not a deliberately obfuscated one — both were
mutation-tested; the plain literal fails, a `String.fromCharCode`-built one does not. The
defended failure mode is honest copy-paste, not sabotage.

## Verification

`npx tsc -b` clean. `npx vitest run` — **137 files, 2096 tests, all passing**, including the
pre-existing "a line with 2 boots" regression in `components/__tests__/itemSetBody.test.ts`
and all of `proConsensus.test.ts`.

## Not done / for someone else

- **`components/hextech/FeaturedOtpCard.tsx:392`** calls
  `classifyFeaturedItem(id, meta.get(id))` with no catalog. **Correct today** — the pinned
  exception covers 3172 on that path — but it is the one call site running the weaker rule,
  so a *future* untagged boot would slip through there and nowhere else. One-line fix
  (pass `meta` as the 3rd arg). `.tsx`, so out of my scope; flagged for fronty.
- Not verified in a browser. The change is pure-function and covered by unit tests over real
  catalog data; no puppeteer/prod smoke was run.
- `3010` Symbiotic Soles / `3013` / `3176` Forever Forward are `purchasable: false` in
  16.15.1 and so are excluded from every completed-item list. If that line is meant to be
  buyable, this is a separate (pre-existing) defect — noticed while sweeping, not
  investigated.

### Wiki / CLAUDE.md proposals
- Add a gotcha: **"ddragon's `Boots` tag is not complete — 3172 Gunmetal Greaves lacks it.
  Never write a boots check; call `lib/bootsItems.ts`."** Pairs with existing gotcha (y)
  (curated item ids rot every patch) and (dd) (a second copy of a rule misses the next fix).
