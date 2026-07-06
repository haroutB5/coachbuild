# Changelog

All notable changes to CoachBuild are documented here.

## [0.4.0] — 2026-07-06
Review-driven release (2026-07-06 audit: 15.5/20; all findings fixed).
### Fixed
- **Data patch no longer frozen.** `getLatestPatch()` was a hardcoded 16.11 literal; it now probes ddragon's newest versions against coachless and picks the newest one with populated data (16.12 today), cached 6h with last-known-good and a 16.11 static floor as fallbacks. The app self-advances every patch from now on.
- **Recovered `app/api/build/route.ts` into version control.** The `.gitignore` rule `build/` had silently swallowed the route directory — the file serving the entire app was never committed and was missing from this checkout (recovered from the Vercel deployment; rule scoped to `/build/`). Restores the 7 route tests that could not run.
### Added
- **Low-sample caution surfaced.** Item alternatives and rune tiles now show sample counts and a quiet ⚠ on low-sample picks (the `lowSample` flag was computed but never rendered — a 1K-sample alt no longer masquerades as 10x better than a 117K-sample pick).
- **"Most played" label** on headline keystones with negative WPA, explaining the red number on the top pick (most-adopted-keystone ranking is intentional).
### Removed
- Dead `<StatBadge>` component (helpers extracted; glyph now rendered inline).

## [0.3.2] — 2026-06-14
### Added
- Full keyboard navigation + ARIA combobox semantics in the champion picker (Up/Down/Home/End to move, Enter to select, opens at the current pick, `aria-activedescendant`).
- Route-level tests for /api/build status mapping (404 for not-played/empty, 400 for bad params, 500 with no detail leak) — closes the integration-test gap that let the earlier bugs ship. 19 tests total.
### Removed
- Dead `getSecondaryTreePlaycount` export (the engine computes its own secondary ranking).

## [0.3.1] — 2026-06-14
### Fixed (full bug sweep — 3 cold-start audits + 108-combo convergence sweep)
- **Off-role / unknown-champ queries now return 404, not 500** (recommend.ts threw plain `Error` at 3 sites; now `NotPlayedInRoleError`). 0 crashes across 108 champ/role combos.
- **EmptyState now actually shows** for not-played combos instead of a misleading Viktor sample under a wrong heading. The header always reflects the selected champion + role (page.tsx).
- **No more duplicate "Flash, Flash" spells** — distinct-spell selection (`pickSpells`), fills Ignite when only Flash is adopted. Regression tests added.
- **Keystone picks the best-WPA option among adopted** within a tree (Thresh now Guardian over Aftershock), while trees still rank by adoption (no off-meta primary).
- Role label / pill no longer desync on "Auto" (role 5); strict API param validation (rejects `2x`/`86.5`); 500s no longer leak internal error text.
- **Service worker is now network-first for the app shell** (a redeploy serves fresh HTML even without a version bump) and only caches `res.ok` responses.
- Picker closes on Escape; collision-safe React keys; footer text meets AA contrast.

## [0.3.0] — 2026-06-14
### Added
- **Per-slot item alternatives** — each item slot now shows situational swaps (an "or" row), e.g. Plated Steelcaps vs AD, Mercury's vs MR. There is one dominant core path per champ (verified against the data), with viable per-slot options rather than 3 separate item builds.
- **PWA**: installable with a web manifest, icons, theme colour, and a service worker whose cache is tied to the app version.
### Fixed
- Version number now actually renders in the footer (was reading the wrong env var). Single source = package.json, inlined as `NEXT_PUBLIC_APP_VERSION`.
- SW cache name is `coachbuild-v<version>`; bumping the version rotates the cache and evicts stale ones, so installed PWAs never serve an old UI.

## [0.2.0] — 2026-06-14
### Changed
- **Every primary tree is now evaluated**, not just the most-played keystone. Variants can differ in primary tree + keystone + primary runes (e.g. Graves: Dark Harvest vs Fleet Footwork; Yasuo: Lethal Tempo vs Grasp). Variants prefer different primary trees, falling back to secondary variation when one primary dominates (e.g. Viktor stays Sorcery, varies secondary).
- Variant subtitles now show the full rune identity ("Sorcery + Precision").

## [0.1.0] — 2026-06-14
### Added
- Champion + lane rune/item recommender powered by coachless.gg's WPA API (Next.js 14 + TS + Tailwind, serverless proxy).
- **Top-3 setups** per champion + lane (one per best secondary tree), ranked by confidence-weighted WPA.
- **All-trees** rune evaluation: compares every secondary tree, not just the default pairing.
- Confidence-weighted ranking: headline pick = most-played positive (reliable); alternatives = best-WPA above a noise floor; viability filter drops weak trees.
- Role coverage Top/Jungle/Mid/Bot/Support, with support-item slot handling.
- Modern coachless-style UI: rune pages, shards, item path, summoner spells, WPA + win rate + sample per pick.
