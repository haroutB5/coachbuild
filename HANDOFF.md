# CoachBuild — handoff

**Current state: 2026-07-25, v0.51.4.** Prod: `coachbuild.vercel.app`. Companion: 1.6.4.

This file describes where things stand now. Full release-by-release detail lives in `CHANGELOG.md` (every 0.32.0→0.51.3 entry is there in depth) — this file is deliberately NOT an append-only log anymore; per-agent `HANDOFF-<agent>.md` files get merged in here and then reset to a one-line pointer (see the bottom of each of those files). If this file is passing ~150-200 lines again, roll the older-than-today content into `CHANGELOG.md`-referenced footnotes rather than deleting the open-items list.

## What shipped 2026-07-25

- **v0.51.4 / companion 1.6.4** — the companion opened a fresh pair of tabs every game (user screenshot: 4 stacked tabs). `Test-CompanionHasAttachedTab` counted a tab as attached only if it had polled within **8 seconds** — sized against the web poll's 3s cadence, which only holds for a FOREGROUND tab. This feature runs while the tab sits behind a fullscreen game, and Chrome's intensive throttling collapses hidden-tab timers to ~1 tick/minute after 5 minutes hidden, so the check always said "nothing attached" and re-opened both pages every champ select. Fix: attach window **8s → 150s** (`$script:AttachWindowSeconds`), plus a new **25s open→attach grace** (`$script:OpenGraceSeconds`) for a second, independent bug — a freshly opened tab cannot have polled yet, so a champion change inside its cold-start opened *another* pair (that race alone stacked 4 tabs within one champ select). Deliberate behaviour change: a champion swap seconds after the Builds tab opens no longer opens a second tab; the cold-starting tab live-follows to the new champion itself. 4 new mock cases; `-Mock` + `-SelfTest` green.
  - **Measured, not inferred** — probe at `<urgot>/.smoke-tools/cb-throttle-probe2.mjs`: hidden+occluded tab held 20 ticks/min for 5 min, then **1 tick/min from t+360s**, max gap **60.0s**, while a visible control held 20/min. Three earlier probe attempts were invalid and discarded: puppeteer's default args disable background throttling; an attached CDP session suppresses it independently (so you cannot measure from inside puppeteer at all); and a background tab in a *visible* window is a weaker condition than the real in-game state (minimise the window). Full write-up in memory: `browser-throttling-vs-local-bridge-heartbeat`.
  - **User action:** restart the companion on the gaming PC (autostart re-fetches via `irm | iex`) to pick up 1.6.4, then close the stacked tabs once.

## What shipped today (2026-07-24)

Full six-surface UI redesign to the user's WPA-Intelligence mockups, in waves, then three fast-follow fix rounds, then a build-slot-cap correctness fix:

- **v0.50.0** — global navigation redesign: `AppShell` + `DesktopRail` (branded left rail) + `MobileTabBar` (4-destination bottom bar), replacing the old per-page `TabNav`/Sidebar/MobileNavMenu patchwork.
- **v0.51.0** — the mockup redesign itself: global `TopBar` + champion search bus + live champ-select chip + Apply Runes button; Builds page unified (lane/elo tabs move into the hero, PROS-mode search removed); Draft gold retheme with comp bars + takeaway chips; Companion status hero card; My Stats tiles/recent-games/adherence (migration 0014); Patch Movers rewritten to per-champion win-rate shifts; Pro Players gained (then, see 0.51.2, lost again) a recent-games table. Large deletion sweep of now-orphaned components.
- **v0.51.1** — three user-reported fixes from the 0.51.0 ship: My Stats fields were silently dropped by a normalizer that predated the API extension (a cross-agent seam nobody owned); a one-time KDA backfill script for 110 pre-migration rows; Pro Consensus icon sizing; the "Update ready" toast's dismissal moved from per-tab `sessionStorage` to version-keyed `localStorage` (was resurfacing on every new tab).
- **v0.51.2** — removed the Pro Players recent-games table per user directive (added in 0.51.0, reverted here) — `/history` is search-first again. Deleted `ProPlayersTable.tsx`, `app/api/pros/recent/route.ts`, `lib/pros/recentModel.ts` + tests.
- **v0.51.3 (WEB-ONLY)** — fixed an impossible 7-tile build display (Galio MID showed 6 full items + boots). New choke point `lib/buildSlotCap.ts`: 5 full + boots for all lanes, 6 full + boots for Bot/ADC (documented late-game boots-sell exception). LCU item-set export verified independently already correct (unconditional 6-cap, by design — a set is a real loadout, not a progression display).

All rounds gated through `verify-fix.sh` (tsc/lint/tests/build/SW/manifest) green; 0.51.0 additionally had a cold-start adversarial audit (fix-then-ship, both P3s fixed, one P1 migration-before-deploy executed) and a puppeteer smoke pass across `/mystats`, `/movers`, `/history`, a champion deep-link, and mobile 390px. Test count: 1524 (from ~1454 baseline this session).

## Open items, roughly by priority

- **Prostage cron gap, still untriaged.** The daily pro-play ingest cron (`/api/ingest/prostage`, 07:00 UTC) has never reliably landed data in production despite being correctly configured and working when invoked manually. Freshness currently depends on manually running `npx tsx scripts/ingest-prostage.mjs --via-export`. Carried forward unchanged from the last several doc passes — nobody has root-caused it yet.
- **F3 — rank-bracket tier labels are inferred, not confirmed** against coachless.gg's own UI (`lib/rankBrackets.ts` — no tier-name endpoint exists upstream). The tier-SETS (which numeric ids belong to which bracket) are verified against real data; only the human-readable labels are a best guess. A wrong label never yields wrong data — one-line fix if a label turns out wrong.
- **F4 — Patch Movers still uses a curated per-role champion pool**, not a true ladder top-N (coachless has no champion-list/tier-list endpoint — verified absent). Survived the v0.51.0 semantic rewrite (WPA-swing → win-rate-shift); only the metric changed, the candidate-pool limitation is the same as always. The win-rate deltas themselves are real.
- **My Stats build-adherence only resolves for games on the current live recommend patch.** `on_wpa_build` needs the match's own patch to equal the recommend pipeline's currently-resolved patch (no historical-patch override exists in `lib/recommend.ts`) — a match played on an older patch shows no adherence chip at all, honestly, rather than a comparison against the wrong patch's build. This is a known, permanent limitation of the current design, not a bug to fix.
- **Patch-note curation (`lib/patchNotes/`) is a manual per-patch chore.** Someone (agent or user) has to web-verify and add a one-liner for each new patch; Patch Movers shows "—" for any patch without one rather than fabricating. No automation exists for this yet.
- **P2 — `scripts/ingest-player.mjs` has no transient-retry wrapper** — a mid-run network blip fails the whole invocation. Unchanged status.
- **Gap — `RunePage`-shaped components have no vitest coverage** (repo convention: pure-function-only tests, no JSX rendering harness configured) — not yet split into a testable pure-helper shape for every rune-page-adjacent component. Check case-by-case; several rune-page pure helpers (`runesPage.ts`, `perkSlots.ts`) already do have coverage.
- **Cross-project P1, still carried, still untriaged:** matchday should be audited for the same Neon-HTTP-driver + Next-patched-`fetch` caching landmine as coachbuild's own v0.15.1 P0 (`CLAUDE.md` Gotcha a). Nobody has done this audit yet; it belongs to matchday's own handoff really, noted here only because it originated from this app's incident.

**Dropped from the open-items list this pass (verified fixed, not just assumed):**
- ~~Cargo `CargoExport` >500-row tournament truncation~~ — `lib/prostage/cargo.ts` now supports `offset` pagination past the 500-row cap on both the api.php and CargoExport transports. Confirmed in code, not just changelog.
- ~~`mapBracketState`-style trust issues~~ — that's a matchday concept, not a coachbuild one; never import matchday's trust-scoring machinery here without a clear reason.

## Backfills — status

All backfills mentioned in earlier passes (team comps, per-player team builds, prostage `pro_id` disambiguator repair, pro-play item-build timelines, game stats — CHANGELOG 0.17.0-0.19.0) remain complete and unchanged. New this session: the one-time My Stats KDA backfill (`scripts/backfill-mystats-kda.mjs`, 110/110 rows, resumable via `WHERE kills IS NULL`) — already run to completion, script can be deleted or kept as a reference for any future similar gap.

## Verification gaps (known, not yet closed)

- No live on-device confirmation yet that today's redesigned Companion status hero card correctly reflects all 5 real states end-to-end on a genuine League client session (puppeteer smoke covered the web-only render states, not a live LCU round trip).
- The rank-bracket tier-label question (F3 above) fundamentally can't be closed without either an official coachless.gg UI reference or a large-enough real-data cross-check — flagged, not blocking anything.

## Reference: architecture map

Don't re-derive the codebase from scratch — `CLAUDE.md` is the current map (routes, data pipeline, companion bridge contract, hard rules, gotchas). Read it first. `FEATURES.md` is the user-facing feature description, also current as of this same v0.51.3 pass.
