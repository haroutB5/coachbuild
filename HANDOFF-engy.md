<!-- merged into HANDOFF.md 2026-07-29 17:53:33Z; previous content preserved there. Append new rounds below. -->

# engy — alternative keystone surfaced on the Runes card (2026-07-29)

No version bump, no deploy, no commit — as instructed.

## What shipped

The Builds page rendered `data[0]` and discarded the rest of `/api/build`'s array.
`lib/recommend.ts`'s header states the contract — *"Returns the TOP 3 viable setups…
Variants prefer different primary trees"* — so the engine's entire design for "a genuinely
different keystone exists" is *put it in a later variant*. v0.51.0 deleted the consumer while
the engine kept relying on it.

Now, when it qualifies, the Runes & Summoners card carries a **NOT PICKED — SCORED HIGHER**
block: the withheld keystone's icon, name, tree, sample and WPA, plus a footnote. Tapping it
opens the same rune-detail popover every other rune on the card uses — the user asked for
enough to "decide to pick it or not", and that needs the rune's text, not just its score.

**Nothing about the ranking changed.** `builds[0]` is still the recommendation on every card,
unconditionally. No engine file was touched.

Files:

- `components/hextech/altKeystone.ts` — NEW. Pure `resolveAltKeystone(builds)`. All the
  reasoning and measurements live in its header.
- `components/hextech/__tests__/altKeystone.test.ts` — NEW, 29 tests. (Confirmed the new
  nested `__tests__` dir is actually collected by `vitest.config.ts`'s glob — `npx vitest list`
  reports the file and its 29 cases. CLAUDE.md flags this as a past silent-miss.)
- `components/hextech/BuildTabContent.tsx` — resolves the alternative ONCE at fetch time into
  `FetchState`. The full `BuildResponse[]` is deliberately NOT held in state (see "coupled
  defect" below).
- `components/hextech/RunesSummonersCard.tsx` — `AltKeystoneNote`, plus an optional
  `altKeystone` prop.

`/compact` renders this same card off `variants[0]` and passes nothing, so that surface is
byte-identical. Same for the `null` case on the Builds page: no empty slot, no reserved height.

## The predicate, and why it is not the one the brief suggested

Fires iff **(1)** shown keystone WPA `< 0`, **(2)** alternative WPA `> 0`, **(3)** gap `> 0.04`,
**(4)** the alternative cleared the engine's adoption bar (`!lowSample`).

**(1)+(2) make it a sign flip, and that is the load-bearing choice.** Per the investigation's
own caveat, coachless's per-rune WPA figures are marginal contributions measured inside their
own rune pages, not terms on a shared scale — so "+2.50 is 2.77 better than −0.27" is not a
statement the data supports, and any predicate keyed on gap SIZE quietly asserts it. Which side
of zero a reading falls on is a property of the one number, so the card can say "this one is
above zero, the pick is below" and stop. This is also why nothing in the UI sums, diffs or bars
the two numbers, and why the footnote says so explicitly.

Measured over the 500 champion/role pairs with ≥2,000 games (patch 16.13, tiers [5,6,7], the
app's own default request), by re-running the investigation's sweep:

| predicate | fires | of all cards |
|---|---|---|
| `alt.wpa > shown.wpa` (bare) | 146 | 29.2% |
| `alt.wpa > 0 AND gap > 0.04` | 144 | 28.8% |
| shown renders red AND alt renders green | 78 | 15.6% |
| **sign flip + gap > 0.04 (chosen)** | **83** | **16.6%** |

The 29% predicates fire on cases like Amumu SUP (+0.376 shown, +0.416 alternative on 1,022
games) — the pick is already good and the difference is not decision-relevant. That is a
permanent second block on a third of all cards during a 30-second champ select, which is how
this stops reading as an exception. The "renders red" variant (`wpa < -0.02`, wpaClass's red
cutoff) is a strict SUBSET of the chosen one — **measured: zero cases fire it that the sign flip
does not** — and it drops **Caitlyn BOT**, whose −0.011 sits in wpaClass's neutral-grey dead
zone while a +0.807 First Strike on 65,776 games goes unrendered. Hence: trigger on the SIGN of
the number, not the colour it prints.

83/500 is exactly the class the investigation identified, arrived at independently.

**(3) is a display-integrity guard, not a filter.** `wpaText` rounds to 2dp, so two readings
within 0.01 print identically; a card claiming one is higher while showing the same string twice
is a visible lie. Measured: the guard excludes **zero** of today's 83 cases. It exists for the
day the data produces a hairline flip.

**(4) is defensive and currently always-true.** `pickRecommended` only selects a keystone out of
`adopted` (`occurrence >= bar`), so every variant keystone clears the bar by construction.
Verified rather than assumed — swept all 319 pairs that have a distinct alternative keystone,
**zero below the bar**. Kept because the card makes an adoption claim and a claim should rest on
a check.

### The brief's suggested predicate is wrong, and it fails on the brief's own headline case

The brief proposed `builds[1].keystone.wpa > builds[0].keystone.wpa`. `primaryConfigs` is ordered
by raw tree adoption, so `builds[1]` is the **second-most-played tree** — which has no
relationship to which withheld keystone is best. Real `buildRecommendations`, run live:

```
JHIN BOT
  [0] Fleet Footwork   (Precision)   wpa -0.272   387,410 games
  [1] Dark Harvest     (Domination)  wpa -0.725   131,012 games   <-- WORSE than shown
  [2] Deathfire Touch  (Sorcery)     wpa +2.500    81,053 games   <-- the +2.500 the brief cites
```

A `builds[1]`-only read shows nothing on the app's most extreme case and hides +2.500 exactly as
before the fix. Across the 83 firing pairs, **the best alternative is not in `builds[1]` in 11 of
them**, and in 5 `builds[1]` is worse than what is already shown (Jhin BOT, Malphite SUP, Rumble
JG, Teemo MID, Ambessa TOP). So `resolveAltKeystone` scans every later variant and takes the best
qualifying WPA.

It also **dedupes on keystone id**: when fewer than 3 primary trees are viable,
`buildRecommendations` fills its remaining pages with secondary-tree variations of the top
config, and those pages carry variant #1's own keystone. Observed on Ziggs BOT [2], Caitlyn BOT
[2], Sylas MID [2], Ahri MID [2], Garen TOP [2], Lux SUP [2] — six of nine champions probed.
Without the id check the card would offer the user the rune it is already showing them.

## Selectable? NO — and explicitly so

**I did not make it selectable.** The brief's condition was "either wire it through consistently
or do not make it selectable", and consistent wiring is not reachable from this component:

- `GlobalNav/ApplyRunesButton.tsx` lives in `AppShell`, outside the Builds page tree, and
  deliberately resolves the **live champ-select** champion from `useCompanion()` rather than
  page state ("never from whatever champion happens to be showing on the current page" — its own
  header). It does its own `/api/build` fetch and takes `data[0]`.
- `components/live/AutoExporter.tsx` likewise writes `data[0]` to the LCU on champ-select
  resolution, app-wide, with no page in the loop at all.

So a selectable card creates two silent divergences, not one, and the auto-exporter's cannot be
fixed by wiring at all — it fires when no card is being looked at. A user who switched the card
and then hit the top-bar APPLY RUNES (or simply let auto-export run) would get the original page
while the screen showed the alternative. That is the worse defect the brief names.

The user's ask — *"just highlight it i guess and put its stats with it so i can decide to pick it
or not"* — is satisfied without it: they decide in champ select and set it in the client. If
selection is wanted later it needs a shared apply-target store that `ApplyRunesButton` and
`AutoExporter` both read, which is a real design change, not a prop.

## The coupled `bestAboveFloor` defect — decided BEFORE, and the investigation's framing corrected

**It does not bite in this design, and I did not change it.** The surface exposes only the
keystone, its WPA, its sample and its tree. All of that comes from `pickRecommended` over
`keystoneData`; the path never calls `bestAboveFloor`. `resolveAltKeystone` returns exactly
`{keystone, tree, variantRank}` and two tests pin that — one asserting the key set, one asserting
the sub-floor secondary runes present in the fixture never appear in the output. `BuildTabContent`
also does not retain the `BuildResponse[]`, so nothing downstream can reach for a second variant's
rows later.

**But the investigation's claim that the defect is "invisible today" is wrong, and that is worth
more than a rushed fix.** It said the fallback is confined to unrendered variants. I probed 109
champion/role pairs by running the real `buildRecommendations` and comparing every variant's
secondary occurrences against that champion's own `noiseFloor`:

```
variant-1 (RENDERED)      secondaries below the noise floor:  13 / 109   (~12%)
variant-2/3 (unrendered)  secondaries below the noise floor:  50
```

It reaches variant 1 through `displayReliable(winner)`: when the winning secondary tree has fewer
than 2 positive runes above the floor, it fills from `byWpa`, whose per-row `bestAboveFloor` has
already fallen back to most-played. Live examples on the card **today**, before my change:

```
Lissandra SUP  total   9,457  floor 400  ::  Magical Footwear 105, Cosmic Insight 186
Caitlyn TOP    total   3,785  floor 400  ::  Bone Plating 161, Overgrowth 105
Syndra TOP     total   4,615  floor 400  ::  Gathering Storm 187
Galio TOP      total  10,520  floor 400  ::  Scorch 355
```

Magical Footwear on 105 of 9,457 games is 1.1% adoption, rendered as a recommendation with no
caution beyond the existing `lowSample` glyph.

**I did not fix it, deliberately.** It is a pre-existing, live, user-visible defect that is
independent of this change; fixing it alters what variant 1's secondary row shows on ~12% of
champion/role pairs — a behaviour change to the currently-shipped recommendation, in a task
scoped to "do not change which setup is the default pick", with no user directive behind it. It
wants its own decision about what the honest fallback is (refuse the row? show it with an
explicit "below sample floor" marker? widen the search to the next tree?), because "most-played
regardless of floor" and "nothing" are both defensible and the choice is the user's. **Open P2,
now measured.**

## Verified, and how

- `verify-fix.sh` — **ALL CHECKS PASSED** (tsc clean, lint 0 warnings, 2357 tests, build clean,
  sw, manifest).
- **29 new unit tests.** Live-captured fixtures for Ziggs BOT / Jhin BOT / Caitlyn BOT / Lux SUP,
  every conjunct of the predicate at its boundary (including strict `>` at exactly
  `ALT_KEYSTONE_MIN_GAP`, shown WPA exactly 0, alt WPA exactly 0), the id-dedupe, best-of-variants
  selection, both tie-breaks, the no-secondary-rows guard, and degenerate input (empty, single,
  non-array, missing `runes`, malformed keystone).
- **Live API cross-check.** `curl`'d `/api/build` for all three browser champions and confirmed
  the served payloads match the test fixtures field-for-field.
- **Browser, real dev server, fresh `userDataDir` per run** (the PWA service-worker false-negative
  trap): Ziggs BOT, Jhin BOT and Lux SUP at **390px and 1920px** — 6/6 combos pass. Each asserts
  fires/doesn't-fire, the rune name, WPA string, tree, sample string, the "still the
  recommendation" disclaimer, the tile's disclaiming `aria-label`, that tapping it opens the
  detail popover, zero console/page errors, and no horizontal document scroll.
- **v0.81.0 tab semantics regression-guarded** in the same run: exactly 3 tabs, exactly one
  `aria-selected="true"`, exactly one `tabindex="0"` (roving), exactly 3 tabpanels, exactly 1
  visible. Unchanged.
- **Mobile occlusion hit-test:** the fixed `MobileTabBar` covers none of the block at 390px
  (0 of 5 hit-test points on the tile occluded).
- **Reduced motion:** no motion was added. The only transforms are the hover/active ones the
  card's existing `RuneTile` already uses, so there is no entrance transition to gate.

## Not verified / open

- **Only three champions were driven in a browser.** The predicate's population behaviour
  (83/500) is from the API sweep, not from 500 rendered pages.
- **`prefers-reduced-motion` was not toggled in the browser.** The claim rests on reading the
  markup — there is no transition, keyframe or scroll behaviour in the new block. It is an
  argument, not an observation.
- **No screen-reader run.** The `aria-label` is written and asserted as a string; how VoiceOver
  or NVDA actually announces it is untested.
- **Not tested against a rank bracket other than the default** ([5,6,7]). The predicate reads
  whatever the engine returns for the requested bracket, so it should hold, but no probe ran.
- **`/compact` is unchanged and still shows only `variants[0]`.** It is an in-game surface, not a
  champ-select one, so it was out of scope — but the same withheld keystone is invisible there.
- The **~10 upstream coachless calls per request** for variants 2/3 are unchanged. One of them now
  has a consumer; the call count did not move in either direction.
- Trees ranked **4th or lower never reach a variant at all** (`pages` caps at 3), so a withheld
  keystone in a 4th tree stays withheld. Not addressed — it would mean changing what the engine
  returns.

## Environment note (not a defect in this work)

**Another agent was editing this same checkout throughout the session.** Between two consecutive
`verify-fix` runs, `components/skillOrderGrid.ts`, `lib/skillOrderModel.ts`,
`components/hextech/skillOrder.ts`, `components/hextech/SkillOrderCard.tsx`, `lib/types.ts` and a
new `components/SkillGrid.tsx` changed under me, transiently breaking `tsc` (a
`buildSkillOrderGrid` → `buildSkillGrid` rename that had not yet reached `GameDetailSheet.tsx`)
and 404-ing the dev server's static chunks mid-screenshot. Their refactor has since converged and
the final gate is green with both sets of changes in the tree. The working tree was **not** clean
at the start of this task, contrary to the brief. Nothing in `skillOrder*`/`SkillGrid` is mine —
my diff is `altKeystone.ts`, its test, `BuildTabContent.tsx` and `RunesSummonersCard.tsx`.

Probe scripts were kept out of the repo (scratchpad, not repo root) — a throwaway `.ts` at the
root breaks `tsc -b` and the build, unlike the existing `_*.mjs` ones.

## Wiki

`wiki/` does not exist in this project. If one is generated later, the entries worth carrying:

- The `builds[1]` trap (tree order is adoption, not quality) — the Jhin case above.
- Filler variants repeat variant #1's keystone; anything reading the array must dedupe on rune id.
- `bestAboveFloor` reaches the RENDERED card on ~12% of pairs, not just the unrendered variants.
