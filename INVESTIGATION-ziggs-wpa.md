# Investigation — Ziggs BOT WPA vs Coachless's published numbers

Read-only investigation, 2026-07-29. No behaviour changed, no version bump, no deploy, no commit.
All probes hit the live `api.coachless.gg` from throwaway scripts in the session scratchpad.

Every claim below is tagged **CONFIRMED** (a probe ran and I read the output) or **SUSPECTED**
(reasoning only, or an inference the data supports but does not pin down).

---

## A. Why Arcane Comet is on screen when First Strike scores higher

**The two sentences.** The engine never compares keystones across trees: `buildRecommendations` in
`lib/recommend.ts` picks the best-WPA adopted keystone *inside each tree*, then orders the resulting
`primaryConfigs` by `keystoneOcc` — raw adoption — so Sorcery (140,275 games) is rank 1 and
Inspiration (9,297) is rank 2, and Arcane Comet is simply the best-WPA keystone *within Sorcery*.
First Strike is not discarded by the engine — it is built as variant #2, labelled "Alternative" —
but the Builds page renders `data[0]` only, so variant #2 never reaches a screen.

### CONFIRMED — the real function, run against the real API

`npx tsx` against `lib/recommend.ts`'s actual `buildRecommendations(115, 3)`, patch resolved to
16.13, default High Elo bracket:

```
totalGames=153475  bar=7673.8  noiseFloor=400.0

KEYSTONES (raw, from GetKeystoneData)
  Arcane Comet     Sorcery       wpa=-0.024  occ=140275  ADOPTED
  First Strike     Inspiration   wpa=+0.463  occ=  9297  ADOPTED
  Deathfire Touch  Sorcery       wpa=+0.633  occ=  2875  below bar
  Dark Harvest     Domination    wpa=+0.297  occ=   673  below bar
  Summon Aery      Sorcery       wpa=-2.267  occ=   239  below bar
  Lethal Tempo     Precision     wpa=+1.903  occ=   116  below bar
```

Engine arithmetic, reproduced step by step and then checked against the real function's output:

```
Sorcery      adopted = [Arcane Comet  wpa -0.024  occ 140275]
             -> pickRecommended picks Arcane Comet;  keystoneOcc = 140275
Inspiration  adopted = [First Strike  wpa +0.463  occ   9297]
             -> pickRecommended picks First Strike; keystoneOcc =   9297
Precision    no adopted keystone -> tree dropped
Domination   no adopted keystone -> tree dropped

primaryConfigs.sort((a,b) => b.keystoneOcc - a.keystoneOcc)
  #1 Sorcery      keystoneOcc 140275  -> Arcane Comet  (wpa -0.024)
  #2 Inspiration  keystoneOcc   9297  -> First Strike  (wpa +0.463)
```

Real `buildRecommendations` output, all three variants:

```
[rank 1] Top pick     — Sorcery + Inspiration
   KEYSTONE Arcane Comet  wpa -0.0242  occ 140275
   minors   Manaflow Band +0.0209 / Transcendence -0.0163 / Gathering Storm +0.8099
   secondary Inspiration: Magical Footwear +0.3652, Biscuit Delivery +0.3288
   spells   Teleport, Flash

[rank 2] Alternative  — Inspiration + Sorcery
   KEYSTONE First Strike  wpa +0.4630  occ 9297
   minors   Magical Footwear -0.2779 / Biscuit Delivery -0.2782 / Cosmic Insight +0.0833
   secondary Sorcery: Manaflow Band +0.0803, Gathering Storm +0.9035

[rank 3] Alternative  — Sorcery + Resolve
```

Rank 1 matches the user's screen field-for-field: −0.02, +0.02, −0.02, +0.81, +0.37, +0.33,
Teleport + Flash, 153,475 games. **CONFIRMED: nothing on the Builds page is stale or mis-scoped.**

### CONFIRMED — `pickRecommended` is not the cross-tree decider, and `wpaScore` is not either

- `pickRecommended` is called *inside* the per-tree `map` in `buildRecommendations`, over `adopted`
  — the keystones of one tree only. It never sees another tree's keystones.
- `wpaScore` is a field on `SecondaryCandidate`, computed in `secondariesFor` and used only to
  rank/order **secondary** trees. It is never read when ordering `primaryConfigs`. There is no
  whole-page score anywhere in the file.
- The tree order is decided by exactly one expression: `primaryConfigs.sort((a, b) => b.keystoneOcc
  - a.keystoneOcc)`, where `keystoneOcc` is `treePopularity` = `Math.max(...adopted.map(k =>
  k.occurrence))`. Popularity only.

The file says so itself, in the comment above the `keystone` assignment: *"Tree RANKING still uses
raw adoption (below) so the primary tree stays the conventional one."*

### CONFIRMED — the rendered card only ever sees variant #1

`components/hextech/BuildTabContent.tsx` does `setState({ status: "ok", build: data[0] })`, with the
comment *"Spec shows a single primary build, not the top-3 variant switcher the legacy Builds page
rendered — the #1 ranked setup only."* Every other consumer of `/api/build` does the same:

| consumer | takes |
|---|---|
| `components/hextech/BuildTabContent.tsx` (Builds page, the Runes & Summoners card) | `data[0]` |
| `app/compact/page.tsx` (in-game mini view) | `variants[0]` |
| `components/hextech/GlobalNav/ApplyRunesButton.tsx` (writes the LCU rune page) | `data[0]` |

I grepped for `data[1]` / `builds[1]` / `.slice(1)` / `rank === 2` across `components/` and `app/`:
no consumer reads variants 2 or 3. **They are computed on every request and thrown away.**

### Is it intended or a bug?

**Intended, at the level of the engine.** The per-tree/popularity split is deliberate, documented in
the source, and it holds up arithmetically. Summing every rune's WPA on each page:

```
Sorcery page      -0.0242 + 0.0209 - 0.0163 + 0.8099  +  0.3652 + 0.3288  =  +1.484
Inspiration page  +0.4630 - 0.2779 - 0.2782 + 0.0833  +  0.0803 + 0.9035  =  +0.974
```

**CONFIRMED (arithmetic).** So the page the app shows is the stronger *page* even though its
keystone is the weaker *rune* — Sorcery's Gathering Storm (+0.81) more than covers Comet's −0.02,
and First Strike drags Inspiration's own minors negative (−0.28, −0.28). Caveat, stated plainly:
coachless's per-rune WPA figures are marginal contributions measured in their own contexts, not
independent additive terms, so this sum is indicative, not a proof. But it means the displayed
answer is defensible on its merits, not just by popularity.

**A bug, at the level of the product.** The exact step of reasoning that breaks:

> `lib/recommend.ts`'s header states the contract — *"Returns the TOP 3 viable setups… Variants
> prefer different primary trees."* The engine's whole design for "a genuinely different keystone
> exists" is *put it in variant 2*. v0.51.0 collapsed the Builds page to a single view and stopped
> rendering variants 2 and 3. The engine's escape hatch was deleted at the consumer while the engine
> kept relying on it.

Consequence: the keystone is the one slot in the app where a popularity gate is applied *before*
WPA, and there is now no surface anywhere that tells the user so, or shows them what popularity
outranked. Every other slot on the card (items, shards, spells) is plain "highest WPA above the
adoption bar", so the card reads as if the keystone were too.

**Precise change, if you want one — your call, I have not made it.** Do not touch the ranking. The
smallest honest fix is at the consumer, not the engine: render a compact "also viable" line under
the keystone whenever `builds[1].runes.keystone.wpa > builds[0].runes.keystone.wpa` and
`builds[1].runes.keystone.occurrence >= bar`, naming the rune, its WPA and its game count, linking
to variant 2. That restores the escape hatch the engine assumes exists without changing a single
number. A second, independent option is a one-line label on the keystone ("most-played keystone")
so the popularity gate is visible. I would not change `primaryConfigs`'s sort — see D.

---

## B. Does the app ring a negative keystone while a positive, adequately-played alternative exists?

**Yes for Ziggs BOT, and it is a class, not an outlier: 83 of 500 champion/role pairs — 16.6%.**

### Method (and its limits)

I swept all 233 champions × 5 roles (1,165 pairs) through `GetKeystoneData` at patch 16.13, tiers
[5,6,7], `regions: null` — the exact request the app's default sends. 500 pairs came back with
≥2,000 games. For each I reproduced the primary-tree selection step: adoption bar `max(500,
total*0.05)`, best-WPA adopted keystone per tree, tree order by `keystoneOcc`.

**Stated plainly, what this check could not see.** It reimplements *one step* of
`buildRecommendations`, not the whole function. It was validated to reproduce the real function
exactly on Ziggs BOT (above), but a pair could still 404 in production for missing shard/item data
or no viable secondary tree, in which case nothing renders at all. So **83 is an upper bound on
user-visible cases**, not a measured render count. Role 5 (auto) was not swept.

### CONFIRMED — the counts

| class | count | of 500 |
|---|---|---|
| Headline keystone is NOT the highest-WPA adopted keystone (any sign) | 147 | 29.4% |
| …of which the headline keystone's WPA is **negative** while a positive adopted alternative exists | **83** | **16.6%** |

### CONFIRMED — the cases that matter most (largest samples, so not tiny-sample noise)

```
                games    SHOWN keystone                       wpa      occ   |  HIGHER alternative                  wpa      occ
Jhin BOT       605611    Fleet Footwork    (Precision)     -0.272   387410  |  Deathfire Touch  (Sorcery)        +2.500    81053
Caitlyn BOT    654930    Lethal Tempo      (Precision)     -0.011   517777  |  First Strike     (Inspiration)    +0.807    65776
Graves JG      415848    Dark Harvest      (Domination)    -0.218   291670  |  Fleet Footwork   (Precision)      +0.583   118749
Viego JG       371777    Conqueror         (Precision)     -0.344   270066  |  Hail of Blades   (Domination)     +1.810    81748
Ahri MID       352948    Electrocute       (Domination)    -0.109   304466  |  Deathfire Touch  (Sorcery)        +0.828    43496
Sylas MID      338888    Conqueror         (Precision)     -0.124   177854  |  Electrocute      (Domination)     +0.125   157226
Garen TOP      332572    Conqueror         (Precision)     -0.143   264492  |  Stormraider's    (Sorcery)        +0.900    63129
Nocturne JG    290043    Lethal Tempo      (Precision)     -0.319    58321  |  Hail of Blades   (Domination)     +1.087    89257
Kayn JG        288111    Dark Harvest      (Domination)    -0.205   139067  |  Conqueror        (Precision)      +0.003   127284
Malphite TOP   276726    Arcane Comet      (Sorcery)       -0.078   195217  |  Grasp of Undying (Resolve)        +0.514    73182
Shaco JG       182482    Hail of Blades    (Domination)    -0.378   120868  |  Arcane Comet     (Sorcery)        +3.408    28315
Ziggs BOT      153475    Arcane Comet      (Sorcery)       -0.024   140275  |  First Strike     (Inspiration)    +0.463     9297
```

Three of these are not popularity landslides at all and are the sharpest cases:

- **Nocturne JG** — the shown keystone (Lethal Tempo, 58,321) is *less played* than the hidden one
  (Hail of Blades, 89,257). This is worth its own look. Under `keystoneOcc` = the tree's
  most-played *adopted* keystone, a tree can win the ordering on a keystone that then loses the
  within-tree best-WPA pick to a different keystone in the same tree. Precision's most-played
  adopted keystone outranks Domination's, but the keystone *displayed* is Precision's best-WPA one,
  which is played less than the Domination rune it beat. **CONFIRMED** as data; the mechanism is
  **SUSPECTED** (I read the code path but did not run a dedicated probe on Nocturne).
- **Sylas MID** — 177,854 vs 157,226 games, −0.124 vs +0.125. Near-equal adoption, sign flip.
- **Kayn JG** — 139,067 vs 127,284 games, −0.205 vs +0.003.

Ziggs BOT is the *mildest* of the large-sample cases (−0.024, a rounding hair below zero). The user
happened to spot the least severe instance of the pattern.

---

## C. Reproducing Coachless's −0.06 at 63k uses

**Not reproduced. No scope I can request lands both numbers.** Here is exactly how close I got.

### CONFIRMED — `regions: null` is already "All Regions"

`regions` takes numeric ids, not strings (`"EUW1"` → HTTP 400; `[1]` → 200). I swept region ids
0–20 individually at 16.13/[5,6,7]: 15 populated regions, and their Arcane Comet occurrences sum to
**exactly 140,275** — the identical figure `regions: null` returns. So `regions: null` is the
all-regions aggregate, matching Coachless's published "All Regions" label. **The region axis is not
the difference.**

### CONFIRMED — all 63 tier subsets on patch 16.13, single patch

Nothing is near the target. Best fits on each constraint separately:

```
closest by WPA to -0.06        [4,8]   wpa -0.0459   uses  93245
                               [5,8]   wpa -0.0449   uses  90686
                               [6,8]   wpa -0.0374   uses  45784
closest by uses to 63,000      [6,7]   uses  52745   wpa  -0.0132
                               [6]     uses  42628   wpa  -0.0081
                               [5]     uses  87530   wpa  -0.0309
what the app sends [5,6,7]     uses 140275   wpa -0.0242
full span [3,4,5,6,7,8]        uses 319634   wpa -0.0027
```

No single-patch subset sits within 20,000 uses of 63k *and* within 0.02 of −0.06.

### SUSPECTED — a two-patch aggregate is the best-fitting explanation, and it brackets both targets

Their image is labelled "26.13 – 26.14", i.e. two patches. Pooling 16.12 + 16.13 by
occurrence-weighted mean:

```
[6,8]      uses 60462   wpa ~ -0.0701
[6,7]      uses 69991   wpa ~ -0.0567     (identical to [6,7,8])
[6]        uses 56087   wpa ~ -0.0330
[5,6,7]    uses 186623  wpa ~ -0.0240
```

63,000 uses lies **between** [6,8] (60,462) and [6,7] (69,991); −0.06 lies **between** their WPAs
(−0.070 and −0.057). A Master-and-above, two-patch scope is therefore the closest thing to a fit —
but it is a fit by interpolation, not a reproduction, and two things stop me calling it proven:

1. A pooled WPA over two patches is not necessarily the occurrence-weighted mean of the per-patch
   WPAs. Their model may re-fit over the union. My aggregate is an approximation.
2. The correct second patch is probably **16.14, which I cannot request at all** (below).

**Honest verdict: SUSPECTED two-patch, high-elo-narrow (Master+/[6,7]-ish) scope. UNPROVEN.** The
legitimate answer the user's brief anticipated — "a two-patch aggregate we cannot request would
explain it" — is the one the evidence best supports.

### CONFIRMED — what the 403 on 16.14 actually is, and one correction

A prior conclusion in the brief was that *"16.13 is the newest coachless serves; 16.14 does not
exist upstream."* The 403 does not support that, and one part of it is wrong. Probe results:

```
16.9.0   -> 200, 41762 games        16.9.1   -> 403 Forbidden
16.10.0  -> 200, 49841 games        16.10.1  -> 403 Forbidden
16.12.0  -> 200, 52286 games        16.11.1  -> 403 Forbidden
16.13.0  -> 200, 153475 games       16.12.1  -> 403 Forbidden
                                    16.13.1  -> 403 Forbidden
                                    16.13.2  -> 403 Forbidden
16.14.0  -> 403 Forbidden           16.13.3  -> 403 Forbidden
16.15.0  -> 200, 0 rows             16.14.2  -> 403 Forbidden
16.20.0  -> 200, 0 rows
17.1.0   -> 200, 0 rows
```

Two separate behaviours. **Any `patchAdditions != 0` 403s**, on every patch including ones that
work fine at `.0` — so the 403 the user saw on 16.14 carries less information than it looks like.
But at `patchAdditions: 0`, patches the API has no concept of (16.15, 16.20, 17.1) return **200
with zero rows**, whereas **16.14.0 returns 403**. 16.14 behaves like a patch the API knows about
and refuses, not like one that does not exist. That is **SUSPECTED**, not proven — I have no
insight into their gating rule — but it is the opposite of "16.14 does not exist upstream", and it
fits Coachless publishing a 26.13–26.14 figure we cannot request.

---

## D. Is this the adoption bar's design working, or something wearing its clothes?

**Something else wearing its clothes. The adoption bar is exonerated on the Ziggs case, on the
evidence.**

**CONFIRMED.** First Strike has 9,297 games against a bar of 7,673.8. It **clears the bar**. The
`ADOPT_FRAC = 0.05` / `ADOPT_FLOOR = 500` gate accepted it as a reliable pick and `pickRecommended`
selected it as Inspiration's headline keystone. What suppressed it was the next line down —
`primaryConfigs.sort` by `keystoneOcc` — and then the client keeping only `data[0]`. Neither of
those is the user's 2026-06-14 decision. Changing the constants would not move this case at all;
lowering them would only add *more* low-sample trees below Sorcery, and raising them past 9,297
would delete First Strike from the response entirely, which is worse.

**Coachless's "Burn Build" is genuinely the shape the bar exists to demote** — 11k buys against
113k, roughly a tenth of the leading item's adoption — and on that the two products agree by
design. But note what their own image actually shows: **their headline "Most Popular Build" is
Arcane Comet at −0.06, a negative-WPA keystone**, with the positive alternative displayed *beside*
it as a labelled second build. So Coachless applies the same popularity-first rule to its headline
that we do. **The disagreement between the two products is not the pick — it is the number
(−0.02 vs −0.06, a scope difference per C) and, more importantly, the fact that we delete the
alternative while they show it.** That is the same conclusion A reaches from the other direction.

I am not proposing a change to the constants, and I do not think they are wrong.

---

## E. Teleport + Flash on a BOT laner

**CONFIRMED: that is what the data says, not a selection artefact.** The full summoner-spell pool
for Ziggs BOT, 16.13, tiers [5,6,7]: Flash 153,813 uses (100.2% of the 153,475 games — spells are
counted per-slot, so two per game), **Teleport 143,169 uses, 93.3% of games**, wpa +0.0197, observed
win rate 51.39%; then Barrier 8,157 (5.3%), and nothing else above 703 uses. Teleport and Flash are
the only two spells in the pool with meaningful adoption, so `pickSpells` has essentially no choice
to make — it takes the two adopted spells and orders them by WPA, which is why Teleport is listed
first despite Flash being the more-played of the two. A control run on Caitlyn BOT in the same scope
returns Flash 655,158 + Barrier 594,151, i.e. a conventional ADC pair, so the spell path is not
broken. Ziggs bot lane at Diamond+ genuinely runs Teleport, and 93.3% adoption across 153k games is
not a sample the pipeline could have invented. The only cosmetic nit is the *display order* — the
card leads with the less-played spell because ties are broken on WPA rather than adoption.

---

## Also found (no user impact today, noted for the record)

- **`bestAboveFloor` silently defeats its own noise floor.** In `secondariesFor`, when no rune in a
  row clears `noiseFloor` (400 here), it falls back to the most-played entry regardless. On Ziggs
  BOT that put variant #3's Resolve secondary at Bone Plating (322 games) and Overgrowth (203
  games) out of 153,475 — samples of 0.2% and 0.13%. **CONFIRMED** in the real output. Invisible
  today only because variant #3 is never rendered; it would become visible the moment anything
  surfaces variants 2 and 3, which is exactly what A's suggested fix would do. Worth deciding on
  before, not after.
- **Variants 2 and 3 cost a lot for nothing.** Each `PrimaryConfig` fires one
  `GetRunesForKeystoneAndTree` for its own tree plus four more for candidate secondaries. With two
  viable trees on Ziggs BOT that is ~10 upstream calls, and roughly half of them exist only to
  build variants no surface reads. **CONFIRMED** from the code path. Not a correctness issue —
  flagging it because the fix for A and the cost question point in opposite directions and should
  be decided together.
