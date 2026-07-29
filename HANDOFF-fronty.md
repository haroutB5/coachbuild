<!-- Previous round was merged into HANDOFF.md 2026-07-29 13:55:29Z and is preserved there. -->

# Skill order as a grid, always 18

2026-07-29. Against v0.81.0. No version bump, no commit, no deploy — as briefed.

Two user directives, both reversing earlier deliberate decisions:

1. Render the skill order as the classic 18-column grid, everywhere.
2. Always complete it to level 18 — "all websites I see do that."

Plus a mid-task clarification: the reference screenshot's empty 17/18 columns were an accident
of a game that ended at level 16. Take the visual language, not the fill rule.

---

## 1. The shared grid primitive

`components/skillOrderGrid.ts` — extended in place (it was already the per-game transform).
`components/SkillGrid.tsx` — NEW, the renderer.

The old `buildSkillOrderGrid` was replaced by `buildSkillGrid`, which returns cells carrying
PROVENANCE rather than bare level numbers:

* `measured` — the source published this level. Solid colour chip.
* `derived`  — `completeSkillOrder`'s arithmetic, which has exactly one answer. Tinted chip,
  solid hairline.
* `inferred` — the arithmetic refused and the level was filled from the max-priority order.
  Dashed outline, no fill.

`SkillGrid` renders 4 rows × N columns and **takes no view on completeness**. Column count and
cell provenance are both the caller's decision. That is the line the clarification drew, and it
is enforced by shape: there is no "always 18" default anywhere inside the primitive.

Colours are Q blue `#4c8ff0` / W orange `#e2903f` / E purple `#a878e4` / R red `#e8595c`, the
reference convention. **Colour is never the only signal** — the row label carries the literal
Q/W/E/R and every chip carries its level number, so the grid is fully readable with no colour
perception. Tailwind arbitrary values, deliberately NOT added to `tailwind.config.ts`, so four
decorative hues cannot leak into surfaces where the single-gold-accent rule should hold.

Accessibility: the visual grid is `aria-hidden` and the same information is served as a
`sr-only` list, one line per ability, naming which levels are derived and which are inferred.
Labelling cells individually was not an option — a per-row wrapper element would become a single
CSS-grid item and collapse the layout.

### Mobile — the reason a grid was rejected once before

Solved, and it was never a column-WIDTH problem: the cells are not touch targets. Tracks are
`minmax(0, 1fr)`, so they shrink to fit. Measured at 390px: **14.5px cells, grid 316px wide,
its `overflow-x` container does not scroll, and the page does not scroll.** The
`overflow-x-auto` wrapper is a second line of defence, not the mechanism. On desktop a
`max-w-[560px]` on the card side caps cells at 27.1px so the grid reads as a compact chart
rather than 18 giant squares.

### No ability icons

The reference shows an icon per row; this ships letters. There is no ability-icon resolver in
the app today (`lib/staticData.ts` fetches ddragon champion detail only for `maxrank`), so icons
would mean a new asset path, a new per-champion field on the wire, and 4 more images per card on
a 30-second champ-select surface. The letter is required anyway by the colour-blindness rule.
Say the word if you want icons and it becomes a small, separate change.

---

## 2. Which surfaces got the grid

| Surface | Result |
|---|---|
| `components/hextech/SkillOrderCard.tsx` (Builds) | **Grid.** Replaced the per-ability level lists. Priority string (`Q › W › E`) kept above it — it is the thing players memorise, and it is a different fact from the path. |
| `components/GameDetailSheet.tsx` | **Grid, now the shared one.** Its inline `SkillGridRow` was deleted and it calls `SkillGrid`. Same look, different fill rule. |
| `components/hextech/SkillOrderNextPanel.tsx` (`/compact`) | **No grid, deliberately.** It answers "which key do I press right now" — one ability, during a live game. A whole-path grid is a different question and would bury the one-ability answer on a chrome-free glance surface. |
| `app/compact/page.tsx` | **Nothing to change.** It renders only the next-skill panel; it presents no skill order today. |
| `components/hextech/FeaturedOtpCard.tsx` | **No grid, deliberately.** Its skill line is already a priority string, not "simple numbering", and it sits in a narrow right rail at `lg`. An 18-column grid there would be unreadable, and the line is explicitly the CHAMPION's common order rather than that player's own — a full path would over-promise it. |
| `overlay-host/renderer/ingame.js` (Electron overlay) | **Untouched — flagged for you.** It ALREADY renders the classic 18-column grid, so "everywhere" is visually satisfied. But it is a separate vanilla-JS app with hand-synced copies of `TOTAL_LEVELS`/`SOURCE_LEVELS` and its own `observedLevelCount`, and it does NOT know about `inferredTail`, so it will keep stopping at 15 on a refusal. Out of a web-frontend task's blast radius, and it speaks during live games. **Your call whether it follows.** |

---

## 3. Always 18 — how the tail is filled

`lib/skillOrderModel.ts` gained `inferSkillOrderTail(observed, priority, kit)`.

**The guess is quarantined.** `order`, `levels`, `completed`, `observedLevels` and
`completionBasis` are exactly what they were. The inference lives in two NEW optional fields,
`inferredTail: Ability[]` and `inferredBasis: "published" | "derived"`. Consumers must opt in.
That is what makes section 4 true by construction rather than by care.

Mechanism: the same allocator `completeSkillOrder` uses, minus the structural guards that
refuse. Walk the max-priority order, give each ability as many remaining points as its own cap
allows, take any ultimate rank the schedule opens up first.

Two refusals survive, because both would make the guess actively wrong:

* **`kit === null`** — the champion is known non-standard and ddragon did not resolve, so the
  caps the walk needs are exactly what is missing. Inferring under `STANDARD_KIT` there is the
  blank-Jayce bug's wrong arithmetic in a new hat. Tested.
* **bad token** — Kha'Zix's `R-Q`/`R-W`. `lib/opgg.ts` already rejects that payload upstream, so
  this is belt-and-braces.

A **short** tail is returned rather than one that breaks a cap. Those levels stay blank in the
grid and get their own caption.

### How inferred is marked

Three things, not one:

1. **Dashed chip** — the only treatment in the palette using a dashed border, pinned by a test
   so it can never collide with `derived`.
2. **A plain caption**, naming the exact levels and the basis:
   *"The source publishes levels 1–15 only, and this champion's last points can't be worked out
   from them. Levels 16–18 are inferred from the champion's published max order (dashed) — a
   best guess, not recorded data."*
3. **Screen-reader text**: *"Levels 16, 17, 18 inferred from the max-priority order, not
   recorded."* Distinct wording from the derived case, so the two are not conflated for a
   non-sighted user.

A partial tail adds a second caption: *"Levels 17–18 are unknown for this champion and left
blank."*

---

## 4. `lib/nextSkill.ts` — NOT changed, as instructed

Its `model-incomplete` refusal past level 15 is untouched. It reads `model.completed` and
`order.length`, neither of which this work modifies, so the live in-game panel still goes silent
rather than guessing. Pinned by tests asserting `order`/`levels`/`observedLevels` are unchanged
on a model carrying an inferred tail.

**I do not think it should change, and I am not asking you to decide now.** The asymmetry is
real: a reference grid is read at the player's own pace with a visible "best guess" caption
attached; the live panel is a single imperative with no room for a caption, delivered mid-fight.
If you ever do want it, the honest shape would be a visually distinct "probably W" state, not a
silent promotion of `inferredTail` into `order`.

---

## 5. What I verified, and how

`bash C:/Claude/AI/urgot/scripts/verify-fix.sh C:/Claude/AI/coachbuild` — **ALL CHECKS PASSED**
(tsc, lint 0 warnings, **2357 tests**, build, sw, manifest).

Tests added: `lib/__tests__/skillOrderTail.test.ts` (inference + wiring, including the
partial-tail boundary and the `kit === null` refusal) and
`components/__tests__/skillOrderRecommendedGrid.test.ts` (model → grid, provenance
disjointness). `components/__tests__/skillOrderGrid.test.ts` was rewritten for the shared
transform.

Browser-verified against a real dev server (`next dev -p 3113`), headless Chrome, **fresh
`userDataDir` every run** so no service worker could serve a pre-change shell. Both 390×900 and
1920×1200 unless noted.

| Case | Result |
|---|---|
| Ahri mid (103/2) | 18 columns, measured 1–15, **derived 16–18**, none inferred. |
| **Udyr** jungle (77/1) | 18 columns, derived 16–18. **The brief's "known unresolvable" Udyr now COMPLETES** — see section 6. |
| **Kha'Zix** (121/1 and 121/2) | `/api/skill-order` returns `null`; **no card renders at all.** Unchanged by this work. |
| Inferred tail, forced payload | Dashed 16/17/18, correct caption, correct sr-only text. |
| Inferred tail PARTIAL, forced | Dashed 16 only; 17/18 blank; both captions present. |
| `GameDetailSheet`, 38-minute game | 18 columns, 18 chips, **zero derived or inferred treatment**. |
| `GameDetailSheet`, **16-minute game** | 18 columns, **11 chips, 17/18 blank — not padded.** The clarification's requirement, verified on a real game. |
| Builds tabs (v0.81.0 tabpanels) | 3 tabs, 3 tabpanels, `aria-selected` correct, roving tabindex `0/-1/-1` → ArrowRight moves focus to Pro and the tabindex rotates. **Not regressed.** |
| OTP tab | Featured OTP card renders; **zero grids in that panel** (correct — it keeps its priority string). |

**Page horizontal scroll: confirmed `documentElement.scrollWidth === clientWidth` AND
`body.scrollWidth === clientWidth` on EVERY case above, at 390px and 1920px.** Measured off the
live DOM, not reasoned about.

Screenshots read at both viewports: the Builds card (Ahri, Udyr, inferred, partial) and the
sheet grid (full-length game and 16-minute game).

## 6. What I did NOT verify — read this part

* **The inferred tail has NO live champion today.** I probed Udyr, Yuumi, Aphelios, Jayce,
  Karma, Elise and Nidalee against the live feed: **every one completes via op.gg's published
  `skill_masteries.ids`.** The brief's premise that Udyr is the known unresolvable case is
  **outdated** — `skillOrderModel.ts`'s own header already recorded that the surplus path landed
  2026-07-27. So the inferred marking was verified by **serving a synthetic payload through a
  `window.fetch` shim into the real component**, not by finding a champion that hits it live.
  The component path is genuinely exercised; the model path is exercised only by unit tests.
  The inference is therefore a **safety net for when op.gg's publication goes absent or
  malformed**, not something users will see today. Finding a live case would need a full-roster
  sweep (~173 champions × ~3.5s, op.gg rate-limit exposure) — I did not run it.
* **`/compact`'s next-skill panel was not render-verified.** It renders `null` without a live
  companion and there is no League client here. I did not change it; the build and its existing
  tests cover it.
* **No production check.** Nothing was deployed.
* **The overlay app was not run.** Its grid is unchanged code, but I did not launch Electron.

## 7. Also worth knowing

* **`.next` got corrupted mid-session** (`Cannot find module './7787.js'`, then blanket 404s from
  a route that had just worked) after `next build` and `next dev` ran against the same checkout —
  repo gotcha (i), which is worth widening to cover this failure shape. Starting a dev server on
  a fresh port cleared it. `rm -rf .next` was blocked by the safety gate; I did not route around
  it, and it turned out not to be needed.
* Puppeteer **CDP request interception broke Next's dev asset requests outright** (the page
  rendered nothing at all). A `page.evaluateOnNewDocument` fetch shim is the reliable way to
  force an API payload on this app, and it is service-worker-proof by construction. Worth adding
  to the fleet's smoke-tools habits.
* Two exports in `components/hextech/skillOrder.ts` are now unused by the card: `ABILITY_ROWS`
  and `sortedLevels`. Left in place because `components/__tests__/skillOrder.test.ts` covers
  them and deleting exports was not in scope.
* `components/hextech/BuildTabContent.tsx` and `lib/recommend.ts` were NOT touched — another
  agent was live in both. `BuildTabContent` needed no change: the card swap was entirely
  internal to `SkillOrderCard`.
