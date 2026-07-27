<!-- merged into HANDOFF.md 2026-07-27 16:25:59Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 -- /mystats "games played vs games shown" bug -- FIXED (engo)

User report: Matchup History row header and its own expanded detail
disagreed (Galio MID header "3g · 3W-0L · 100.0%" vs expanded list summing to
5g/3W-2L/60%). Root cause (pre-diagnosed, confirmed while implementing):
`/api/mystats/matchups` only ever filtered by `championId`, never by `role`,
even though the row list groups by (championId, role). Plus a second,
same-root-cause bug: `expandedId` in `app/mystats/page.tsx` was a bare
championId, so a champion played in 2+ lanes (e.g. Viktor Mid/Top/Bot in the
report's own account) shared one React key and one `aria-controls`/`id`
pair -- clicking one row expanded every row for that champion.

**Files changed:**
- `app/api/mystats/matchups/route.ts` -- added optional `role` param, same
  `parseIntParam` convention as the sibling summary route (absent ->
  undefined/no filter, invalid -> 400, valid incl. `-1` -> filtered). Two SQL
  branches (`WHERE champion_id = X AND role = Y` vs `WHERE champion_id = X`)
  rather than summary route's COALESCE trick -- more directly testable
  against a mocked `sql` tag, still validates identically. Response now
  echoes `role: number | null` (null = champion-wide, matching "no role
  param" vs "role=-1" being genuinely different requests per the brief).
  Backward compatible: omitting `role` still returns champion-wide matchups.
- `components/hextech/myStats.ts` -- `MyStatsMatchups.role: number | null`
  added to the wire contract; `normalizeMyStatsMatchups` parses it (defaults
  to `null` on absent/non-numeric, never coerced). `fetchMyStatsMatchups`
  signature changed: `(championId, role?, deps?)` -- role omitted still hits
  the old URL shape exactly, role given (incl. `-1`) appends `&role=<n>`.
- `app/mystats/page.tsx` -- `expandedId: number | null` replaced with
  `expanded: {championId, role} | null`; `toggleRow` now takes both; the
  detail fetch effect passes `expanded.role` into `fetchMyStatsMatchups`;
  React `key`/`detailId`/`aria-controls` all keyed on
  `${championId}-${role}`, and the per-row expanded boolean was renamed to
  `isRowExpanded` to avoid shadowing the (now-object) `expanded` state var
  (every reference to the old bare-boolean `expanded` inside the row JSX --
  chevron rotate, `hidden`, the 4 status branches -- updated to
  `isRowExpanded`).
- `lib/__tests__/mystats-routes.test.ts` -- added a 400-on-invalid-role test
  and the acceptance-criterion invariant test: a Galio-Mid-vs-Top fixture (3
  Mid games w/ 3 distinct opponents, 2 Top games w/ 2 different opponents)
  asserts the Mid-scoped response sums to exactly 3 games (not 5), the
  Top-scoped response is disjoint (sums to 2, different opponent ids), and
  the no-role request still returns the champion-wide total (5) for backward
  compat. Mock `sql` reimplements the route's WHERE-clause semantics by
  reading the tagged-template's interpolated values -- necessary because the
  DB layer is mocked, so "does SQL actually filter by role" can only be
  proven by making the mock enforce the same contract the real query text
  encodes; kept intentionally simple (2 positional values) so it stays
  coupled to the route's actual param order, not a guess.
- `components/__tests__/myStats.test.ts` -- updated
  `fetchMyStatsMatchups`/`normalizeMyStatsMatchups` tests for the new
  signature/field (role omitted, role given incl. `-1`, role
  absent/invalid-in-payload -> null).

**Gates (from repo root):** `npx tsc --noEmit` clean. `npx vitest run` --
124 files, **1919 passed, 0 failed** (was 1915+ required; added 5 net new
tests: 1 route-level 400, 1 invariant test, 1 normalizer role test, 1
fetchMyStatsMatchups role-URL test -- one earlier assertion inside the
invariant test needed a fix, see below). `npm run lint` clean (only
pre-existing `<img>` warnings in files I didn't touch: ChampionPicker,
ChampionHero, IconWithFallback, ItemPath, SpellRow).

**One thing worth flagging, not a bug in the shipped code:** while writing
the invariant test I initially used `mockGetMyAccount.mockResolvedValueOnce`
for a test that drives the route 3 times (Mid/Top/wide) -- the 2nd and 3rd
calls silently got `accountUnresolved: true` (empty matchups) because
`-Once` only queues one resolution. Caught by the test itself failing
(`expected 2, got 0`), fixed with `mockResolvedValue`. Flagging in case this
pattern recurs elsewhere in the suite -- a test that calls a route handler
more than once needs to check whether its account-resolution mock is
`-Once` or persistent.

**Not verified (no browser/puppeteer run this round):** did not visually
confirm on `/mystats` in a live browser -- backend contract + component unit
tests are green and cover the exact reported discrepancy numerically, but
I did not drive the actual page. If a screenshot/puppeteer pass is wanted,
that's outstanding.

**Did NOT touch:** `app/page.tsx`, `app/history/page.tsx`, Builds/ProPlayers
empty-state components, `overlay-host/`, `components/hextech/skillOrder*.ts*`,
`components/hextech/mystats/ChampionPoolCard.tsx`, or
`app/api/mystats/summary/route.ts` (read it for the `parseIntParam`
convention, but the file itself is unchanged). No version bump, no commit,
no deploy, dev server not run -- per the brief.

-- engo

