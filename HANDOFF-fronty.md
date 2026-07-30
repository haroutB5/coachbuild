<!-- merged into HANDOFF.md 2026-07-29 23:32:12Z; previous content preserved there. Append new rounds below. -->

## 2026-07-30 — /mystats surfaces an incomplete history (the last silent gap)

Closes the UI half of engy's `historyComplete` work. Before this, a refresh run
truncated by its Riot-call budget produced a partial history that /mystats
presented under a `"Season 2026"` heading with nothing saying so — a confident
number over a truncated denominator. It could not happen on today's data (one
account, `backfill_done = true`); it happens the moment a second account is linked.

### The P1 that was already there

`normalizeMyStatsSummary` (`components/hextech/myStats.ts`) **dropped
`historyComplete` entirely.** The summary route has sent it since engy's ship; the
page's cast to `MyStatsSummaryExtended` meant TypeScript never noticed. This is the
third time that exact shape has bitten this file — its own header records the first
(five v0.51 fields) and the second (`nOnBuild`/`nOffBuild`) — so the field is now in
`EXTENDED_DEFAULTS` in `components/__tests__/myStats.test.ts`, which is the object
every exhaustive `toEqual` in that file spreads. Adding a wire field without adding
it there now fails a test rather than passing silently.

Normalized as `boolean | null` via the existing `boolOrNull`, **not** coerced to a
boolean. `null` ("the response never carried the field") is a genuinely different
state from `false`, and collapsing it either way is a lie in one direction or the
other. A string `"false"` is truthy, so a truthiness test here would have been the
worst available default.

### What was built

`computeHistoryCoverage` in `components/hextech/myStats.ts` — one pure function,
five states, consumed by every surface on the page that makes a coverage claim.
Derived ONCE in `app/mystats/page.tsx` and passed down; deriving it per-surface is
how two of them eventually disagree.

| state | when | what renders |
|---|---|---|
| `none` | `accountUnresolved` | nothing — no account, no claim |
| `complete` | `historyComplete === true` | unchanged from before this ship |
| `unknown` | field absent/non-boolean | labels soften, **no** pill, **no** paragraph |
| `filling` | incomplete, > 30 games | hero pill + a note on the GAMES cell |
| `thin` | incomplete, ≤ 30 games | the above **plus** `StillSyncingCallout` |

Surfaces touched: the hero pill row, `StatTiles`' GAMES cell (label + note), the
matchup panel's heading meta and its `sr-only` status line, and the zero-rows empty
panel. `ChampionPoolCard`'s meta was already denominator-honest (`N champions · M
games`, no season word) and needed nothing.

**No progress percentage, and there must never be one.** Nothing knows the true
denominator — that is the entire reason the backend ships a flag instead of a count.
A `"62% synced"` would be a brand-new confidently-wrong number. A test asserts no
`%` appears in any string the helper returns.

### The three judgement calls

**1 — What the label says.** `"Still syncing"` on the pill, `"still syncing"` on the
cell note, `"Still collecting your games."` leading the callout. Not `"incomplete"`,
`"missing"`, `"error"` or `"failed"`, and the pill is `neutral`, not `bad` — nothing
is broken, the history is filling, and a red chip beside a W-L record reads as
something the user must act on. A test pins the wording against that vocabulary so
a later copy edit cannot quietly turn it into an error message.

It is also not whisper-quiet, which was the other failure mode. The pill sits
**first** in the hero's pill row — above and before the numbers it qualifies — and
the GAMES cell stops calling itself a season, so the caveat is read before the
figures rather than trailing them as a footnote.

**2 — Where it goes: one placement is NOT enough, two are.** The season heading is
where the claim is made, but the KPI strip is what people actually read, so it gets
its own note in a row `KpiStrip` already reserves (zero layout cost). The
`sr-only` status line and the empty-state copy came along because they carried the
same claim in words — a tooltip reading `"Wins this season"` over a truncated walk
is the identical over-claim, just quieter, so those titles now say `"recorded so
far"` too.

The zero-rows case genuinely needed splitting: `"No games yet this season"` is a
claim ABOUT the season made from a walk that never finished. The account may have
played plenty and we simply have not reached it. That copy is now earned only by a
complete history.

**3 — A fresh account gets something stronger, and the threshold is derived, not
chosen.** `MYSTATS_THIN_HISTORY_GAMES = 30` because `lib/mystats/ingest.ts`'s
`INCREMENTAL_CALL_BUDGET` is 30 Riot calls per run, one of which is the id page — so
a single truncated run stores at most ~29 games. At or below that, the account has
had effectively ONE pass and its win rate is one run's slice, not a season; a
sentence is warranted, not a chip. Duplicated rather than imported because
`lib/mystats/ingest.ts` is server-side (Neon + Riot) and importing it into a client
module would drag both into the bundle; the constant's doc comment says so and says
to move them together.

Read `FeaturedOtpCard`'s `MIN_SAMPLE_GAMES` guard first, as instructed, and followed
it in shape — say plainly that we are still collecting, quote only what we hold —
but deliberately **not** in form. That card can say `"N of the 12 needed"` because 12
is a known floor. Here there is no known denominator, so the callout says how many
games it has and that each refresh reaches further back, and never implies a
fraction of a total nothing knows.

### A CLS defect the pixels caught, and the fix

First cut added the syncing pill as a FOURTH pill. Measured at 390px: the row wraps
to two lines and the hero grows ~26px — which is exactly the shift `HeroBand`'s
`reservePills` comment says it had already closed (that single growth was this page's
entire CLS, 0.103 → 0). Reserving two pill rows for every account to make room for a
caveat most accounts never see is the wrong trade.

So **the MAIN pill yields its slot** whenever the syncing pill renders. Editorially
it is the right pill to drop: `"most-played this season"` is itself a season claim,
and it is the least reliable one over a truncated walk — the true main can change as
older games arrive. Nothing is lost, because the main champion is also the hero's
splash art and portrait.

Measured after the fix, production build, one shift each:

| state | 390px | 1920px | hero | pill row |
|---|---|---|---|---|
| complete | 0.13057 | 0.07419 | 99px | 20px, 3 pills |
| filling | 0.13057 | 0.07372 | 99px | 20px, 3 pills |
| thin | 0.13057 | 0.03855 | 99px | 20px, 3 pills |
| **live prod (no change at all)** | **0.13057** | **0.07372** | 99px | 20px, 3 pills |

**My change adds zero CLS — identical to live prod to five decimal places.** The
0.131 that IS there is pre-existing and out of scope: one shift at ~1.4s when the
summary lands and Recent Games / Champion Pool / Matchup History appear, none of
which has a skeleton (only the KPI strip does). Worth a follow-up; it is not from
this ship.

### How the incomplete state was forced

The real account is fully synced, so the branch cannot occur on this machine's data.
Rather than patch `readHistoryComplete` and verify code I would then revert, an
untracked probe intercepts the BROWSER's own `GET /api/mystats/summary`, fetches the
real response, rewrites only the fields under test, and serves that. Everything
downstream — `normalizeMyStatsSummary`, the page, `StatTiles`, `KpiStrip` — is the
shipped code path running on the real account's real numbers. Six forced cases:
`complete` (untouched passthrough), `filling`, `thin` (records trimmed to 22 games),
`unresolved-incomplete`, `flag-absent`, `incomplete-zero`. The refresh POST is
stubbed in every case so no probe ever spends the Riot key.

**A false negative worth recording.** The first run of that probe reported EVERY
forced state as unchanged, and the honest reading was "my code does not work". It
was the harness: one browser reused across all six cases let Chrome's profile cache
serve later pages the first case's response, so there was no network request left to
intercept. One browser + a fresh `userDataDir` PER CASE, plus
`setCacheEnabled(false)`, and every state appeared. The generalisable version — an
interception probe that reuses a profile across cases is not measuring what it
thinks it is — is the note worth keeping.

### Verified, and how

| claim | how |
|---|---|
| whole tree | `verify-fix.sh` all green, **2494 tests** (was 2479; +15) |
| all six coverage states render correctly | DOM-text assertions at 390 AND 1920 on a PRODUCTION build (`next build` + `next start -p 3001`), not dev |
| the pill is not clipped | `elementFromPoint` centre hit-test, `"visible"` in every state that renders it, both widths |
| CLS | `PerformanceObserver({type:'layout-shift'})`, prod build, compared against live prod — table above |
| no horizontal overflow | `scrollWidth === innerWidth` (390 and 1920) in all six states |
| complete state renders unchanged | untouched-passthrough case byte-matches live prod's DOM text (`"GAMES, SEASON 2026 84 84"`, same 3 pills, same hero height) |
| screenshots read | 390px full-page and viewport crops, 1920px full — hero, callout, KPI strip legible in each |
| `accountUnresolved` renders no coverage claim | forced with `historyComplete: false` present and contradictory; pills `[]`, no KPI strip, original empty panel — plus a unit test over all four flag values |
| account picker untouched | not edited; renders and reads correctly (`"MunsterHunter#EUW / EUW · 138 games / Enter account secret"`) in every forced state |

### NOT verified — be explicit

- **No real truncated run has ever rendered this.** Every incomplete state came
  from a rewritten response. The end-to-end path (a genuinely budget-truncated
  refresh → `backfill_done` cleared → `readHistoryComplete` false → this UI) is
  unexercised, and cannot be exercised until a second account is linked. Same
  boundary engy flagged.
- **Keyboard and switch behaviour on the account picker was not re-driven.** I did
  not edit `AccountPicker` or `handleAccountSwitched`, and the picker renders
  correctly in every forced state, but I did not tab through the menu or perform a
  live account switch. Read as "not regressed by omission", not as re-tested.
- **The `thin` callout was never seen at a REAL small game count.** 22 games came
  from trimming `records`; `accounts[].games` still said 138 in that render, so the
  picker and the KPI strip disagreed on screen. That mismatch is a probe artifact.
- **But a related real mismatch does exist and is NOT mine:** the picker's
  `EUW · 138 games` is account-wide across splits while the KPI strip's `84` is
  current-split. Both true, neither labelled with its scope, side by side on the
  real account. Pre-existing, out of this brief's scope, flagged for the user.
- **No Lighthouse/axe run**, no reduced-motion screenshot. Nothing I added
  animates — the callout is static and its dot is a plain box-shadow with no pulse,
  deliberately — so there was nothing for a reduced-motion pass to compare, but I
  did not take the shot.
- **Dev-mode CLS numbers are noise** and were discarded: `next dev` gave complete
  0.224 vs filling 0.131 on the same code, i.e. the unmodified state looked worse.
  Only the production-build figures above are load-bearing.

### Left behind for urgot

Five untracked probes in the repo root, all read-only against localhost except the
prod-baseline one, none of which spends the Riot key:
`_cov-verify.mjs` (the six-state forcer), `_cov-crop.mjs`, `_cov-cls.mjs`,
`_cov-cls-prod.mjs`, `_cov-dbg.mjs`. **I did not delete them: the safety-gate hook
blocks every `rm` and, per HANDOFF-engy.md's entry, the hook is itself broken
(points at the dead `S:/AI/urgot` root, cannot write its own approval file), so no
destructive command can currently be authorised.** Per the never-route-around-a-block
rule I stopped rather than working around it. `_cov-verify.mjs` is worth keeping
until a second account exists — it is the only way to see these states.

### Proposed CLAUDE.md / wiki updates (not applied)

- The My Stats section still says "ONE fixed linked Riot account" — stale since the
  multi-account ship, and now doubly so: the whole reason this coverage work exists
  is the second account.
- New gotcha: **a normalizer that drops a field the server already sends is this
  repo's most repeated frontend bug** (three times in one file). The durable fix is
  the shared `EXTENDED_DEFAULTS` fixture, not vigilance.
- New gotcha: **a Puppeteer request-interception probe must launch one browser per
  case.** A reused profile serves later cases from cache with no request to
  intercept, and the failure mode is a clean, plausible, completely wrong "your
  change did nothing".
