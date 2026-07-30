<!-- merged into HANDOFF.md 2026-07-30 02:27:49Z; previous content preserved there. Append new rounds below. -->

# engy — My Stats data layer for the TrackDIFF-style /mystats rebuild

## §1 — THE CONTRACT fronty builds against (WRITTEN FIRST, 2026-07-30)

`GET /api/mystats/summary` is extended **additively**. Every field that existed before
keeps its exact name, type and meaning. Three groups are new.

### 1a. Per-account rank (on every entry of the existing `accounts[]` array)

```ts
interface MyAccountSummary {
  // -- unchanged, already shipped ------------------------------------------
  id: number;
  riotId: string;          // "MunsterHunter#EUW"
  gameName: string;
  tagLine: string;
  region: string;          // "EUW"
  active: boolean;
  lastSeenAt: string | null;
  games: number;

  // -- NEW (2026-07-30) ----------------------------------------------------
  /** "IRON".."CHALLENGER", uppercase, exactly as Riot spells it.
   *  null = we DID look and this account has no ranked solo/duo standing
   *  (genuinely unranked, or placements not finished). */
  tier: string | null;
  /** "I" | "II" | "III" | "IV". null whenever tier is null. Riot always sends
   *  "I" for MASTER/GRANDMASTER/CHALLENGER -- do not render a division for
   *  those three tiers. */
  division: string | null;
  /** League points, 0-100 in normal tiers, unbounded in apex. null whenever
   *  tier is null. */
  lp: number | null;
  /** Ranked solo/duo wins/losses for the CURRENT split, straight from Riot.
   *  null whenever tier is null. Display-only, like everything else here. */
  rankWins: number | null;
  rankLosses: number | null;
  /** TRUE = we do not know, as opposed to "unranked".
   *  Exactly one of these two readings is right at any time:
   *    rankUnknown === false  ->  tier/division/lp are the truth. tier === null
   *                               here means GENUINELY UNRANKED -- render the
   *                               "Unranked" state, not a blank.
   *    rankUnknown === true   ->  tier/division/lp are ALWAYS null and mean
   *                               NOTHING. Render a placeholder / "--", never an
   *                               unranked badge. Happens when: the account has
   *                               never been the active one (we only ever spend
   *                               a Riot call on the active account), or the
   *                               last fetch failed.
   *  A tier badge that renders blank on rankUnknown is the confidently-wrong-
   *  blank this field exists to prevent. */
  rankUnknown: boolean;
  /** ISO of when the stored rank was last read from Riot, or null when never.
   *  Lets the UI say "as of 14:05" instead of implying it is live. */
  rankCheckedAt: string | null;
}
```

Top-level convenience mirror of the ACTIVE account's rank, so the hero does not have to
hunt through `accounts[]`: `tier`, `division`, `lp`, `rankWins`, `rankLosses`,
`rankUnknown`, `rankCheckedAt` -- identical semantics, same values as
`accounts.find(a => a.active)`. On the `accountUnresolved:true` response they are
`null` / `rankUnknown:true`.

**Solo queue only.** `RANKED_SOLO_5x5`. Flex is not fetched, not stored and not surfaced --
if it ever is, it arrives under separate `flex*` names, never silently inside these.

### 1b. CS on the champion pool

The champion-pool array is the **existing `records[]`**. `championPool` is emitted as an
**alias of the same array** (identical object references, asserted by a test) so either
name works -- `records` is what already-shipped consumers read, `championPool` is the name
the redesign brief used. They can never disagree; do not compute one from the other.

```ts
interface ChampionSummary {
  // -- unchanged -----------------------------------------------------------
  championId: number;
  role: number;            // 0..4, -1 unresolved
  games: number;
  wins: number;
  winrate: number;         // 0..1
  lastPlayed: string;      // ISO

  // -- NEW -----------------------------------------------------------------
  /** TRUE average CS per minute across this champion+role, time-weighted:
   *  sum(cs) / (sum(gameDurationSec) / 60). NOT the mean of per-game rates --
   *  a 40-minute game and a 20-minute game do not average their rates.
   *  null when csGames === 0. Rounded to 1 decimal. */
  csPerMin: number | null;
  /** How many of `games` are actually behind csPerMin. ALWAYS <= games, and
   *  frequently smaller: rows ingested before this ship have no CS yet, and
   *  games under 300s are excluded (see 2). Render the denominator, or at
   *  least refuse to show csPerMin when csGames is tiny. */
  csGames: number;
}
```

### 1c. CS on recent games

```ts
interface RecentGame {
  // -- unchanged -----------------------------------------------------------
  championId: number;
  role: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  onWpaBuild: boolean | null;

  // -- NEW -----------------------------------------------------------------
  /** Raw creep score for this one game (minions + neutral monsters).
   *  null = not stored for this row (pre-ship row, not yet backfilled). */
  cs: number | null;
  /** Game length in seconds. null on pre-ship rows. */
  gameDurationSec: number | null;
  /** cs / (gameDurationSec / 60), 1 decimal. null when either input is null
   *  OR the game is under 300s (see 2) -- a 4-minute remake's "rate" is
   *  noise, so it is withheld rather than shown. `cs` and `gameDurationSec`
   *  are still populated for such a row, so the UI can still show "12 CS in
   *  3:41" if it wants to. */
  csPerMin: number | null;
}
```

### 1d. Headline KPI

Top-level, account-wide, current split (same scope as `buildAdherencePct`):

```ts
csPerMin: number | null;   // time-weighted across the whole current split
csGames: number;           // games behind it; 0 => csPerMin is null
```

### Not built, deliberately -- see 4

`avgScore`, `mvp`/`ace`, `placement`, `avgGameElo` are **absent from the response** and
will stay absent. Do not leave a slot expecting them.

## §2 -- Short games and remakes

Stored always, excluded from every RATE. Threshold `CS_MIN_GAME_SEC = 300` (5 minutes),
one exported constant in `lib/mystats/cs.ts`.

Why 300 and not Riot's 3:00 remake vote: a remake ends at ~3:20 with the duration Riot
reports, but early FF/disconnect games in the 3-5 minute band are equally rate-noise (a
jungler with 8 CS at 4:10 reads as 1.9 CS/min and drags a real 7.0 average down hard).
Below 5 minutes there is no laning phase to measure, so the number would not be a
measurement of anything. Above it, everything counts -- no upper bound, no other filter.

The row is never dropped: `cs` and `game_duration_sec` are stored for a 3-minute remake
exactly like any other game. The exclusion happens at aggregation time only, so changing
the threshold later is a one-constant change with no re-ingest.

## §3 -- What landed

### Files

| File | Change |
|---|---|
| `migrations/0021_mystats_cs.sql` | `my_matches.cs`, `my_matches.game_duration_sec`. APPLIED. |
| `migrations/0022_mystats_rank.sql` | `my_account.rank_{tier,division,lp,wins,losses,checked_at,attempted_at}`. APPLIED. |
| `lib/pro/extract.ts` | NEW `creepScore()` -- the one CS formula, now shared. `extractGameStats` calls it. |
| `lib/pro/types.ts` | NEW `RiotLeagueEntryDto` (shape OBSERVED live, not from docs). |
| `lib/pro/riot.ts` | NEW `getLeagueEntriesByPuuid(platform, puuid)`. |
| `lib/mystats/cs.ts` | NEW. `CS_MIN_GAME_SEC`, `countsTowardCsRate`, `csPerMinForGame`, `aggregateCs`. |
| `lib/mystats/rank.ts` | NEW. Fetch/persist/TTL/selection, all pure parts separately testable. |
| `lib/mystats/extract.ts` | Pulls `cs` (via `creepScore`) + `gameDurationSec`. |
| `lib/mystats/types.ts` | CS on `ExtractedMyMatch`/`MyMatchRow`, rank on `MyAccountRow`, `gameDuration` + the two minion fields on the Riot shapes. |
| `lib/mystats/aggregate.ts` | CS threaded into `summarizeByChampion` + `buildRecentGames`; NEW `computeCsSummary`. |
| `lib/mystats/account.ts` | `listAccounts` returns rank via `rankFromRow`. |
| `lib/mystats/ingest.ts` | INSERT carries `cs`, `game_duration_sec` -- new matches self-populate. |
| `app/api/mystats/summary/route.ts` | All new fields, additively. |
| `scripts/backfill-mystats-cs.mjs` | NEW. Walks EVERY linked account (the KDA script is active-only -- see below). |
| `lib/__tests__/mystats-cs.test.ts` | NEW, 24 tests. |
| `lib/__tests__/mystats-rank.test.ts` | NEW, 25 tests. |

### Proof on real rows

`gameDuration` IS seconds, verified rather than assumed -- measured min 73s / max 3045s
across the backfilled rows, i.e. the normal 1-51 minute band. The millisecond form (Riot
pre-11.20) is unreachable here because the table is season-scoped to 2026, so no
magnitude guard was added; a guard keyed on magnitude would be untestable against real
data and would silently rescale a legitimately long game.

Newest real rows after backfill:

```
riot_id              match_id           champ role  cs  dur_sec  cs/min
K1ayer#swift         EUW1_7934363887     38    -1    39   1372    1.7
K1ayer#swift         EUW1_7933884838    112     2   222   2093    6.4
MunsterHunter#EUW    EUW1_7933781384     54     0   241   2230    6.5
MunsterHunter#EUW    EUW1_7933656564     50     0   262   2329    6.7
MunsterHunter#EUW    EUW1_7930659630    112     0   311   3045    6.1
MunsterHunter#EUW    EUW1_7930183601    904     0   231   1933    7.2
```

**The aggregation choice is measurable on live data, not just in a fixture** -- this is
why the raw columns are stored instead of a rate:

```
riot_id              split  cs_games  TIME-WEIGHTED  naive mean-of-rates
K1ayer#swift           2        2         4.5              4.0
MunsterHunter#EUW      1       22         5.4              5.5
MunsterHunter#EUW      2       80         5.1              5.1
```

6 real games in the table are under 300s and are excluded from every rate.

Rank, live end-to-end through `refreshStaleRanks` (the actual route path):

```
PASS 1 (cold):  riot calls spent: 2
  MunsterHunter#EUW  active=true   PLATINUM IV  89 LP  65W/66L  rankUnknown=false
  K1ayer#swift       active=false  EMERALD  IV  57 LP  80W/56L  rankUnknown=false
PASS 2 (immediately after):  riot calls spent: 0   <- TTL gating, proven live
```

K1ayer's real league-v4 response carries BOTH a solo entry and a `RANKED_FLEX_SR`
GOLD III entry. The stored value is the EMERALD IV solo one, so the queueType filter is
verified against the exact data that would have broken an index-based pick. The active
account was not changed by any of this (`MunsterHunter#EUW` is still active).

### Decisions worth knowing

- **`records` and `championPool` are the SAME array by reference**, built once and
  emitted twice. Not two calls to `summarizeByChampion` -- two independent computations
  of one fact is gotcha (dd). Pinned by a reference-identity test.
- **Rank TTL is 30 minutes, not coachless.ts's 6 hours.** Deliberate deviation from the
  brief's suggestion, one exported constant (`RANK_TTL_MS`) to change back. LP moves
  every ranked game, so a 6-hour-old LP is routinely a wrong number shown as current,
  whereas coachless's build aggregates barely move within a patch. The cost is bounded
  because the TTL is enforced against a DB column rather than per-process memory: ~48
  calls/day/account against a budget of 100 per 2 MINUTES. The hard constraint the brief
  set -- not a call per page view -- holds with large margin, and `rankCheckedAt` ships
  so the UI never has to imply the number is live.
- **The rank cache is in Postgres, not in module state.** An in-process TTL on Vercel is
  per-lambda-instance, so N cold instances make N calls for the same fact.
- **At most 2 accounts refresh per request** (`RANK_REFRESH_MAX_PER_REQUEST`): the active
  one, then the stalest other. That is what lets a non-active account's card fill in at
  all without the fan-out the brief forbids. Steady state is zero calls.
- **A failed refresh keeps the last good reading.** `rank_checked_at` (last success) and
  `rank_attempted_at` (last attempt) are separate columns precisely so a transient Riot
  failure backs the call off WITHOUT blanking a badge that was correct a minute ago. The
  staleness is disclosed via `rankCheckedAt` rather than hidden.
- **`scripts/backfill-mystats-cs.mjs` walks every linked account**, unlike
  `backfill-mystats-kda.mjs`, which is active-account-only because it predates
  multi-account. That older script will therefore never fill a non-active account's
  KDA -- pre-existing, out of scope for this pass, flagged as a follow-up.

### Two environment notes for whoever runs the gate next

- **`verify-fix.sh`'s BUILD step is unreliable while a `next dev` is up on this
  checkout** -- CLAUDE.md gotcha (i), hit live here. fronty's dev server (`next dev -p
  3007`, PID confirmed) was running in parallel, and `next build` failed twice on
  DIFFERENT, untouched routes each time (`/mystats` + `/` on one run, `/api/ingest/otp` +
  `/api/pros` on the next) before passing clean on a third with no code change between.
  Non-deterministic failures on routes the diff never touches is the signature; do not
  debug it as a code defect. Final state: **verify-fix ALL CHECKS PASSED, 2622 tests**
  (up from 2501).
- **The CS backfill ran concurrently with the `ingest-mystats` process that was still
  walking K1ayer** (started 07:10, still alive). `lib/pro/pacer.ts` only serialises Riot
  calls WITHIN a process, so the two together spent against one key at roughly double the
  intended rate. It completed 162/162 with zero failures and zero 429s, so nothing was
  harmed -- but that was margin, not design. Worth knowing before someone runs two
  Riot-spending scripts side by side on a busier day.

### Not done / verified-absent

- **`components/hextech/myStats.ts` is untouched** -- it is fronty's surface. It
  normalizes `records` and will pass the new fields through only once fronty widens
  `normalizeRecord`. The API side is complete and correct independently.
- **The CS backfill covers pre-0021 rows only.** New matches self-populate through
  `lib/mystats/ingest.ts`. Rows that fail their Riot re-fetch stay NULL and are excluded
  from every figure rather than counted as zero.
- **No `next: { revalidate }` was added to the Riot fetch path.** `riotFetch` is shared
  with every other pipeline and adding Next fetch-caching there would change caching
  behaviour for match ingest too -- out of scope and risky.

## §4 -- Avg Score / MVP / ACE / placement / Avg Game ELO -- NOT BUILT

None of these were built, no formula was invented, and no field for any of them exists on
the response. Assessed individually rather than dismissed as a group:

- **Avg Score** -- a proprietary composite. There is no published definition, so any
  version I wrote would be a formula of my own invention rendered in the same typeface as
  the measured numbers beside it. Not derivable. Not built.
- **MVP / ACE** -- these are *rendered* by other sites from a composite score, so they
  inherit Avg Score's problem exactly: computing them means first inventing the score.
  Not built.
- **Placement within the match ("10th", "4th")** -- same. A placement is a RANKING over a
  per-player score, so it cannot exist before the score does. Worth stating plainly
  because it looks more objective than it is: a rank over an invented number is still an
  invented number, just harder to argue with.
- **Avg Game ELO** -- this is the one with a real, honest partial path, so it gets a
  derivation rather than a flat refusal. We could call league-v4 for the nine other
  participants of a match and average their tiers. It is still NOT built, for three
  reasons, and I recommend against it: (1) cost -- 9 extra Riot calls PER MATCH against a
  shared key that suspends the whole app when it trips, which is 1,494 calls to backfill
  the 166 rows currently stored; (2) it would be measured at *fetch* time, not at *game*
  time, so a game from March would be labelled with the players' ranks TODAY -- a number
  that silently changes meaning the longer ago the game was; (3) match-v5 does not carry
  participant ranks, so there is no cheap path. **If you want it, the honest version is a
  forward-only field populated at ingest for NEW matches only, labelled "avg rank at time
  of ingest", never backfilled.** Your call -- I have left it unbuilt.

The `records`/`championPool` entries and `recentGames` entries carry exactly the fields in
§1 and nothing speculative alongside them.

---

# engy — SoloQ-only read filter (2026-07-30, round 2)

## What was wrong

`lib/mystats/ingest.ts`'s header asserted that "filtering by queue happens at READ time."
Nothing filtered by queue at any read path. The intent was written down and the
enforcement was never built — a contract with one half missing.

Live DB before the fix:

```
K1ayer#swift       420 -> 141   440 -> 26   400 -> 15   2450 -> 2   480 -> 2   (186 stored)
MunsterHunter#EUW  420 -> 138                                                  (138 stored)
```

So 45 of K1ayer's 186 games were flex / normal draft / quickplay / swiftplay, and every
figure on `/mystats` counted them: season game count, win rate, build adherence, champion
pool, CS/min, prior-split delta, the account-card `games` number, and the 20-game Match
Performance chart (9 of its newest 20 rows were not solo queue). MunsterHunter was clean
only by accident.

## The fix

**One constant, one place: `lib/mystats/queues.ts`.** `COUNTED_QUEUE_IDS = [420]`,
`RANKED_SOLO_QUEUE_ID`, `isCountedQueue()`, `COUNTED_QUEUE_LABEL`. Every read binds the
ARRAY (`queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])`). No read inlines `420`.

Read paths changed — all six queries:

| File | Query | Feeds |
|---|---|---|
| `app/api/mystats/summary/route.ts` | main rows | `records` / `championPool` / `matchup` / `csPerMin` / `csGames` |
| `app/api/mystats/summary/route.ts` | adherence rows | `buildAdherencePct` / `winrateOnBuild` / `winrateOffBuild` / `nOnBuild` / `nOffBuild` |
| `app/api/mystats/summary/route.ts` | prior-split rows | `priorSplitWinrate` |
| `app/api/mystats/summary/route.ts` | recent rows | `recentGames` (Match Performance) |
| `app/api/mystats/matchups/route.ts` | both branches (role given / omitted) | `matchups` |
| `lib/mystats/account.ts` `listAccounts` | games subquery | `MyAccountSummary.games` (the account card) |

**Plus a seventh the brief did not list: `lib/draft/recommend.ts`'s
`attachPersonalRecords`.** It is a real read of `my_matches` on a different page — the
Draft board's `personal` / `personalOverall` badges ("you: 7-3 on this champion"), read
while drafting a ranked solo game. Same constant, same predicate. CLAUDE.md gotcha (dd)
applies: the card is never the only consumer.

**No rows were deleted.** The non-420 rows stay in the table. The one-stream ingest
rationale still holds and a future flex-queue view would want them.

**The ingest header now describes what actually happens** — it names
`lib/mystats/queues.ts` as the other half, names every read that binds it, and warns
against "optimising" the filter into an ingest-time one (the table would still hold every
row ingested before such a change, so the read filter would not become redundant).

## Live proof

Through the REAL modules (`scripts/_tmp-verify-queue-filter.mts`, `npx tsx`):

```
COUNTED_QUEUE_IDS = [ 420 ]

BEFORE -> AFTER (listAccounts):
  K1ayer#swift         186 -> 141
  MunsterHunter#EUW    138 -> 138

recentGames for K1ayer#swift (newest 20):
  BEFORE queue ids: 2450,2450,420,420,440,420,420,420,420,420,420,440,440,440,420,420,420,440,440,440
  AFTER  queue ids: 420,420,420,420,420,420,420,420,420,420,420,420,420,420,420,420,420,420,420,420
  non-420 rows: 9 -> 0

priorSplitWinrate, K1ayer split 1:  0.5519 over 183  ->  0.6000 over 140
matchups, K1ayer champion 112:      76 games -> 71 games
```

And over HTTP against a real `next start` + the live DB:

```
GET /api/mystats/summary -> 200, cache-control: no-store
accounts: [{"riotId":"K1ayer#swift","games":141,"active":true},
           {"riotId":"MunsterHunter#EUW","games":138,"active":false}]
records:  [{championId:112, role:2, games:1, wins:1, winrate:1, csPerMin:6.4, csGames:1}]
buildAdherencePct: null   nOnBuild: null   nOffBuild: null
winrateOnBuild: null      winrateOffBuild: null
priorSplitWinrate: 0.6    csPerMin: 6.4    csGames: 1
NaN anywhere in the body? false
```

Note K1ayer's CURRENT split (2) holds only 3 stored games, 1 of them solo — so the live
response is already exercising near-zero denominators, and it answers `null` (not `0.0%`,
not `NaN`) for every figure with nothing behind it. That is the shipped code, not a
fixture.

## Tests (2622 -> 2633)

`lib/__tests__/mystats-queue-invariant.test.ts` — new, and STRUCTURAL, deliberately
mirroring `mystats-scoping-invariant.test.ts`. It intercepts every statement each route
issues and asserts that any statement touching `my_matches` binds `COUNTED_QUEUE_IDS`. A
query added six months from now without the predicate fails the suite without anyone
having to think to write a new test. It also fails a query that hardcodes `queue_id = 420`
instead of importing the constant, by construction — it asserts the bound array, not the
SQL text.

Behavioural halves in the same file: a mixed-queue fake table proving flex / normal /
quickplay / swiftplay / ARAM rows reach no figure (records, win rate, adherence, CS/min,
recent games), the same for the matchups route, and — the consequence this fix creates —
an account whose stored games are ALL non-counted renders the empty state: `records: []`,
every winrate/adherence field `null`, `csGames: 0` (a real zero count, not a null figure),
`recentGames: []`, plus a whole-body assertion that no `NaN` appears anywhere.

`lib/__tests__/mystats-account.test.ts` — new case pinning `listAccounts`' games count to
the constant, and pinning the `LEFT JOIN` + `COALESCE`: an account whose games are all
non-counted must stay in the picker with 0 games, not vanish from the list the user needs
in order to switch back to it.

**I verified the invariant test actually fires.** Removing the filter from one matchups
branch failed both the structural assertion and the behavioural one; reverted.

`lib/__tests__/mystats-routes.test.ts` — two existing matchups tests decoded their bound
values POSITIONALLY (`const [puuid, championId, role] = values`), which broke the moment a
queue array was bound ahead of `championId`. Rewritten to decode by TYPE, and their
fixtures gained flex / normal-draft rows for the same champion+role so they now pin the
role scope and the queue scope at once. A test that reads its inputs positionally fails on
the next predicate added rather than on the bug it was written to catch.

## Reads deliberately NOT filtered, with reasons

- **`lib/mystats/ingest.ts`'s already-stored id check.** MUST stay unfiltered. It asks
  "have I stored this match id", and the ingest stores every queue. Filtering it would
  re-fetch every non-420 match forever against a shared Riot key, and would break the
  overlap signal the incremental walk's termination depends on.
- **`lib/mystats/purge.ts`** — pre-season row deletion and its counts. Storage
  maintenance; queue-agnostic on purpose.
- **`lib/mystats/refresh.ts`'s `latest`** (`max(game_creation)`). Ingest freshness, not a
  stat. It is declared in `MyStatsRefresher.tsx`'s prop type and never rendered. If it
  ever IS rendered as "your last game", it needs the filter — flagging rather than
  pre-emptively changing it.
- **`scripts/backfill-mystats-kda.mjs` / `backfill-mystats-cs.mjs`** — they fill columns
  on stored rows. Filtering would leave non-420 rows permanently unbackfilled for no gain.
- **`scripts/ingest-otp-priority.mjs`'s `myGames`** — the one real judgment call. It
  counts a user's games per champion to decide which OTP champions get deep-walked. It is
  scheduling input, never displayed, and `lib/otp/deepWalk.ts`'s header already argues at
  length that it is not a stat and not a ranking of anything shown. Left unfiltered:
  "which champions do I play" is a legitimately broader question than "my solo record".
  Say the word and it is a one-line change.

## Open / for urgot

- **`app/mystats/page.tsx` and `components/hextech/mystats/*` are fronty's** and were not
  touched. Worth one check on their side: with `accountUnresolved: false` but
  `records: []` and every figure `null`, does the page render its empty state cleanly?
  The backend now produces that combination for a real account.
- **`CLAUDE.md`'s My Stats paragraph** still reads as though all stored queues count. Left
  alone to avoid a merge conflict with fronty's in-flight edits — worth a one-line
  amendment when the tree settles.
- Version NOT bumped, nothing committed, nothing deployed.
- `verify-fix.sh` green: tsc clean, lint 0 warnings, **2633 tests**, build clean, sw,
  manifest. (One earlier run failed tsc on `app/mystats/page.tsx` referencing
  `BuildAdherenceNote` — fronty's untracked new component mid-edit, not this change; green
  on re-run once that landed.)
