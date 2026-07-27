<!-- merged into HANDOFF.md 2026-07-27 01:38:45Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 — CoachBuild Overlay download section on /live-setup

Added a "CoachBuild Overlay" download section to the Companion page, clearly separated from the existing PowerShell companion install UI.

**New file:** `components/hextech/companion/OverlayDownload.tsx` — static (no `"use client"`) section: eyebrow label, one paragraph distinguishing it from the companion, a gold CTA link (`Download for Windows`, external-link glyph) to `https://github.com/haroutB5/coachbuild-overlay-releases/releases/latest` (intentionally the releases "latest" page, not a hardcoded `.exe` filename — that rots every release), and a 4-item fact list (SmartScreen/unsigned-installer warning, same-PC-as-League requirement, auto-update, Borderless/Windowed display-mode requirement). No version number shown anywhere (none was given, and CLAUDE.md's "no fabricated data" rule applies here same as everywhere else in this repo).

**Wired into:** `app/live-setup/page.tsx` — imported and rendered as `<OverlayDownload />` right after `<AutomationToggles />` and before the collapsible Diagnostics `<details>`. Kept it above the fold, its own bordered `bg-panel`/`border-line` card matching `InstallCommands`/`AutomationToggles` exactly (same eyebrow typography, same button treatment as the existing Copy buttons, same bullet-with-teal-dot pattern used elsewhere on the page).

**Did not touch:** `overlay-host/` (per instruction — that's a different engineer's active area), `CHANGELOG.md`, `package.json` version, any deploy.

**Verification run:**
- `npx tsc --noEmit` — clean, zero errors.
- `npx vitest run` — 120 files / 1806 tests passing (matches the pre-existing baseline exactly, no regressions, no new tests added since this is a static presentational addition with no pure-function logic to unit test).
- `npm run lint` — clean; the only warnings shown are pre-existing `@next/next/no-img-element` warnings in unrelated files (ChampionPicker, ChampionHero, IconWithFallback, ItemPath, SpellRow) — not touched by this change.
- Ran `npx next dev -p 4571` and drove `/live-setup` via chrome-devtools MCP puppeteer:
  - Full-page screenshot at 1280×1000 (desktop) — new section renders correctly between Automation and Diagnostics, matches hextech gold/navy language pixel-for-pixel with the surrounding cards.
  - Full-page screenshot at 390×844 (mobile floor) — copy wraps cleanly, button doesn't overflow, no horizontal scroll. (The fixed `MobileTabBar` visually overlapping mid-page content in the full-page screenshot is a pre-existing artifact of capturing a `position:fixed` element in a stitched full-page capture — not something this change introduced or touched; Companion isn't a mobile-nav destination by design per CLAUDE.md.)
  - `evaluate_script` confirmed the download link's resolved attributes: `href` = the exact releases/latest URL, `target="_blank"`, `rel="noopener noreferrer"`.

**Not verified:** did not test actual click-through to GitHub (repo/release may not be published yet per the task brief — "first release is being published shortly") and did not test with a screen reader / keyboard-only nav beyond confirming it's a real `<a>` (not a div) with visible focus-ring classes matching every other interactive control on this page.
