<!-- merged into HANDOFF.md 2026-07-29 23:32:12Z; previous content preserved there. Append new rounds below. -->

## 2026-07-30 — three audit defects on the multi-account ship (engy)

Scope was the three defects a Fable cold-start audit found against the uncommitted
multi-account tree, plus one cheap atomicity fix. Nothing else touched. Not
committed, not version-bumped, not deployed.

`bash C:/Claude/AI/urgot/scripts/verify-fix.sh C:/Claude/AI/coachbuild` — ALL
CHECKS PASSED (tsc, lint 0 warnings, **2479 tests**, build, SW, manifest). Was
2464 before; +15 are the new ones below.

---

### FIX 1 (P1) — the OTP walk's 6h self-refresh of `my_matches` was permanently dead

`maybeRefreshMine` in `scripts/ingest-otp-priority.mjs` read the cursor by
`WHERE id = 1`. Migration 0020 dropped that column, so it threw on every pass and
the catch returned false. Now scoped by the active puuid, the same way
`activePuuid`/`loadStates` in that file and `getPersistedCursor` in
`lib/mystats/ingest.ts` already do.

**Proved against the live DB, both directions** (read-only, zero Riot calls — the
probe is still in the tree at `C:/Claude/AI/coachbuild/_engy-fix1-probe.mjs`, see
"left behind" below):

```
--- A) the query maybeRefreshMine ran until today (WHERE id = 1) ---
FAILED as predicted: column "id" does not exist

--- B) the replacement (WHERE puuid = <active puuid>) ---
SUCCEEDED: [{"last_incremental_at":"2026-07-29T23:19:50.121Z","next_start":0,"backfill_done":true}]

--- C) cursor table shape ---
columns: next_start, backfill_done, updated_at, last_incremental_at, puuid   (no `id`)
```

**Independent confirmation it was live, not theoretical.** The running walk's own
log (`%LOCALAPPDATA%\CoachBuild\otp-priority.log`) carries the failure once per
unit, ~every 8 seconds, for the whole tail of the file:

```
[2026-07-29T23:44:26.979Z] my_matches freshness check failed — column "id" does not exist
```

**The log line is now honest about which failure it is**, per the brief. Three
distinguishable outcomes instead of one:

- no cursor row → `my_matches: no ingest cursor row for the active account yet —
  treating as never refreshed`, and it proceeds to refresh (right answer for a new
  account).
- query/schema error → `MY_MATCHES SELF-REFRESH IS BROKEN — ... QUERY/SCHEMA
  ERROR: <msg>`, naming the consequence, with a consecutive-failure count.
- no active account → its own line.

Also **throttled to one line per state per 30 min** (`noteMineCheckState`), reset
on a healthy read so a recurrence announces itself immediately. The volume was
part of the camouflage: 2,000+ identical lines is indistinguishable from routine
noise, which is how a hard schema error survived.

One structural change at the call site: `activePuuid(sql)` is now resolved *once*
per pass and passed into `maybeRefreshMine`, instead of the refresh doing its own
lookup after. Same answer, one query, one copy of the fact.

**Not yet in effect on the live walk.** pid 27024 has the old code loaded and has
been running since 2026-07-29T17:15Z. The fix takes effect when
`CoachBuildOtpIngest` next restarts it. Re-run the probe afterwards to confirm.

---

### FIX 2 (P1) — incremental ingest now pages until overlap

`runMyStatsIngest` in incremental mode fetched one page of the newest 30 and
stopped, and nothing anywhere schedules backfill mode. Fixed as briefed: page
forward from `start=0` until a page contains a match id already stored **for that
account**.

Everything below lives in `lib/mystats/ingest.ts`, whose header now carries the
full argument. Read that before touching the loop.

**The part that is easy to get wrong, and the reason there is a flag at all.**
Overlap alone is *not* a completeness proof — "I have seen this game before" only
means "fully synced" if everything *behind* that point was walked too. So the walk
reads the persisted flag and only stops on overlap when the history is already
known complete (`stopOnOverlap`); otherwise it walks to exhaustion to *earn* it.
Without that, a run stopped part-way would store a fresh block at the front and
the next run would find overlap on page 0 and declare itself synced over the hole
it just made — the same defect one level up, exactly as the brief warned.

#### The `backfill_done` decision: REUSED, not retired, with one sharpened meaning

```
backfill_done = true  <=>  every match in this account's season window, down to
                           the depth this app walks (INCREMENTAL_DEPTH_CAP ==
                           BACKFILL_CAP), has been EXAMINED at least once.
```

**Why reuse rather than retire.** That is already what backfill mode meant by it,
*including* its cap-reached case ("as deep as this feature goes"). So no migration,
no column rename, and no second flag that could disagree with the first. What
changed is that incremental mode now both **reads** it (as its licence to stop on
overlap) and **writes** it — setting it true when it proves the window exhausted,
and **clearing** it when a per-run limit cut a walk short.

Deliberate consequences worth knowing:

- **`next_start` stays backfill-mode-only.** Incremental never reads or writes it
  and always re-walks from 0. That costs one cheap id page per 100 already-stored
  ids and means it can never trust a stale offset. One column, one meaning, two
  writers who agree — not two mechanisms.
- **A fresh account no longer needs a manual backfill at all.** "Until overlap"
  with nothing stored *is* the backfill. `scripts/ingest-mystats.mjs` still works
  and is now the *fast* path rather than the only one (see the convergence note).
- **`"examined"` is not `"stored"`.** A match Riot refuses to serve, or a
  pre-season row dropped by the season guard, is examined. Otherwise one
  permanently-404ing match would hold the flag hostage forever. Residual cost: one
  wasted Riot call per run for such a match, visible in `result.errors`. Same cost
  as before this change.
- Backfill mode's own result reports `truncatedBy: null` always: both its stop
  conditions mean "as deep as this feature walks", which is completeness under
  this definition, not truncation.

#### The cap, and why it is 30

**This is the constraint the brief did not have, and it drove the design.** Both
callers of incremental mode declare `maxDuration = 60`
(`app/api/mystats/refresh/route.ts`, `app/api/ingest/mystats/route.ts`). At
`lib/pro/pacer.ts`'s 1.3s floor that is ~45 Riot calls of wall clock, so a walk
sized to fetch a whole season in one invocation would simply be **killed** — and a
killed run records nothing. Constants:

| constant | value | why |
|---|---|---|
| `INCREMENTAL_CALL_BUDGET` | 30 | id pages + match fetches together. ~39s paced, inside 60s *with the cursor write done*. |
| `INCREMENTAL_DEADLINE_MS` | 45 000 | `resolveRecommendedBuild`'s coachless lookups are unpaced and unbounded; only a clock maps to `maxDuration`. |
| `INCREMENTAL_MAX_PAGES` | 20 | belt-and-braces; never the binding limit. |
| `INCREMENTAL_DEPTH_CAP` | `BACKFILL_CAP` (400) | policy depth. Same number by construction so the two paths cannot disagree about where "as deep as we go" is. |
| `INCREMENTAL_CATCHUP_PAGE_SIZE` | `PAGE_SIZE` (100) | a catch-up re-scans stored territory to reach the frontier; Riot charges per *page*, not per id, so 100/page crosses the depth cap in 4 calls instead of 14. Steady state keeps 30. |

`callBudget` / `deadlineMs` / `now` are overridable via `MyStatsIngestOptions` —
`deadlineMs: null` disables the clock for long-running script callers. Nothing in
the app overrides them.

**The rate limit is untouched.** No change to `lib/pro/pacer.ts`, no parallel
fan-out, no new concurrent caller. The walk spends *fewer or equal* calls per
invocation than the ceiling those two routes already implied.

#### A truncation is never silent — three places, not one

1. **Log**, loud: `INCOMPLETE SYNC for <riotId>: stopped after N page(s) / M ids
   examined WITHOUT reaching already-synced games — <reason>. ...this account's
   stats are over a PARTIAL history until it does.`
2. **Persisted**: `backfill_done` cleared, so the next run resumes the catch-up
   instead of stopping at the false overlap. This is the load-bearing half.
3. **On the wire**: `MyStatsIngestResult.truncatedBy` (the reason, verbatim) and
   `historyComplete`, passed through `lib/mystats/refresh.ts`'s
   `{refreshed:true,...}` variant and returned by both ingest routes.

Additionally `GET /api/mystats/summary` now carries **`historyComplete`**, read
through the one function that owns the flag (`readHistoryComplete`, exported from
`ingest.ts` rather than re-querying at the call site — gotcha (dd)). That is the
surface computing the `season: "Season 2026"` label, so the fact that the
denominator may be partial travels with the numbers. **The UI does not render it
yet** — that is a fronty change and I did not make it. The honest treatment is to
qualify the season label / stat tiles when `historyComplete === false`.

#### Idempotency and kill-safety

Unchanged dedupe: the per-page `SELECT match_id ... WHERE puuid = ... AND match_id
= ANY(...)` prefilter plus `ON CONFLICT (puuid, match_id) DO NOTHING`. Matches are
inserted one at a time and the flag is only written at the *end* of a proven walk,
so a kill mid-walk loses nothing, duplicates nothing, and leaves `backfill_done`
at its old value — false if mid-catch-up; and if it was true, the next run's
front-fill re-checks the front anyway.

#### The window: it is the SEASON boundary, not 90 days

Correcting the brief's premise. `my_matches`' ingest boundary is
`seasonStartEpochSec()` — 2026-01-08, about seven months — passed as `startTime` on
**every** id page in both modes, so the walk structurally cannot reach behind it no
matter how many pages it takes. The 90-day figure is `lib/pro/fresh.ts`'s
`FRESH_WINDOW_DAYS`, which governs the pro/OTP pipelines
(`scripts/ingest-otp-priority.mjs`), not this one. The *intent* of the
non-negotiable is honoured exactly: the window is never widened, depth comes from
paginating inside it. Noted in the file header so the next reader does not carry
the 90-day number across.

#### Convergence cost, stated plainly

A fresh account with a full season converges over **multiple runs**, not one:
~29 matches per run, so ~400 games is ~14 runs. With the page-view refresh's 3-min
cooldown that is ~45 minutes of having My Stats open; on the daily cron alone it is
~2 weeks. `npx tsx scripts/ingest-mystats.mjs` (long-running, no serverless wall,
no budget) still does it in one pass and is the fast path for a newly linked
account. This is a real limitation of a 60s function plus a shared Riot key, not a
bug — but it is the reason `historyComplete` is on the wire, and it is why I did
**not** shorten `REFRESH_COOLDOWN_MS` to speed convergence: that is a key-budget
decision, the OTP walk is currently spending the same key, and it was not mine to
make while the user is asleep.

#### Tests (14 new, `lib/__tests__/mystats-ingest.test.ts`)

Grouped by the three properties the brief named. The one that matters most is
**CONVERGES ACROSS RUNS**: the harness's fake cursor row is *mutated* by a flag
write, so run 1 truncating and run 2 finishing over the block run 1 created is
actually exercised end to end — that is the false-overlap trap, and it is the
failure mode that would silently lose games.

- termination: steady state stops on page 0 (and writes no cursor row at all);
  caught-up-from-behind pages 0/30/60 and stops on the overlapping page; **an
  incomplete history does NOT stop at the first overlap**; a fresh account's walk
  becomes the backfill with no separate trigger.
- window: every page carries the season `startTime`; a short page ends the walk;
  it never requests a page past the window's end; the depth cap is **clamped**, not
  overshot, even with an awkward caller `pageSize`.
- cap recorded: call budget → `truncatedBy` set, `historyComplete` false, flag
  written `false`, `INCOMPLETE SYNC` logged; **a truncated front-fill clears a
  previously-true flag**; the wall-clock deadline is recorded identically;
  `deadlineMs: null` opts out cleanly.
- idempotency: re-running a complete walk makes zero `getMatch` calls.

Plus one in `lib/__tests__/mystats-refresh.test.ts` pinning that
`runMyStatsRefresh` passes `historyComplete`/`truncatedBy` through to the client.
That plumbing was a genuine silent gap: `toEqual` treats a missing key and an
`undefined` one as equal, so the two pre-existing pass-through tests would have
kept passing with the fields dropped. Both now assert them explicitly.

Two of my first-draft tests failed on the real default budget rather than on the
loop — the 30-call budget truncates a 70-new-game catch-up. The premise was mine,
not the code's; those two now pass an explicit budget to isolate the loop, and the
default-budget behaviour got its own convergence test instead of being papered
over.

---

### FIX 3 (P2) — real puuid in a publicly served file

`public/companion.ps1` is served from `https://coachbuild.vercel.app/companion.ps1`.
Its SelfTest `$realShape` fixture carried the user's real 78-character puuid, in
**two** places (the fixture and the `$expectedMeJson` string). Both replaced with
`SYNTHETIC-PUUID-NOT-A-REAL-ACCOUNT-0000000000000000000000000000000000000000000`
— same 78-char length, and nothing anywhere asserts a puuid's length or charset
(`ConvertTo-MeIdentity` checks present/string/non-blank), so the shape assertion
loses nothing. The comment above it now says the values are synthetic **and why
they must stay that way**, instead of implying the capture was the source.

**What the sweep of that file and `_capture/` found:**

- **`_capture/` is clean.** Every raw body has `"puuid":"[REDACTED]"`,
  `"gameName":"[REDACTED]"` etc., `scripts/capture-lcu.ps1` does the redaction, and
  the directory is gitignored and untracked. The capture's own redaction claim is
  **true**. The leak was authored directly into the fixture from the live client
  while the comment pointed at the (clean) capture as its provenance — the file
  claiming redaction and the file that broke it were not the same file.
- **No other long identifier-shaped string in `companion.ps1`.** A scan for
  `[A-Za-z0-9_-]{40,}` returns only those two lines (plus two ASCII rules).
  `summonerId = 1000000` is already synthetic; every other mock puuid in the file
  is already obviously fake (`mock-puuid-...`, `d0123456789abcdef0123`).
- **Also fixed, same class, lower exposure:**
  `components/__tests__/companionMe.test.ts` held a **44-character prefix** of the
  same real puuid. Not served publicly, but 44 characters is plenty to identify the
  account, and scrubbing one file while leaving the secret in a sibling is fixing
  the instance rather than the invariant. Replaced with a synthetic of the same
  length.
- **Reported, deliberately NOT changed — Riot IDs.** `MunsterHunter#EUW` and
  `K1ayer#swift` appear as plain names in `companion.ps1` (and in
  `lib/mystats/account.ts`'s `MY_RIOT_ID` default, `CLAUDE.md`, and elsewhere). A
  Riot ID is a public in-game display name, a different exposure class from an
  API-addressable puuid; `K1ayer#swift` specifically is load-bearing test data (a
  real custom tagLine is what proves `routingForServer("swift")` is null, which is
  why region resolution is server-side); and changing it in one file while it is
  public in ten others is theatre. **Flagging it for the user rather than deciding
  it.** If they want the names out too, it is a global rename, not a one-line fix.
- `HANDOFF.md` contains `WBGC6KIe…` — an 8-character elision. That is real
  redaction and not usable. Left as is.

**No companion version bump.** The change is a SelfTest fixture value; no
behaviour changed, so no re-install is required. (Also per the brief: no bumps.)

---

### Also fixed — `setActiveAccount` is now one transaction

`lib/mystats/account.ts`. The two UPDATEs run in a single Neon HTTP transaction
(`sql.transaction([...])`). Migration 0020's partial unique index already makes
*two* active rows unrepresentable; what it cannot prevent is a crash between the
statements leaving **zero** active, which renders the `accountUnresolved` empty
state for an account the user definitely linked. Safe direction, so never a P0, but
two statements that must both land are a transaction.

Order still matters *inside* the transaction (deactivate first) — statements
execute sequentially and the partial index is checked per statement.

**Deliberately NOT collapsed into `SET active = (id = $1)`**, which looks simpler
and is a trap: one UPDATE touching both rows may be executed in either row order,
and the index rejects the ordering that activates the new row while the old one is
still active — a duplicate-key error that depends on the plan rather than on the
data. That reasoning is in the code comment, not only here.

Test-side consequence: the Neon `sql` is a function *with a `.transaction`
property*, and a bare `vi.fn()` is not. Every sql mock in
`lib/__tests__/mystats-account.test.ts` now goes through a local `sqlMock()` helper
that supplies it. Two new assertions pin that exactly one transaction of exactly
two statements is issued, and that an unknown id issues none.

---

### Verified, and HOW

| claim | how |
|---|---|
| Fix 1's old query is dead / new one works | Ran both against the live Neon DB. Output pasted above. Plus the running walk's own log showing the failure once per unit. |
| Fix 1's script still loads and runs | `node --check` clean; `npx tsx scripts/ingest-otp-priority.mjs --dry-run --verbose` produced a real plan (22 champions with work, 12235 stored across 172 featured). Dry-run takes no lock and makes zero Riot calls. |
| No sibling dead reads | Swept every `my_ingest_cursor` query in the repo: all puuid-scoped except `purge.ts`'s deliberately account-wide UPDATE. Swept `id = 1` across all `.ts`/`.mjs`/`.tsx`: only comments remain. |
| Fix 2's loop | 14 new unit tests (above) with a fake Riot history + a *mutable* fake cursor, so cross-run convergence is exercised, not assumed. |
| Fix 2 spends no more key than before | No change to `lib/pro/pacer.ts`; per-run budget derived from the callers' existing `maxDuration = 60`. |
| Fix 3 | `grep -c` for the full puuid across the tree = 0 outside the 8-char elision in `HANDOFF.md`. `companion.ps1 -SelfTest` emits **no** `ConvertTo-MeIdentity` or `GET /me JSON shape drifted` failure, so the shape assertions pass against the synthetic value (SelfTest prints only failures). |
| whole tree | `verify-fix.sh` all green, 2478 tests. |
| no live Riot calls made | The walk **is** running (pid 27024, lock file present, log active). Every check I ran was read-only SQL, `--dry-run`, or a mocked unit test. |

### NOT verified — be explicit

- **The fixed `maybeRefreshMine` has not executed.** The live walk still runs the
  old code; I proved the replacement *query* against the real DB but not the
  function end to end, because doing so spends Riot calls through
  `runMyStatsRefresh` while the walk holds the key. Confirm after the next
  `CoachBuildOtpIngest` restart: `otp-priority.log` should show
  `refreshing my_matches (last incremental ...)` and no `MY_MATCHES SELF-REFRESH IS
  BROKEN`.
- **Fix 2 has never run against real Riot data.** Every test is mocked. The
  multi-page walk, the overlap detection against a real `my_matches`, and the
  convergence arithmetic are all unexercised in production. Same reason.
- **The multi-account case is still hypothetical in the data.** `my_account` holds
  exactly ONE row (MunsterHunter#EUW, 138 games, 2026-01-12 → 2026-07-29,
  `backfill_done = true`). Both of Fix 2's scenarios need a second linked account to
  actually occur. So Fix 2 is a fix for a defect that has not yet had the chance to
  produce wrong numbers — which is the right time to fix it, but it does mean
  nothing in the live DB confirms the *symptom* existed.
- **`companion.ps1 -SelfTest` reports 3 failures**, all in the double-launch guard:
  a real companion is running (PID 16500, since 2026-07-28) and holds the mutex.
  **Pre-existing and environmental, proved** — I extracted `git show
  HEAD:public/companion.ps1` to a temp file and ran its SelfTest: byte-identical
  three failures. Not from my change.
- **No browser smoke test.** Nothing rendered changed; `historyComplete` is
  additive and unconsumed by the UI.
- The `sqlMock` transaction stand-in *executes* the queries it is handed (a real
  Neon tagged template is lazy and only runs inside the transaction). Statement
  order and count are faithful; the actual BEGIN/COMMIT is the driver's, and is not
  covered by a unit test.

### Out of scope, left alone as instructed

`/api/mystats/matchups` applies no split filter while summary's `records` are
split-scoped, so a row's expansion can show more games than its header.
Pre-existing, not from this ship. Untouched — the user is being told separately.

### Left behind on purpose / for urgot

- **`C:/Claude/AI/coachbuild/_engy-fix1-probe.mjs`** — untracked read-only
  diagnostic (zero Riot calls) that reproduces Fix 1 in both directions. Re-run it
  after the walk restarts. **I could not delete it: the repo's safety-gate hook
  blocks every `rm`,** and the hook itself is broken — it fails with
  `mkdir: cannot create directory 'S:/AI'` and
  `touch: cannot touch 'S:/AI/urgot/data/approved.txt'` before blocking, i.e. it
  points at the dead `S:/AI/urgot` root and cannot write its own approval file or
  log. Per the "never route around a block" rule I stopped rather than working
  around it. **That broken hook is worth fixing independently** — right now it
  cannot be approved out of, so no destructive command can ever be authorised.
- Two dead leftovers noted by a previous round are still unreferenced in
  `components/hextech/itemSetBody.ts` (`idOrderKey`, `SITUATIONAL_CAP`). Still out
  of scope, still noted.
- `scripts/ingest-mystats.mjs` (backfill runner) is now arguably redundant with
  incremental subsuming it, but it is the only path that walks a whole history in
  one pass, so it should stay until someone deliberately retires it.

### Proposed wiki/CLAUDE.md updates (not applied — urgot merges)

- `CLAUDE.md`'s My Stats section still describes "ONE fixed linked Riot account"
  and lists migrations only to 0017. Both are stale as of the multi-account ship.
- New gotcha worth adding: **an incremental sync's stop-on-overlap needs a
  persisted completeness flag, or a truncated run manufactures its own false
  overlap.** That is the generalisable lesson here and it will apply to the next
  paginated catch-up anyone writes in this repo.
- New gotcha: **a per-run budget on a serverless ingest must be derived from
  `maxDuration`, not chosen.** A budget bigger than the wall does not fetch more —
  it gets the function killed before it can record what it did.
