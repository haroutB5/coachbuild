<!-- merged into HANDOFF.md 2026-07-30 02:27:49Z; previous content preserved there. Append new rounds below. -->

# fronty — ROUND 2: /mystats visual-fidelity pass against the reference (2026-07-30)

**On top of v0.84.3. No version bump, no commit, no deploy.**

Closed the gap between `/mystats` and `_reference-trackdiff.png`. It was a
density-and-scale problem, not a structural one — the brief's read was right.
Nothing was added to fill an empty slot and nothing deliberately-absent came back.

## How the reference was measured

The reference is a **1290px-wide desktop page**, full-bleed, ~14px gutters. The
image is 1290×2796 with letterbox bars; the page content is the middle ~1290×1120
band. Every "reference px" below is a measurement off that image.

Ours was measured in a real browser with `_fronty-measure.mjs` (computed geometry,
fresh `userDataDir` per width), at 390 / 1024 / **1290** / 1920. 1290 is the width
that makes the comparison apples-to-apples.

One structural fact that governs everything: at a 1290px viewport our content
column is **1058px**, not 1290 — the desktop rail takes 232px. So the reference's
composition always has to fit in ~82% of the room it was drawn for.

## Region by region — reference / before / after

All "after" figures measured at a **1290px viewport** unless noted.

### 1. Container

| | reference | before | after |
|---|---|---|---|
| content column | 1290 (full-bleed) | 1100 max | **1280 max** |

Every "ours is looser" reading traced back to the same cause: a 1100px cap
re-flowing a 1290px composition. Widening was the cheapest density gain on the
page — no font shrank to get it. At 1290 the cap does not bind (rail-limited to
1058); at 1920 the column is now 1232 rather than 1052.

### 2. Hero band

| | reference | before | after |
|---|---|---|---|
| height | 225 | 199 | **170** |
| name font | ~40 | 30 | **40** (26 at 390, 34 at sm) |
| name tracking | — | −0.025em | **−0.03em** |
| portrait | 106 | 88 | **96** (68 at 390) |
| chip rows | 1 | 2 reserved | **1 at ≥1024, 2 below** |
| copy lines | 12 | 11.5 | **12** |
| splash art | legible right half | scrimmed to near-black | **visible** |

Two real changes beyond type scale:

- **The right-hand scrim was lightened** (`0.58/0.74` → `0.46/0.62` at the 74%/100%
  stops). The left stops are untouched at `0.96/0.90` — that is the half the name,
  chips and copy sit on, and its contrast budget was never the problem. Splash
  opacity `0.60` → `0.72`.
- **The two-row chip reservation now collapses to one row at `lg`.** This is the
  one change that could have re-opened a closed CLS bug, so it is measured, not
  reasoned about: at 1024px the chip row has **203px of slack** against the
  WIDEST chip set the page produces (`EUW · Emerald IV · 57 LP · 1W · 2L ·
  Main · Viktor 1g`, 355px natural against 558px available). Below 1024 the
  two-row reservation is **unchanged**, which is where the wrap is real.

### 3. Tab strip

| | reference | before | after |
|---|---|---|---|
| case | sentence | UPPERCASE | **sentence** |
| font | ~14 | 13 | **13.5** |
| tracking | ~0 | +0.06em | **+0.005em** |
| gap | ~40 | 24 | **24 / 36 at sm** |

`HextechTabs` is **shared with the Builds page** (`BuildTabContent` renders it
twice), so none of this touched the component. It is done through the tablist's
own `className` with arbitrary variants (`[&_[role=tab]]:normal-case` etc.),
scoped to `/mystats`, leaving both Builds call sites byte-identical.

### 4. "Accounts" heading

| | reference | before | after |
|---|---|---|---|
| font | ~40 | **15** | **32** (22 at 390, 28 at sm) |
| tracking | — | −0.015em | **−0.03em** |

The single largest reason the shipped page read as a settings screen where the
reference reads as a profile. The most-played portrait strip is unchanged.

### 5. Account card grid

| | reference | before | after |
|---|---|---|---|
| card height | 59 | 76 | **58** |
| avatar | ~36 | 36 | **32** |
| shape | 2 lines left, 2 right | 3 down the middle + 2 right | **2 left, 2 right** |

The card was **re-laid-out, not just squeezed**. Rank moved to the right column
above LP, per the reference; the games count moved down beside the region chip.
**Nothing was dropped** — `138g stored` is still on the card and still labelled
on hover.

The rank column is capped at 40% of the card. At 1024 an uncapped `Platinum IV`
ate enough of the row that the *shorter* of two account names truncated. The
reference truncates names too (`DepressedMegaMind #7…`), so a cap is the faithful
answer; at 1290+ neither name truncates any more.

### 6. Lower panels

| | reference | before | after |
|---|---|---|---|
| split | ~1 : 2 (31.5% / 63.7%) | 1 : 1 | **1 : 1.9 at ≥1280** |
| champion row pitch | ~52 | 57 | **49** |
| champion portrait | ~31 | 36 | **32** |

**The 1:2 split is an `xl` rule and that is a measured correction, not caution.**
Applied at `lg` it gave the champion panel a 250px track, the NAME column fell to
~60px, every row wrapped, and the pitch went **57 → 70** — i.e. the "make it
denser" change made that panel *taller* than what it replaced. Caught in the
browser, not in review. The reference is a 1290px desktop; its ratio is honest
from 1280 up and nowhere below.

### 7. KPI treatment

| | reference | before | after |
|---|---|---|---|
| arrangement | numerals left, chips right, ONE row | chips on their own row ABOVE | **one row at ≥1280** |
| numeral size | ~30 | 26 | **26 (unchanged)** |

The chips-above-KPIs arrangement cost ~34px and separated the standing (a chip)
from the numbers it qualifies. **DOM order is chips-then-KPIs at every width** —
the visual swap is CSS `order`, so a screen reader still hears the standing
before the figures.

`xl:min-w-[360px]` on the strip is a floor, and it is there because without it the
third cell **clipped `45.0%` mid-glyph at 1290px**. Found in a screenshot.

The 26px numeral was **left alone**: `KpiStrip` is shared with `FeaturedOtpCard`
and `StatTiles`, and 26 vs ~30 did not justify moving a shared component.

### 8. Bar chart

| | reference | before | after |
|---|---|---|---|
| block height | ~126 | ~143 (bars alone) | **~121** |
| track | — | 84 | **64** |
| column pitch | ~35 | 38 | **36** |
| portrait | ~22 | 28 | **24** |
| 20 bars without scroll | yes | no | **yes at 1920, no at 1290** |

Shortening the TRACK is the only lever that costs no information — no bar
dropped, no label shrunk, and `fraction` is still normalised upstream against the
fixed ceiling of 10, so every bar's height *relative to every other* is
unchanged. `normalizeKdaBars` was not touched.

## What still differs, and why

- **The hero is shorter than the reference's** (170 vs 225 at the same width).
  Direct consequence of the deliberately-absent PRO chip, country flag, ladder
  placing and social row. **If any region still looks under-filled, this is the
  one.** The composition that would fix it without inventing data: move the two
  muted copy lines out of the text column and run them **full-width along the
  hero's bottom edge**, the way the reference's "Register or Login to TrackDIFF…"
  line does — that reclaims the reference's silhouette (portrait + name block
  left, a wide footer line under everything) and adds ~25px of deliberate height.
  Not done: it is a composition change rather than a fidelity fix, and it wants
  your call.
- **Twenty bars still need horizontal scroll at 1290** (720px of bars into a 621px
  panel). Fits at 1920. Cannot close without a wider page or a narrower bar; the
  reference gets it free because its panel is 820px wide.
- **KPI numerals are 26px, reference ~30px.** Shared component; see above.
- **The season KPI band (`3 / 33.3% / —`) has no reference counterpart** and is the
  airiest region left at 1920. Real data; left full-width rather than invent a
  treatment for it.
- **The left champion panel is short** in every screenshot because the active
  account (`K1ayer#swift`) has 3 champions. With `MunsterHunter#EUW` active it
  renders 5 rows and the two panels are close to level. Data, not layout.
- **Deliberately still absent**, per the brief and the test that asserts it:
  `Avg Score`, `MVP`/`ACE`, per-match placement, `Avg Game ELO`, the `PRO` chip,
  country flag, social buttons, `Decay` and `VODs` tabs. Untouched.

## Files changed

- `app/mystats/page.tsx` — container max-width, tab-strip overrides, section
  heading scale, lower-grid split, skeleton kept in sync with both.
- `components/hextech/mystats/ProfileHero.tsx` — name/portrait scale, scrim,
  splash opacity, chip-row collapse at `lg`, padding.
- `components/hextech/mystats/AccountCardGrid.tsx` — card re-layout to 58px.
- `components/hextech/mystats/ChampionPerformancePanel.tsx` — row pitch, portrait,
  column widths, padding.
- `components/hextech/mystats/MatchPerformancePanel.tsx` — inline KPI/chip row.
- `components/hextech/mystats/RecentGamesChart.tsx` — track height, pitch, portrait.

**No shared component was edited.** `HextechTabs`, `KpiStrip`, `PanelHeading`,
`MostPlayedStrip` and `normalizeKdaBars` are untouched, so the Builds page cannot
have moved.

## Verified (round 2)

| claim | how |
|---|---|
| verify-fix gate | **ALL CHECKS PASSED** — tsc, lint (0 warnings), **2622 tests**, build, SW, manifest. Run twice; dev servers killed first both times. |
| **no horizontal scroll** | `window.scrollTo(9999,0)` then `window.scrollX === 0` at 390 / 1024 / 1290 / 1920 — **the check that cannot be fooled**. `documentElement.scrollWidth === innerWidth` too. |
| CLS, production build | 390 **0.1274** · 1024 0.0137 · 1290 0.0121 · 1920 0.0067. The 390 figure is the pre-existing baseline (0.128 last ship, 0.13057 live prod) — **unchanged, not regressed**. |
| hero chips do not wrap at `lg` | widest chip set: 355px natural vs 558px available at 1024, **203px slack** |
| both accounts render | `K1ayer#swift` Emerald IV 57 LP 186g (active, still ingesting) and `MunsterHunter#EUW` Platinum IV 89 LP 138g, all four widths |
| both tabs switch | `hidden` flip verified in the DOM at 390 / 1024 / 1920; Match History screenshotted at each |
| clicks land | `elementFromPoint` **edge scan** (centre + 4 inset corners) over every link, button, tab and input at 390 — zero blocked points |
| touch targets | one element under 44px: the global TopBar search input at 43px. **Pre-existing, not my file, not touched.** |
| reduced motion | `prefers-reduced-motion: reduce` emulated at 390 — zero running animations |
| console | zero console errors, zero page errors, all widths, both tabs |
| screenshots read | 390 / 1024 / 1290 / 1920, **production build**, fresh `userDataDir` per width — `_capture/final-*-full.png` |

## NOT verified — be explicit (round 2)

- **No account switch was performed.** No account secret on this machine, so every
  switch returns `no-secret`. The picker's menu semantics, roving tabindex,
  switch-forces-a-refetch and the secret entry are **unmodified** and covered by
  existing tests, but I did not exercise the success path.
- **No keyboard drive of the tab strip.** Only its appearance changed, via the
  tablist className; `HextechTabs` is byte-identical, so the roving-tabindex and
  arrow-key contract is untouched by construction — but I did not tab through it.
- **The `LIVE` hero ring never rendered.** Companion is off (`Not paired`), so
  `liveIsThisAccount` was false in every capture. v0.84.3's live-attribution rule
  is untouched by this pass — I changed neither `ProfileHero`'s `live` prop nor
  anything that computes it.
- **`unranked` / `rankUnknown` card states never rendered** — both accounts came
  back ranked. Unit-tested, but no pixels. Same for the `filling` coverage state;
  `still syncing` DID render.
- **No Lighthouse, no axe.** Contrast on the lightened hero scrim was judged from
  screenshots, not measured with a contrast tool. Text sits over the 0.90–0.96
  stops, which are unchanged, so the risk is low — but it is a judgement, not a
  measurement.

## Left behind (round 2)

Untracked read-only probes in the repo root, none spending the Riot key:
`_fronty-measure.mjs` (geometry + screenshots + the scrollX check),
`_fronty-a11y.mjs` (touch targets, edge-scan hit tests, reduced motion),
`_fronty-cls2.mjs` (CLS + hero chip slack). Screenshots in `_capture/`
(`before-*`, `after-*`, `final-*`). All use a **fresh `userDataDir` per case**.

**Both my servers (dev :3007, prod :3008) were stopped.** Also killed an orphan on
**:3021** left over from the previous session.

## New gotcha for the wiki

**`next dev` deletes the production build.** Starting dev after `next build` wiped
`.next`, and `next start` then failed with `Could not find a production build`.
Cost one full rebuild. Measure prod CLS BEFORE restarting dev, or rebuild after.

## Proposed CLAUDE.md update (round 2, not applied)

**`/mystats` is laid out against a 1290px reference on a 1058px column.** Any
future "match the screenshot" pass on this page should measure at a 1290px
viewport and remember the 232px rail, or it will chase a ratio that cannot fit.

---

# fronty — /mystats rebuilt against the TrackDIFF profile reference (2026-07-30)

## What shipped

`/mystats` is now a profile page in the reference's shape: splash-art hero with a
circular portrait and a live ring, a tab strip, an "Accounts" heading with an
overlapping most-played portrait strip, an account **card grid**, and the
two-column lower section (champion performance left, match performance + bar
chart right).

**New files (all mine):**

| file | what |
|---|---|
| `components/hextech/mystats/profileModel.ts` | every pure decision on this page — tabs, rank formatting, most-played, account cards, CS gating, relative time |
| `components/hextech/mystats/ProfileHero.tsx` | the hero band |
| `components/hextech/mystats/MostPlayedStrip.tsx` | overlapping circular portraits |
| `components/hextech/mystats/AccountCardGrid.tsx` | the card grid |
| `components/hextech/mystats/ChampionPerformancePanel.tsx` | lower-left panel |
| `components/hextech/mystats/MatchPerformancePanel.tsx` | lower-right panel + bar chart |
| `components/__tests__/profileModel.test.ts` | 49 tests |

**Edited:** `app/mystats/page.tsx`, `components/hextech/myStats.ts`,
`components/live/mystatsAccount.ts`, `components/hextech/mystats/RecentGamesList.tsx`,
plus fixture updates in three existing test files.

## The bug I found on the way in — READ THIS FIRST

**engy's entire §1 contract was on the wire and the client normalizer dropped all
of it.** `normalizeMyStatsSummary` carried none of `csPerMin`, `csGames`, `tier`,
`division`, `lp`, `rankWins`, `rankLosses`, `rankUnknown`, `rankCheckedAt`, `cs`,
`gameDurationSec`. This is the **fourth** occurrence of that exact shape in that
one file — its own header records three. The page's cast to its own extended type
is why TypeScript never noticed, again.

Fixed, and every new field is in the shared `EXTENDED_DEFAULTS` /
`RECENT_GAME_CS_DEFAULTS` / `RECORD_CS_DEFAULTS` fixtures in
`components/__tests__/myStats.test.ts`, so the next dropped field fails a test
instead of passing silently.

**`rankUnknown` normalizes to `true` when absent, never `false`.** `false` asserts
"we looked and this account has no ranked standing", which a payload that never
carried the field has not earned. `normalizeRank` also *blanks* every rank field
when `rankUnknown` is true, so no consumer can read a stale tier sitting beside
it. A truthiness test would have been actively wrong here — the string `"false"`
is truthy.

## Every reference element I dropped or left empty, and why

| reference element | what I did | why |
|---|---|---|
| `Avg Score` | **dropped**, KPI slot holds the window's win rate | TrackDIFF's proprietary composite; no equivalent exists and inventing one is the defect this page spent a night removing |
| `MVP` / `ACE` chips | **dropped** | derived from a full per-game scoreboard. `my_matches` stores champion ids + a win flag for the other nine players and nothing else (migration 0012's privacy posture). Uncomputable without changing what this app stores about other people |
| per-bar placement (`10th`, `4th`) | **dropped** | no placement anywhere in the pipeline. Champion portraits and the value labels above each bar both kept, per the brief |
| `Avg Game ELO` | **dropped** | not fetched, not stored |
| gold `PRO` chip | **dropped** | no notion of pro/verified status for the signed-in user; `lib/pro/**` is a roster of other people |
| country flag + name | **dropped** | never collected, not in the schema, not derivable from a region (EUW is ~30 countries) |
| four square social buttons | **replaced** with the refresh control | no social handles stored or asked for. The slot is real UI, so it holds the one real action that belongs there |
| `#1 EUW` ladder chip | **region only** | the region is real; the ladder *position* is not something this app fetches for the signed-in user. A "#1" that means "we don't know" is the exact failure being avoided |
| `Decay` tab | **dropped** | needs the banked-decay counter (league-v4 fields nothing here reads) and a last-ranked-game timestamp we don't have. A tab onto an empty room |
| `VODs` tab | **dropped** | no VOD pipeline, no recording, no link source |
| `Live Game` tab | **dropped — see below** | |
| per-champion `KDA` column | **replaced** with the account's record on that champion | not available; see below |
| per-champion `CS/min` | **real**, gated | renders `—` when `csGames < 10` |

### Live Game — I checked before dropping it

`CompanionProvider` (mounted app-wide) exposes exactly three things: `phase`,
`champSelect`, `clientConnected`. It does **not** poll the companion's `/live`
allgamedata endpoint at all — `getLive` exists in `companionClient.ts` but nothing
subscribes to it — so a live scoreboard means standing up a brand-new in-game poll
and cadence. And the three fields that *are* available already have a home: the
global `TopBar` renders a live champ-select chip on every route, so the tab could
only restate a chip the user is already looking at.

That is the mostly-empty tab the brief rules out, so it is gone. **The live state
that is real still ships** — as the red ring plus `LIVE` badge on the hero
portrait, which is where the reference puts it too. `isLiveGamePhase` counts only
`InProgress`/`GameStart`; champ select deliberately does not, and a null phase is
never read as live.

Tabs are therefore **`Accounts · Match History`**. `Accounts` holds the
reference's whole visible composition; `Match History` holds the drill-downs the
reference does not show (the per-game list and the per-champion matchup table this
page already had). Both populated, neither a dead end.

### The per-champion KDA column

The reference's centre column is a per-champion KDA over a `K / D / A`
breakdown. **We do not have it.** `my_matches` stores K/D/A per row, but the only
per-champion aggregate the summary route computes is `summarizeByChampion`, which
sums games/wins/lastPlayed/CS — `records[]` reaches the page with no KDA on it.

Computing it from `recentGames[]` (which does carry K/D/A) would be **the v0.73.1
bug verbatim**: that array is a short account-wide window while every other figure
on the row is the split, so a champion's "KDA" would be quoted over two or three
games beside a win rate over dozens. Not done.

The centre column is the account's **record** on that champion instead — real,
already in `records[]`, same visual shape as the reference (one large coloured
figure over a smaller breakdown). **Every column in that panel is headed**, which
is what makes the swap read as a decision rather than as a mislabelled KDA.

## The bar chart

**Metric: KDA.** The choice was between the two per-game numbers we hold, and KDA
wins on **coverage, not preference**: `csPerMin` is null on every row ingested
before engy's CS ship and is deliberately withheld on any game under 5 minutes
(§1c/§2), so a CS/min chart against today's real data is a row of gaps. KDA has
been stored per row since v0.51 and is populated for every game in the window. The
axis says so out loud — `Bar height = KDA`. CS/min is not thrown away; it is the
panel's second KPI.

Heights come from `normalizeKdaBars` unchanged — fixed ceiling of 10, not the
window's own max, so one 0-death stomp cannot flatten every other bar.

## ⚠️ DECISION FOR URGOT — the chart is 5 bars, not 20

`app/api/mystats/summary/route.ts` still does `LIMIT 5` on `recentGames`. That
file is **engy's**, so I did not touch it. The panel renders and labels honestly
whatever arrives ("Match performance (last 5 games)"), and needs **zero** frontend
changes to become 20 bars.

**Ask engy to raise that `LIMIT 5` to `LIMIT 20`.** At 1920px a 5-bar chart leaves
the right half of the panel visibly empty — this is the one place the layout still
reads thin against the reference.

## What the grid does with two accounts

Columns are `1 / 2 / 3` by breakpoint and the cards **flow** rather than sitting in
fixed slots, so two accounts plus the always-present trailing action cell is
exactly one full row of three at `lg` — a deliberate row, not four holes.

`Show all accounts` appears only once something is genuinely hidden (above 5
linked). At two accounts everything is already on screen, so a "show all" would be
a button that does nothing; the cell is **"Link another account"** instead, which
signposts to `AccountPicker`'s real detect/secret flow.

## What I did NOT regress, and how I know

- **The re-fetch-on-switch rule.** The grid does not own the switch. It calls
  `switchAccount` from `accountPickerModel` — *the same tested mutation
  `AccountPicker` uses* — which fires `refetchSummary` if and only if the server
  reported `switched: true`. `handleAccountSwitched` still blanks the stats until
  the new ones land. One mutation, two UIs; a second hand-rolled switch is exactly
  how that rule gets forgotten on one path (gotcha (dd)).
- **`AccountPicker` is unedited** and still mounted, below the grid. It owns the
  companion read, the detection prompt and the secret entry. The grid switches;
  the picker links.
- Coverage states (`none/complete/unknown/filling/thin`) untouched — still derived
  once and passed down.

## Two defects the pixels caught (both fixed)

1. **The bar chart rendered twice.** `RecentGamesChart` lives inside
   `RecentGamesList`, and both tab panels stay mounted behind the tab strip —
   measured **10 bars in the DOM where there should be 5**. `RecentGamesList` now
   takes `showChart` (default `true`, so it stays complete standalone); the page
   passes `false`.
2. **A card click with no stored secret failed silently.** `selectAccount` answers
   `no-secret` and the click did nothing at all — a control that looks actionable,
   is actionable, and visibly does nothing. Now sets an `aria-live` message naming
   the one thing the user can act on and scrolls/focuses them to the secret field.

## CLS — measured, not assumed

Adding the hero's region + rank chips took the chip row from 3 pills to 5, which
**wraps to two lines at 390px**. The previous ship measured that exact growth as
this page's entire CLS budget (0.103 → 0), so `ProfileHero` reserves **two** chip
rows unconditionally (`min-h-[46px]`). Verified: `chipRowH` is **46px at every
width**, hero height stable at 199–201px.

Then the bigger one. Everything below the hero had no placeholder, and the single
summary response carries the account list *and* the stats, so the card grid, both
lower panels and the footer all appeared at once.

| width | dev, before | dev, after | **PRODUCTION build** | previous ship's live-prod baseline |
|---|---|---|---|---|
| 390 | 0.736 | 0.128 | **0.1335** | 0.13057 |
| 1024 | 0.405 | 0.017 | **0.01684** | — |
| 1920 | 0.161 | 0.007 | **0.00665** | 0.07372 |

The production figures are the load-bearing ones (`next build` + `next start -p
3021`, `PerformanceObserver({type:'layout-shift'})`, fresh profile per width).
**At 390px this ship is at parity with the pre-existing baseline** (0.1335 vs
0.13057, +0.003 — inside run-to-run noise), and **at 1920px it is an order of
magnitude better** (0.00665 vs 0.07372). The residual 0.13 at 390 is the
pre-existing content-arrival shift the previous ship already flagged as out of
scope, not something this redesign introduced.

Fixed with `AccountsSkeleton`, rendered **inside** the accounts panel (a
placeholder beside the thing it replaces reserves the wrong box and relocates the
shift rather than removing it), sized to the real blocks — 76px cards matching
`AccountCardGrid`'s own `min-h-[76px]`, and the two lower panels.

0.128 at 390px is essentially the pre-existing baseline the previous ship recorded
on live prod (0.13057); desktop is materially better than before this ship.

## Verified

| claim | how |
|---|---|
| no horizontal scroll | `documentElement.scrollWidth === body.scrollWidth === innerWidth` at 390 / 1024 / 1920, on both tabs |
| both accounts render with real data | `MunsterHunter#EUW` Platinum IV 89 LP 138g; `K1ayer#swift` Emerald IV 57 LP 28g |
| engy's CS is live end-to-end | Viktor `7.1` over `14g`; Senna/Swain/Malzahar/Galio show `—` (csGames < 10) |
| rank is live end-to-end | hero chip, both cards, and the match-performance cluster all read real tiers |
| tabs switch panels | `hidden` attribute flip verified in the DOM at all three widths |
| clicks land | `elementFromPoint` centre hit-test on every tab, card and champion link — no `blocked` |
| touch targets | no interactive element under 44px tall |
| screenshots read | 390 full-page + viewport, 1024, 1920, both tabs |
| console | zero errors, zero page errors, all widths |
| verify-fix gate | **ALL CHECKS PASSED** — tsc, lint (0 warnings), **2622 tests**, build, SW, manifest |
| CLS | production build, measured — table above |

## NOT verified — be explicit

- **No account switch was actually performed.** This machine has no account secret
  stored, so every switch returns `no-secret`. I verified the *failure* path
  renders correctly; the success path (switch → re-fetch → stats change) is
  unexercised by me. It routes through the same tested `switchAccount` the picker
  uses, so read this as "not regressed by construction", not as re-tested.
- **Keyboard nav on the tab strip was not driven.** It is `HextechTabs`,
  unmodified, which already has roving-tabindex/arrow tests — but I did not tab
  through it in the browser.
- **No reduced-motion screenshot, no Lighthouse, no axe run.** The only animation
  I added is the skeleton's pulse, which carries `motion-reduce:animate-none`.
- **The `unranked` and `rankUnknown` rank states never rendered on real data** —
  both linked accounts came back ranked. Both are unit-tested in
  `profileModel.test.ts`, but no pixels.
- **`historyComplete` is true on this account**, so the `filling`/`thin` coverage
  states did not render either. Untouched by me; `_cov-verify.mjs` (already in the
  repo) is still the way to force them.

## One cosmetic thing I noticed and left

At exactly 1024px the account cards sit at three columns of ~245px, and the
ACTIVE card's name truncates (`Munster…#EUW`) while the shorter second name does
not. `truncate` is doing its job and the tag and rank stay readable, so it is not
broken — but it is the one place the grid reads slightly cramped. It clears at
1280px+ and at 390/768 (fewer columns, wider cards). Worth a look if you want it
perfect; I judged it below the bar for another round.

## Left behind

Two untracked read-only probes in the repo root: `_fronty-verify.mjs` (DOM +
screenshots, three widths, both tabs) and `_fronty-cls.mjs` (CLS via
`PerformanceObserver` + `elementFromPoint` hit-tests). Both use a **fresh
`userDataDir` per case** — a reused profile serves later cases from cache with no
request to intercept, which is the false-negative recorded in the previous ship.
Screenshots in `_capture/`. Neither spends the Riot key.

**Both my servers (dev :3011, prod :3021) were stopped** — an orphaned Next
process locks `.next/trace` and `EPERM`s the next build (gotcha (i)), and this
session already lost `.next` once to a concurrent build.

## Proposed CLAUDE.md updates (not applied)

- The My Stats section still says "ONE fixed linked Riot account" — stale.
- New gotcha, and it is now four-for-four: **a client normalizer that drops a
  field the server already sends is this repo's most repeated frontend bug.** The
  durable fix is the shared defaults fixture, not vigilance.
- Worth recording: **`unranked` and `unknown` are different facts.** A null tier
  means unranked only when `rankUnknown` is false. Never re-derive that from the
  tier alone.

## Also for engy

`lib/__tests__/mystats-extract.test.ts`, `lib/__tests__/mystats-aggregate.test.ts`
and `lib/__tests__/mystats-account.test.ts` fail against **your own** current code
(`totalMinionsKilled`/`gameDuration` now required in `lib/mystats/types.ts`;
`buildRecentGames` and `listAccounts` emit fields their exhaustive `toEqual`s do
not expect). I left them alone — your lane.
