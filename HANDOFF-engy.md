<!-- merged into HANDOFF.md 2026-07-26T01:46:18Z; previous content preserved there. Append new rounds below. -->

## 2026-07-26 — Security cluster (audit "STILL OPEN" items 2-4; items 5-6 already fixed, see below)

Scope was `app/api/**`, `lib/prostage/**`, `lib/pro/**`, `public/companion.*`, `migrations/**`.
`components/**` was engo's concurrent workstream — untouched, confirmed via `git status` before and
after. One pre-existing test failure (`components/__tests__/itemSetBody.test.ts`, "Abyssal via curated
verbatim") is inside that scope and was already failing before I started (engo's in-progress P2 fix) —
not something I broke.

### 1. P1-3 security — `/api/prostage/timeline` unauthenticated cost amplifier — FIXED

**Files:** `migrations/0016_prostage_timeline_backoff.sql` (new), `app/api/prostage/timeline/route.ts`,
`lib/prostage/timelineBackoff.ts` (new), `scripts/backfill-prostage-timelines.mjs`,
`lib/__tests__/prostage-timeline-route.test.ts` (new).

Added two columns (`timeline_next_attempt_at`, `timeline_attempt_count`) that do ONE job with two
effects:
- **In-flight de-dup.** Before touching the network, the route atomically claims the game via
  `UPDATE ... SET timeline_next_attempt_at = now() + 45s WHERE game_id=$1 AND timeline_status IS NULL
  AND (timeline_next_attempt_at IS NULL OR timeline_next_attempt_at <= now()) RETURNING ...`. Postgres
  row-level locking makes this race-safe: a concurrent request's UPDATE blocks until the winner
  commits, then re-evaluates the WHERE clause against the now-advanced timestamp and returns 0 rows —
  no walk, no network call, just an immediate 429. This is what stops a BURST of simultaneous requests
  for the same never-resolved game from each independently launching their own ~750-request walk.
- **Cooldown after `transient`.** On a `transient` result the same column is pushed out with
  exponential backoff (`computeBackoffSeconds`: 60s, 120s, 240s, ... capped at 1h, keyed off a
  persisted `timeline_attempt_count`) — so the next identical request can no longer re-trigger the
  walk immediately. **`timeline_status` is never touched on a transient result — it stays exactly
  NULL, same as before the fix.** I did not touch the transient-vs-terminal taint discipline the audit
  flagged as "do not touch" (verified: `resolveGame.ts` / `timeline.ts` are otherwise unmodified except
  for the fetch-timeout wrapping in item 2 below).
- **Self-healing lease.** If the function dies mid-walk (crash / maxDuration kill), the 45s lease
  simply expires and the row becomes claimable again — no separate unlock step.

Route now returns 429 (with a `Retry-After` header) for "already computing" / "still cooling down",
distinct from the 500 "transient, just failed" and 503 "DB unavailable" it already had.

Also patched `scripts/backfill-prostage-timelines.mjs`'s cursor query to skip a game whose lease/backoff
is still active (`AND (timeline_next_attempt_at IS NULL OR timeline_next_attempt_at <= now())`) — this
script isn't in the named scope but writes the exact same columns/rows the route does, and without this
it could stomp an active claim and reopen the double-walk problem from a different caller. It does NOT
independently set backoff on its own transient results (left as pre-existing behavior: "leaves NULL for
retry") — acceptable since this is a human-run, deliberately-small-limit tool, not the unauthenticated
internet-facing surface the audit is about.

**Tests (7 new, all in the "cooldown / in-flight claim / backoff" describe block explicitly FAIL
against pre-fix HEAD — that code had no such column/claim/cooldown and fell straight through to
compute):** future-cooldown bounces 429 with zero DB writes beyond the read; losing the claim race
bounces 429; a transient result sets backoff=60s at attempt 1 and verifies the exact SQL values
(`backoffSec`, `attemptCount`, `gameId`) reaching the UPDATE; a repeated transient failure compounds
backoff to 480s from a persisted `timeline_attempt_count=3`; an `unavailable` result clears the backoff
columns alongside the terminal status; an `ok` result persists every claimed row and clears backoff.
Plus 3 pure unit tests for `computeBackoffSeconds` (doubling, 1h cap, non-positive input floors to
attempt 1) — pure/no DB. Existing "ok"/"unavailable"/400/503 contract tests were preserved unchanged
and still pass (they don't exercise the new column at all).

**Verification gap, stated plainly:** the atomic-claim race-safety relies on standard Postgres
row-level-lock semantics for `UPDATE ... WHERE ...`, which I did not independently verify against a
live Postgres instance this session (route tests mock `sql` — they prove the route ISSUES the right
query, not that Postgres's locking behaves as documented under real concurrent load). This is standard,
well-documented Postgres behavior, not a novel claim, but it's still untested-live.

### 2. P2 security — no timeouts on any hot outbound fetch path — FIXED

**New:** `lib/fetchTimeout.ts` — single `fetchWithTimeout(url, init?, timeoutMs?)` helper (default 8s,
`FAST_FETCH_TIMEOUT_MS`=4s for high-fanout paths). Layers an abort on top of any caller-supplied
`signal` rather than replacing it (matters for `lib/coachless.ts`'s `post()`, which already accepted an
optional signal from `staticData.ts`'s ~4s patch-candidate probe).

**Wired into every bare `fetch(url)` I could find under my owned directories, plus the two
cross-cutting choke points the audit named (`lib/coachless.ts`, `lib/staticData.ts`) that
`heroStats.ts`/`patchMovers.ts` funnel through without calling `fetch` themselves:**
`lib/pro/riot.ts`, `lib/pro/lolpros.ts`, `lib/prostage/timeline.ts` (all 3 call sites, at
`FAST_FETCH_TIMEOUT_MS`), `lib/prostage/resolveGame.ts` (`ddragonJson`), `lib/prostage/lolesports.ts`,
`lib/prostage/ddragon.ts`, `lib/prostage/cargo.ts` (both `cargoQuery` and the CargoExport transport),
`lib/prostage/liveIngest.ts` (`fetchWindowAt`, at `FAST_FETCH_TIMEOUT_MS`), `lib/coachless.ts` (`post` —
the shared choke point behind `/api/build`, `heroStats.ts`, `patchMovers.ts`, `draft/recommend.ts`),
`lib/staticData.ts` (`fetchJson`).

**Deliberately NOT touched:** `lib/pro/seedCrossregion.ts` (one-off backfill-script utility, not a
live/hot request path — see its own header); `lib/draft/**` and `lib/mystats/**` (outside my named
scope and outside the audit's security-cluster findings). `lib/prostage/cargo.ts` already has its own
rate-limit/pacer discipline (30s floor, sticky-limit backoff) — the timeout there is a hung-socket
guard on top of that, not a replacement for it; confirmed the 429/ratelimit detection path (`res.status
=== 429` / body-text sniffing) is untouched and still works off the real HTTP response, not the abort
path.

**Verification:** `npx tsc --noEmit` clean, full `npx vitest run` shows no regressions from this change
(1591/1592 pass; the 1 failure is the pre-existing engo-scope one above) — several existing tests
exercise these modules' injectable-`deps` seams rather than the raw `fetch`, so this is necessary but
not sufficient proof; I did not spin up a real slow/hanging endpoint to confirm the abort actually
fires in ~4s/8s wall-clock in this session (would need a live network double, out of scope for a unit
gate run).

### 3. P2 security — `/api/patch-movers` amplification — FIXED

**Files:** `app/api/patch-movers/route.ts`, `lib/patchMoversCache.ts` (new),
`lib/__tests__/patch-movers-route.test.ts`.

Two independent problems:
- **Cache-key bypass.** The route now reads `req: NextRequest` and 308-redirects ANY request carrying
  a query string (including the legacy accepted-but-ignored `?role=`) to the canonical bare path
  *before* touching the compute path — the redirect itself makes zero coachless calls, so junk-param
  spam can no longer buy a free pass around the CDN's 24h edge cache. A real client's plain
  `fetch('/api/patch-movers')` (the only way `app/movers/page.tsx` calls it) is never redirected.
- **Outage amplification.** `computePatchMoversBounded()` in the new `lib/patchMoversCache.ts` adds an
  instance-scoped module-level cache + single-flight guard, mirroring the existing pattern in
  `staticData.ts`'s patch-resolution cache: a healthy result is reused for 6h, a degraded
  (`unsupported`/empty-movers) result for only 2m so a real outage recovers fast, and concurrent
  requests on one warm instance collapse into ONE `computePatchMovers()` call via a shared in-flight
  promise. A rejected compute is explicitly NOT cached (next request retries immediately rather than
  looping on a poisoned entry).

I split the cache/bound logic out of the route file into `lib/patchMoversCache.ts` (same for
`lib/prostage/timelineBackoff.ts` in item 1) after `tsc --noEmit` caught that Next's generated
`.next/types/app/**/route.ts` checker rejects ANY export from a route file outside the small
GET/POST/config/runtime/dynamic/maxDuration whitelist — a test-only export like
`__resetPatchMoversCacheForTests` or `computeBackoffSeconds` fails that generated-type check. Both
route files now only export `GET` + the Next config constants; the testable logic lives in `lib/`.

**Tests (8 new, split across two describe blocks explicitly FAILING against pre-fix HEAD — that route
had no `req` param, no redirect, and called `computePatchMovers()` unconditionally on every request):**
a junk-query-param request redirects with zero calls to the engine; a legacy `?role=2` bookmark also
redirects; the bare canonical URL is NOT redirected; a burst of 3 concurrent requests during an outage
collapses to exactly 1 engine call; a degraded result is reused on an immediately-following request
(no re-compute); a successful result is likewise reused; a rejected compute is NOT cached and the next
request retries. The 4 pre-existing contract tests (unsupported/empty/real-movers/no-args) were updated
only to pass a `NextRequest` and to call `__resetPatchMoversCacheForTests()` in `beforeEach` (module-level
cache state persists across tests in the same file otherwise) — their assertions are unchanged.

**Verification gap, stated plainly:** the amplification bound is scoped to a single warm serverless
instance and resets on cold start — it does NOT coordinate across many concurrently-cold Vercel
instances during a real outage spike. This is the same limitation `staticData.ts`'s existing
patch-resolution cache already has in this codebase (I followed that precedent rather than introducing
a new cross-instance mechanism like Redis, which would be new infra for this app). The CDN's own 24h
cache remains the cross-instance defense for the healthy case; this bound only helps the
degraded/bypassed case, and only per-instance.

### 4. P2 security — TLS validation disabled process-wide rather than loopback-scoped — FIXED (with a stated verification gap)

**File:** `public/companion.ps1`, `Initialize-TlsShim`.

Replaced the `AlwaysTrue` compiled delegate with `ValidateLoopbackOnly`: it inspects the TLS callback's
`sender` (cast to `HttpWebRequest` first, then `ServicePoint` — PS 5.1's `Invoke-WebRequest`/
`Invoke-RestMethod` on .NET Framework can hand back either shape depending on the call path) to
determine the target host, and only bypasses certificate validation when that host `IsLoopback`. Every
other target — concretely, the one non-loopback HTTPS call this script ever makes,
`Test-AutoUpdate`'s `companion.version` check against `coachbuild.vercel.app` — now gets REAL
certificate validation (`sslPolicyErrors == None`). Any unrecognized `sender` shape (cast fails on both
attempts, or any exception) falls through to strict validation rather than widening trust — a
type-inspection miss can only make the shim STRICTER than before, never introduce a new hole. Stayed a
COMPILED `Add-Type` delegate (not a scriptblock) to preserve the v1.2.2 runspace-affinity fix the file's
header documents — the TLS handshake callback runs on a threadpool thread with no PowerShell runspace,
and a scriptblock would throw there.

Confirmed the audit's other two findings about this shim are unaffected and don't need touching: the
`irm|iex` install/update chain still isn't MITM-able via this shim (every such call spawns a FRESH
`powershell.exe` where the shim hasn't run — I didn't change the install/update code path at all), and
`Test-AutoUpdate` still only feeds the fetched version string into a balloon-tip string, never
downloads/executes anything.

**Ran `powershell -File public/companion.ps1 -SelfTest`** after the edit — `SELFTEST PASSED`. This
confirms the script still parses/compiles cleanly (the C# `Add-Type` block is syntactically valid) and
every non-TLS-dependent bridge/gameflow/rune/item-set assertion still holds.

**Verification gap, stated plainly: I could NOT exercise the actual loopback-vs-non-loopback branching
logic against a real self-signed certificate in this session.** `-SelfTest`'s mock LCU (per the file's
own header) is a plain `HttpListener` over HTTP, not HTTPS — it never triggers
`ServerCertificateValidationCallback` at all, so SelfTest passing does NOT prove `ValidateLoopbackOnly`
correctly (a) accepts the LCU's real self-signed loopback cert or (b) correctly rejects/validates a
real non-loopback cert. There is no League client / real LCU available in this environment to test
against. This is a real gap — the change is reasoned from documented .NET behavior (the `sender`
parameter shapes for `HttpWebRequest`-backed calls) and a safe fail-toward-strict-validation design, not
live-verified. Flag for whoever ships this to smoke-test on a machine with a real League client before
calling it done: open the companion, enter champ select, confirm the rune/item-set apply still works
(proves the loopback branch still accepts the LCU), and check the update-nag balloon still behaves
sanely (proves the non-loopback branch didn't break the version check).

**Ship note:** this is a "COMPANION CHANGE" per this repo's existing convention (see CLAUDE.md's
companion-bump checklist / CHANGELOG's "(COMPANION CHANGE → x.y.z — re-install required)" tag) — I did
NOT bump `$script:Config.Version` (currently `'1.6.4'`) per the "no version bump" constraint, but
whoever ships this needs to bump it before running `prebuild` (`sync-companion-version.mjs` derives
`companion.version` from that literal), and users need the re-install nudge since the fix only takes
effect in a freshly-launched companion process.

### 5 & 6. P1-1 (`/apply-runes` body.name guard) and P1-2 (`companion.version` frozen) — ALREADY FIXED, no action taken

My brief listed these as items 5-6 to fix, but they are **not** in `AUDIT-2026-07-25.md`'s own "STILL
OPEN — next session" list at the top of the file, and I verified why before touching anything:

- **`Test-RunePayload`** (public/companion.ps1, ~line 786) already exists, is already wired into
  `Invoke-ApplyRunes` STEP 2 (`if (-not (Test-RunePayload -Body $Body)) { return @{ ok=$false;
  reason='invalid-page' } }`), and already enforces the `CoachBuild`-prefix gate mirroring
  `Test-ItemSetsPayload`. The audit's own FIX PROGRESS table confirms this shipped in v0.56.0.
- **`public/companion.version`** already reads `{"version":"1.6.4"}`, matching
  `$script:Config.Version`, and `scripts/sync-companion-version.mjs` (which runs as a `prebuild` step,
  wired in `package.json`) now derives it structurally from the `companion.ps1` literal so it can't
  drift again — also already shipped per the FIX PROGRESS table.

I did not modify either file for these two items. Flagging this so the brief can be corrected for next
time — the "STILL OPEN" list should have been the authoritative source I was pointed at, and it was
right; my dispatch brief just hadn't been refreshed against it.

### Gate results

- `PATH="/c/Program Files/nodejs:$PATH" npx tsc --noEmit` — clean, 0 errors.
- `PATH="/c/Program Files/nodejs:$PATH" npx vitest run` — 1591/1592 pass. The 1 failure
  (`components/__tests__/itemSetBody.test.ts`, Abyssal-via-3001) is pre-existing, inside engo's
  concurrent `components/**` scope, and unrelated to any file I touched (confirmed via `git status`
  before starting — that file and `components/hextech/itemSetBody.ts` were already modified, plus an
  untracked `components/__tests__/_tmp_itemcheck.test.ts` scratch file, all engo's).
- `PATH="/c/Program Files/nodejs:$PATH" npx next lint` — clean, only pre-existing `<img>`
  perf-suggestion warnings in `components/**` files I never touched.
- Did NOT run `next build` (per constraint) and did NOT run `node scripts/db-migrate.mjs` against the
  live DB (migration 0016 is written but not applied — ship-time task, consistent with "I handle the
  ship").

### Files touched (mine)

New: `lib/fetchTimeout.ts`, `lib/patchMoversCache.ts`, `lib/prostage/timelineBackoff.ts`,
`migrations/0016_prostage_timeline_backoff.sql`, `lib/__tests__/prostage-timeline-route.test.ts`.
Edited: `app/api/prostage/timeline/route.ts`, `app/api/patch-movers/route.ts`, `lib/coachless.ts`,
`lib/staticData.ts`, `lib/pro/riot.ts`, `lib/pro/lolpros.ts`, `lib/prostage/timeline.ts`,
`lib/prostage/resolveGame.ts`, `lib/prostage/lolesports.ts`, `lib/prostage/ddragon.ts`,
`lib/prostage/cargo.ts`, `lib/prostage/liveIngest.ts`, `scripts/backfill-prostage-timelines.mjs`,
`public/companion.ps1`, `lib/__tests__/patch-movers-route.test.ts`.
