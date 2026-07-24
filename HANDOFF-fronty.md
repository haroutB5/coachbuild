<!-- merged into HANDOFF.md 2026-07-24 13:00:24Z; previous content preserved there. Append new rounds below. -->

# HANDOFF-fronty.md — v0.51.1 (two user-reported bugs from v0.51.0)

Scope: `components/hextech/ProConsensusCard.tsx`, `components/ServiceWorkerRegister.tsx`,
new `components/swUpdateDismiss.ts`. Did NOT touch `companionClient.ts`/`CompanionProvider`/apply
path. Did NOT bump `package.json` version (orchestrator ships).

## Bug 1 — Pro Consensus card icon-size inconsistency

**Root cause:** `BootsStackTile` and `StartersStackTile` (the "group these under one slot"
partition tiles from v0.28.0/2026-07-22) rendered their icons at `w-5 h-5`/`size={20}` in a
horizontal icon-left/text-right row, while the main `ItemTile` (completed items) used
`w-11 h-11`/`size={44}` in a vertical icon-above-text layout. Same card, two icon sizes.

**Fix:** `BootsStackTile` and `StartersStackTile` now render each entry with the EXACT same icon
box/size as `ItemTile` (`w-11 h-11`, `size={44}`), vertical icon-above-text layout, stacked in a
`flex-col` wrapper so they still occupy one flex-wrap slot overall — the "starters/boots never
merge into the main completed-items row" partition (hard user directive, see brain memory
`feedback_dark_seal_never_full_item`) is unchanged, only the per-entry size/layout direction
changed. Removed the old `line-clamp`/`flex-1` horizontal-row workaround comments since the new
vertical layout doesn't need them (matches `ItemTile`'s existing, already-correct name-wrap
recipe).

**Verified:** production build + puppeteer (chrome-devtools MCP), Viktor/Mid/High-Elo. Measured
`getBoundingClientRect()` on the icon `<span>` for Dark Seal (starter), Doran's Ring (starter),
Crimson Lucidity (boots), Spellslinger's Shoes (boots), Blackfire Torch, Hextech Rocketbelt — all
six report `44x44`. Screenshots confirm Crimson Lucidity sits in the same visual row as
Blackfire Torch/Hextech Rocketbelt/Zhonya's/Rabadon's at identical size; Dark Seal/Doran's Ring
in STARTING match the same size.

## Bug 2 — SW "Update ready" toast re-appearing despite being on the latest version

**Root cause:** the update-detection logic itself (`controller`-gated `updatefound`/`installed`
check) was already correct — verified via a live repro cycle (prod build, `next start`, real
version bump, genuine-update toast fires once, Refresh applies + reloads cleanly, subsequent
same-version reload shows no toast). The actual bug was in **dismiss persistence**:
`ServiceWorkerRegister.tsx` stored a single sticky `sessionStorage` boolean
(`coachbuild:swUpdateDismissed`, from v0.48.5). Two real defects followed:
1. `sessionStorage` is scoped **per tab**, not per-origin — opening the site in a new tab (or,
   worse, relaunching an installed PWA from the iOS home screen, which does not reliably persist
   `sessionStorage` across relaunches — a documented WebKit quirk) reset "dismissed" to false even
   though the SAME still-pending, never-applied update had already been dismissed. Nothing about
   the app looked stale (it's network-first), so the toast reappearing read exactly like the
   report: "I'm already on the latest version, why does this keep nagging me."
2. Had it been naively switched to a single sticky `localStorage` boolean instead, that would trade
   this bug for the opposite one: dismissing today's update would silently suppress every future,
   genuinely different update forever.

**Fix:** new pure helper `components/swUpdateDismiss.ts` (`isUpdateDismissed`) + `ServiceWorkerRegister.tsx`
now persists dismissal in `localStorage` (`coachbuild:swUpdateDismissedVersion`) **keyed to the
specific waiting worker's `scriptURL`** (which embeds the app version via the `?v=` registration
param), not a bare boolean. Dismissing hides only that exact version's toast; a genuinely different
scriptURL always surfaces fresh, and the dismissal now survives new tabs / PWA relaunches since
`localStorage` is shared across both.

**Verified:** production build + puppeteer, full lifecycle:
- Fresh profile, first-ever install: instrumented `register()`/`updatefound`/`statechange` with a
  timestamped log — confirmed `controller` is `null` at the "installed" state check, so no toast
  fires (matches intended first-install behavior).
- Same-version reload (no deploy): `register()` resolves with `waiting=null`, no `updatefound` — no
  toast.
- Simulated a real deploy (temporarily bumped `package.json` version for local testing only,
  reverted before finishing — confirmed via `git diff package.json` = clean): reload → toast fires
  once (`controller` non-null at "installed"), tapped Refresh → `skipWaiting` → `controllerchange`
  → reload → now on the new version, confirmed via DOM text + `registration.active.scriptURL`.
  Further same-version reload → no toast (regression-safe).
- **The actual bug's regression test:** simulated a second deploy, reloaded (toast fires), this
  time **dismissed without applying** (the exact "ignored the nag, kept using the app" path),
  confirmed `localStorage.coachbuild:swUpdateDismissedVersion` was set to the waiting worker's
  scriptURL, then opened a **brand-new tab** in the same profile to the same URL — **no toast**,
  confirming the fix (previously, a new tab would have shown it again since `sessionStorage` is
  per-tab).
- Pure-logic coverage: `components/__tests__/swUpdateDismiss.test.ts` — no-waiting-worker case,
  never-dismissed case, exact-match dismissed case, and the core fix case (dismissing v0.51.1 does
  NOT suppress a later v0.51.2).

Killed all `next start`/orphaned node processes on port 3000 after testing; confirmed port free.

## Gates

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 1519 passed (1519), 0 failed (baseline 1515 + 4 new).
- `npx eslint components/ServiceWorkerRegister.tsx components/swUpdateDismiss.ts components/hextech/ProConsensusCard.tsx components/__tests__/swUpdateDismiss.test.ts` — clean.
- `package.json` version untouched (confirmed `git diff package.json` is empty at handoff time).

## Files touched

**New:**
- `components/swUpdateDismiss.ts` — pure `isUpdateDismissed` helper + storage key constant.
- `components/__tests__/swUpdateDismiss.test.ts` — 4 unit tests.

**Modified:**
- `components/hextech/ProConsensusCard.tsx` — `BootsStackTile`/`StartersStackTile` icon size fix.
- `components/ServiceWorkerRegister.tsx` — dismiss persistence moved to localStorage, keyed per
  waiting-worker scriptURL.

## Known/unchanged

- The core update-detection mechanism (`?v=` query-param registration, `controller`-gated
  `updatefound`→`installed` check, `skipWaiting`/`controllerchange`/reload flow) was NOT changed —
  it was already correct per the live repro. Only the dismiss-persistence layer was buggy.
- Did not add a "dismissed versions" cap/cleanup — `localStorage` stores exactly one key (the most
  recently dismissed scriptURL), overwritten on each new dismiss, so there's no unbounded growth.
