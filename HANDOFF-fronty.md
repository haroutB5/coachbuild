<!-- merged into HANDOFF.md 2026-07-27 00:08:03Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 — Recommended skill order card (Builds page, UI half)

Built the frontend half of the "recommended skill order" feature, paired with
engy owning `lib/`+`app/api/skill-order`. Did NOT touch `lib/` or `app/api/`.

**Files:**
- `components/hextech/skillOrder.ts` — pure model/type + display helpers, no
  JSX (vitest 4 constraint, same as proConsensus.ts). Defines `Ability`/
  `SkillOrderModel` LOCALLY (mirroring the contract byte-for-byte) rather than
  importing from `lib/` — engy owns `lib/`, so this is the frontend's own copy
  of the same shape for parallel dev. **If `lib/` also ends up exporting an
  identical type, reconcile the two so they don't drift** — I did not create
  or touch anything under `lib/` to check.
- `components/hextech/SkillOrderCard.tsx` — the card itself.
- `components/hextech/BuildTabContent.tsx` — wired in as a new full-width
  `[grid-area:skillorder]` row between ITEM BUILD and PRO CONSENSUS (mobile
  stack and `lg:` grid-template-areas both updated). Grouped under the
  mobile "Build" tab (with Runes/Item Build), not "Pro" — it's a build
  recommendation like ItemBuildCard, not a community/pro-play data view like
  ProConsensusCard. **Deliberately NOT added to RunesSummonersCard's own
  column** — v0.63.2 just finished balancing that column's height against
  ITEM BUILD; a second card there would reopen that problem. Full-width own
  row was the simpler, safer choice — reconsider only if the finished feature
  turns out to want a two-column desktop composition instead.
- `components/__tests__/skillOrder.test.ts` — 16 tests, pure helpers +
  `fetchSkillOrder` against a stubbed `global.fetch`.

**Presentation (per the U.GG-derived convention in the brief):**
1. Priority string first: `formatPriorityString` → "Q › W › E" (U+203A, not
   a plain ">").
2. Skill path second: one row per Q/W/E/R (`ABILITY_ROWS`), levels rendered
   as small chips, NOT an 18-column grid — kept explicitly separate from
   `skillOrderGrid.ts`/`GameDetailSheet`'s 18-column pro-game TIMELINE, which
   is untouched. R row gets the same solid-fill "hero ability" treatment
   GameDetailSheet's own `SkillGridRow` already uses (reused verbatim, not
   reinvented) so the two skill-order surfaces read consistently.
   **Left alone deliberately: no per-ability NAME or icon** (e.g. "Orb of
   Deception") — the contract's `SkillOrderModel` carries no name field, and
   there's no existing champion-ability-name resolution anywhere in this
   codebase (grepped — GameDetailSheet's own timeline grid uses bare Q/W/E/R
   letters too). Adding one would mean standing up a new champion-data
   dependency outside this feature's scope; flag if the product actually
   wants named abilities, that's a bigger lift.
   **Left alone deliberately: no passive row** — the contract's `Ability`
   type has no passive member, so there's no data to show; matches the
   "absent, not empty" convention already established for the null-card case.

**Honesty requirements:**
- `completed: false` renders a visible gold caption ("Only levels 1–15 are
  confirmed for this sample — 16–18 aren't recorded"), never padded/guessed
  to 18. Verified live: the incomplete fixture rendered exactly 3 chips on
  the E row (not padded to 5) plus the caption.
- Sample size always shown in the footer (`formatSkillOrderSampleLine`),
  win rate / pick rate appended ONLY when non-null (verified: the incomplete
  fixture, winRate/share both null, rendered "From 4 games" with no
  fabricated percentages).
- Reused `formatSharePct` from `proConsensus.ts` for percent rounding (whole
  percent, no decimal) — one house rounding rule, not two.
- Own `LOW_SAMPLE_THRESHOLD = 3`, same value/rationale as ProConsensusCard's
  (not exported there, so redefined here rather than coupling the two cards).
- API `null` payload → card renders nothing (verified via DOM inspection:
  `[grid-area:skillorder]` collapses to 0 height, no stuck skeleton, no gap).

**Route not live yet at test time** — engy's `/api/skill-order` didn't exist
in this worktree when I verified. Browser-verified against a mocked
`window.fetch` (intercepted client-side via `page.evaluateOnNewDocument`,
not a real route file) for three payload shapes: full data, `completed:
false`, and `null`. Whoever ships this should re-smoke once the real route
lands — my mock necessarily can't catch a real shape mismatch between
engy's payload and `isSkillOrderModel`'s guard in `skillOrder.ts` (loose by
design — checks `priority`/`levels`/`order`/`completed`/`sampleSize` exist
with the right JS types, doesn't validate every level number is 1-18).

**Tests:** 16/16 pass (`components/__tests__/skillOrder.test.ts`).
**verify-fix.sh:** ALL CHECKS PASSED (tsc clean, lint 0 warnings, 1662 tests
passed project-wide, build clean, SW/manifest fine).
**Browser verify:** puppeteer-core + system Chrome, fresh profile dir per
run, 390×844 and 1440×900, Ahri mid (`?championId=103&role=2`). Screenshots
confirmed: compact 4-row path with no horizontal scroll at 390px; correct
full-width placement below Item Build / above Pro Consensus at 1440px;
incomplete-sample caption renders; null payload renders no card and leaves
no gap/skeleton behind.

Did NOT bump version, touch CHANGELOG.md, commit, or deploy — per brief,
Urgot ships.
