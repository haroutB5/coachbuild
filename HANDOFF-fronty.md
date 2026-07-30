<!-- merged into HANDOFF.md 2026-07-30 02:27:49Z; previous content preserved there. Append new rounds below. -->

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
