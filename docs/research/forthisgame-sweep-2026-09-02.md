# `For this game` calibration sweep — 2026-09-02

The held-out evaluation for the enemy-comp block shipped in web 0.120.0 (`lib/enemyComp/forThisGame.ts`),
run by `scripts/sweep-forthisgame.mts` against production. It subsumes HANDOFF 2026-08-29 §3 (the
`/api/build` reachability re-check, due ~2026-09-05, done three days early) and §6.2 (the block has
had no calibration sweep since `sweep-enemycomp.mts` was deleted with the rule it measured).

## Method

- **Data.** Every champion-role in the roster: 173 champions (`COMP_RATINGS` keys, identical to the
  173 `championClass.ts` rows) x 5 roles = **865 combos**, fetched from `https://coachbuild.vercel.app/api/build`
  between 2026-09-01T23:26Z and 2026-09-01T23:30Z (UTC; local date 2026-09-02, BST) at concurrency 4 with
  150 ms pacing, 404 counted as *not played in this role* and anything else counted as *unresolved*
  and retried twice. **0 of 865 were unresolved**, so the coverage number below is a measurement, not a
  rate-limit artefact. Responses are cached in the gitignored `scripts/.sweep-forthisgame-cache.json`;
  a re-run costs production nothing.
- **Code under test.** The shipped `resolveForThisGamePlan` and `applyForThisGameLine`, imported.
  Nothing is reimplemented. The spine is the champion's own WPA order with boots where the model put
  them, the same construction the unit test uses.
- **Comps.** Two sets. (a) The seven scenario triggers plus a negative control, classified by
  `classifyEnemyComp` before use rather than assumed (table below). (b) **20 random five-champion
  comps per combo**, uniform over the roster, seed `20260902` (mulberry32, reproducible). Uniform is
  deliberately not the real champ-select distribution; it is the held-out one.
- **Four numbers.** Reach; plan rate; the 0/1/2 item-swap distribution and boots-swap rate; and the
  honesty number, how often `chooseCandidate` fell back to the curated pick (`measured: false`), per
  channel.

Line invariants (exactly one boots, no duplicates, never longer than the spine) were checked on every
one of the 6,476 plans produced across both sets: **0 violations**.

## 1. Reach: `/api/build` covers 284 of 865 champion-roles (32.8%)

| patch | date | combos with data |
|---|---|---|
| 16.16 | 2026-08-28 | 323 |
| 16.17 | 2026-08-29 (flip day) | 245 |
| 16.17 | **2026-09-02** | **284** |

Every one of the 284 answered patch `16.17`. Per role: Top 69, Jungle 62, Mid 64, Bot 44, Support 45.
The recovery §3 predicted is happening (+39 in four days, +16%); it has not reached the 16.16 figure
yet and the ~2026-09-05 re-check is still worth doing (`npx tsx scripts/sweep-forthisgame.mts --refresh`).
This caps the block either way: it can only exist where a build exists.

## 2. The scenario comps, as the classifier read them

| name | ids | scenarios fired | damage lean |
|---|---|---|---|
| healers | Soraka, Aatrox, Lux, Viktor, Caitlyn | `healers` | mixed |
| shielders | Karma, Lulu, Janna, Morgana, Renata | `heavy-ap`, `shielders` | ap |
| tanks | Malphite, Ornn, Zed, Draven, Jhin | `tanks`, `heavy-ad` | ad |
| heavy-cc | Thresh, Leona, Ashe, Lissandra, Lucian | `heavy-cc` | mixed |
| heavy-ap | Lux, Viktor, Ahri, Malphite, Jhin | `heavy-ap` | ap |
| heavy-ad | Draven, Jhin, Lucian, Zed, Lux | `heavy-ad` | ad |
| assassins | Zed, Talon, Kha'Zix, Lux, Caitlyn | `heavy-ad`, `assassins` | ad |
| quiet (control) | Caitlyn, Jhin, Lux, Viktor, Jax | none | mixed |

Three synthetic comps fire a second scenario alongside the one they were built for (a shielder comp
is also all-AP; three assassins are also three AD). That is the classifier being right, not the comp
being wrong, and it is why the per-comp rows below show two-swap plans for `tanks` and `assassins`.

## 3. Plan rate and shape

### Against the scenario comps (284 combos x 8 comps = 2,272 trials)

| comp | plans | 0 / 1 / 2 item swaps | boots swapped | judgment share |
|---|---|---|---|---|
| healers | 284 / 284 | 0 / 284 / 0 | 0 | **80.6%** |
| shielders | 284 / 284 | 0 / 209 / 75 | 231 | 71.4% |
| tanks | 284 / 284 | 0 / 56 / 228 | 234 | 48.0% |
| heavy-cc | 231 / 284 (81.3%) | 214 / 17 / 0 | 231 | 58.9% |
| heavy-ap | 284 / 284 | 0 / 284 / 0 | 231 | 70.3% |
| heavy-ad | 284 / 284 | 0 / 284 / 0 | 234 | 46.3% |
| assassins | 284 / 284 | 0 / 190 / 94 | 234 | 50.7% |
| quiet | **0 / 284** | | | |

The control fires nothing, as it must. `heavy-cc` is the one trigger that does not reach every
combo: it names only boots, and 53 combos already open on Mercury's Treads (or their class has no
`heavy-cc` cell), so there is no swap to make and the block honestly does not exist.

### Against random comps (284 combos x 20 comps = 5,680 trials)

| | |
|---|---|
| plan exists | **4,541 / 5,680 = 79.9%** |
| item swaps 0 / 1 / 2 | 127 (2.8%) / 2,516 (55.4%) / 1,898 (41.8%) |
| boots swapped | 2,193 of 4,541 plans (48.3%) |
| combos that plan on at least one comp | 284 / 284 (100%) |
| combos that plan on every comp | 4 / 284 |
| per lane, plan rate | Top 78.6%, Jungle 79.7%, Mid 81.6%, Bot 81.7%, Support 78.3% |

Scenario fire counts over the 5,680 random comps: `healers` 1,862 (32.8%), `assassins` 1,851 (32.6%),
`heavy-ap` 1,267, `tanks` 1,097, `heavy-ad` 954, `shielders` 871, `heavy-cc` 822.

## 4. The honesty number

`measured: false` means the curated table's pick was taken because nothing in the candidate list
appeared in the champion's own `/api/build` universe.

| set | boots channel | item channel | all swaps |
|---|---|---|---|
| scenario comps | 804 / 1,395 = **57.6%** judgment | 1,262 / 2,118 = **59.6%** | 2,066 / 3,513 = **58.8%** |
| random comps | 1,266 / 2,193 = **57.7%** | 4,077 / 6,312 = **64.6%** | 5,343 / 8,505 = **62.8%** |

Per lane (random comps, all swaps): Top 61.5%, Jungle 59.3%, Mid 65.2%, Bot 63.9%, Support 64.8%.

By scenario (random comps, judgment picks / slots claimed): `healers` 1,505 / 1,862 (**81%**),
`heavy-ap` 1,367 / 1,926 (71%), `heavy-ad` 760 / 1,621 (47%), `tanks` 471 / 915 (51%),
`assassins` 663 / 1,264 (52%), `heavy-cc` 446 / 747 (60%), `shielders` 131 / 170 (77%).

## Verdict

**The block fires on four comps in five and is a judgment call three times in five.** Neither
number is wrong on its own terms, but together they say this is a feature that almost always has
something to say and usually cannot point at the champion's own data when it says it. Three things
follow, in order of how much they matter:

1. **Anti-heal is the headline judgment case, at 81%.** The 2026-08-29 finding that the measured pool
   rarely carries anti-heal (9 of 24 sampled) holds across the whole roster: on a two-healer comp the
   block recommends Morellonomicon / Mortal Reminder / Chempunk Chainsword off the table, not off the
   data, for four champions in five. The block is labelled JUDGMENT for exactly this branch and the
   caption says `judgment` on every such swap, so the honesty mechanism is doing its job. Whether the
   feature should keep firing there is a product decision, not a code one.

2. **The kit axes are broad, and that is where the fire rate comes from.** `AXIS_COUNT_FLOOR = 2`
   counts **41 of 173 champions as assassins (23.7%), 40 as healers (23.1%) and 28 as shielders
   (16.2%)**. Two-of-five from a 23% pool is a 32% event on a uniform draw, which is exactly the
   `healers` and `assassins` fire rate above. This is the concrete form of HANDOFF §6.3 (*the curated
   tables are one person's League knowledge*): the second reader should look at which champions sit
   at axis level 2, because that boundary decides a third of all fires. `tanks` (29 champions at
   `tankiness >= 3`, a reused rubric) and the damage lean (81 AD / 89 AP / 3 mixed) are narrower and
   their honesty numbers are correspondingly better (47-51%).

3. **The two-swap case is common, not rare.** 41.8% of random-comp plans claim both item slots. The
   design note said a comp is "routinely two scenarios at once"; measured, it is two in five. The
   `MAX_ITEM_SWAPS = 2` budget is binding often enough that its choice matters, and the last-item
   eviction rule is exercised on most plans.

Nothing here argues for a code change today. It argues for the second reader (§6.3), armed with
these numbers, and for re-running the sweep on the next patch to see whether the 284 recovers toward
323 and whether the honesty number moves with it (a fuller measured universe can only lower it).

Re-run: `npx tsx scripts/sweep-forthisgame.mts --refresh --out <file>`; typecheck with a temp
tsconfig listing the `.mts` file (tsconfig's `**/*.ts` does not match it).
