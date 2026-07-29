<!-- merged into HANDOFF.md 2026-07-29 13:55:29Z; previous content preserved there. Append new rounds below. -->

# Builds page tabs on desktop, + the OP.GG link on the OTP card

2026-07-29. Against v0.80.0. No version bump, no commit, no deploy — as briefed.

---

## 1. What changed

**Build / Pro / OTP are now the navigation at every width.** They were a
`lg:hidden` mobile-only strip, and every panel escaped its own visibility gate
through `lg:block`, so desktop rendered all five sections as one long page. Both
mechanisms are gone.

### `components/hextech/BuildTabContent.tsx`
- `mobileTab` / `MobileBuildTab` / `MOBILE_TAB_OPTIONS` renamed and moved out to
  `buildTabLayout.ts` as `buildTab` / `BuildTab` / `BUILD_TAB_OPTIONS`. The old
  name asserted something that is no longer true.
- The tablist wrapper's `lg:hidden` is removed; `HextechTabs` renders directly.
- **Structure changed from five gated cards to three sibling panels.** Each tab
  now has exactly one `role="tabpanel"`, with the id its own tab's
  `aria-controls` names. See §4 — this is the a11y fix, not a refactor.
- `BUILD_GRID_CLASS` lost its `'pro pro'` and `'otp otp'` rows. It is now
  `'runes itembuild' 'skillorder skillorder'` — the BUILD tab's desktop
  composition is byte-identical to what shipped, per the brief.
- The loading skeleton now draws **the active tab only** and the **tab strip
  renders during loading**. Previously the strip appeared only once the build
  resolved, so everything below it jumped down by 45px on every champion change.
- The stale comment block asserting *"desktop keeps the current single-scroll
  layout"* is rewritten to state the current spec and quote the directive that
  replaced it.

### `components/hextech/HextechTabs.tsx`
- Roving tabindex (`tabIndex={active ? 0 : -1}`) and Left/Right/Home/End
  keyboard navigation, both wrapping. Selection follows focus.
- New optional `className` prop so the caller owns the strip's own spacing.

### `components/hextech/tabKeyboard.ts` (NEW)
Pure resolver for the above — `resolveTabKeydown`, `isTabNavigationKey`. Split
out because this repo has no JSX render harness, so a handler written inline in
the component is testable only through a browser.

### `components/hextech/buildTabLayout.ts` (REWRITTEN)
It exported a five-card left/right column split (`runes, core, starting,
proConsensus, situational`) that had not described the real page since v0.51.0
merged three of those cards into `ItemBuildCard`. It had **no importer outside
its own test**, which is why nobody noticed — a passing test can certify a
layout that nothing renders. It now owns the tab set, the default tab, and the
tab/panel id helpers, and `BuildTabContent` actually imports it.

Deliberately **not** re-added: a `Record<BuildTab, BuildCardId[]>` membership
list. Cards are placed with Tailwind arbitrary classes (`[grid-area:runes]`) and
Tailwind's JIT scans source text, so an interpolated `[grid-area:${id}]`
generates no CSS. A list the render cannot consume is a list with no importer,
which is exactly the rot above. Reasoning is recorded in the file.

### `components/hextech/FeaturedOtpCard.tsx`
Desktop composition (§2) + the OP.GG link (§3) + a rail-aware rune grid.

### `components/hextech/ProConsensusCard.tsx`
A **pre-existing overflow bug**, found and fixed. See §5.

### `components/hextech/opggProfile.ts` (NEW)
Riot platform → OP.GG region slug map + URL builder.

### Tests
- `components/__tests__/buildTabLayout.test.ts` — rewritten (the old assertions
  described the dead layout). 12 tests.
- `components/__tests__/tabKeyboard.test.ts` — NEW, 11 tests.
- `components/__tests__/opggProfile.test.ts` — NEW, 11 tests.

---

## 2. The desktop composition for PRO and OTP, and why

**PRO needed nothing, and that is a measured finding rather than a shortcut.**
`ProConsensusCard` already spanned the full content width before this change —
it was the `'pro pro'` row — and already carries its own two-column split
internally (rune page | Starting+Items), with proportions arrived at by
measuring three candidate splits live. Owning the tab does not make it any wider
than it already was, so an outer grid would have been a container that changes
nothing. Verified by screenshot at 1920 (see §6). It did, however, turn out to
be **overflowing** at the `lg` boundary — §5.

**OTP is where the composition work went.** `FeaturedOtpCard`'s body was a
single stack of full-width sections. At the bottom of a page you had already
scrolled through, that was fine; as the whole screen at 1376px it is slot rows
stretched to twice the width their content needs, name at one end and percentage
at the other.

The body is now `lg:grid-cols-[7fr_5fr] lg:gap-x-8 lg:items-start`:

| column | content |
|---|---|
| left, 7fr | Their build (opener + played-build strip + caption), Boots, Item slots |
| right, 5fr | Runes, Summoners, Skill order |

The hero band and KPI strip stay full-width above both.

**Why this is NOT the BUILD/PRO tabs' runes-left `5fr_7fr` house style.** The
other two tabs are recommendations, where runes and items are two halves of one
answer and either may lead. This card is a **profile of a named person**, and its
headline is the build they actually played — the thing the hero band and KPI
strip above it are introducing. Putting runes on the left would mean one of two
things, both worse. Reordering the DOM buries the lede on mobile (hero → KPIs →
runes → … → their build). Keeping DOM order and placing with
`grid-template-areas` puts the visual order at odds with the reading **and focus**
order — a keyboard user would tab from the right column back to the left. The
BUILD tab's own grid never has to make that trade, because its DOM order and its
visual order agree. So the primary column keeps the primary content, in source
order, at every width. Mobile is unchanged: below `lg` this is a plain block and
every section stacks exactly as it shipped.

One follow-on fix, caught by looking rather than by reasoning: at 1024 the right
rail is 273px, which left the secondary rune tree a 102px track and wrapped the
three stat shards into a vertical 3-high column where every other surface draws
them as a row. The rune grid is now `lg:grid-cols-1 xl:grid-cols-[auto_auto]` —
stacked in the narrow rail, side by side from `xl` where the rail is ~493px.

**Known, accepted:** at 1920 the right rail ends ~400px above the left column.
It reads as a sidebar, and the alternative it replaced (one 1376px column) was
substantially worse. Flagging it rather than hiding it.

---

## 3. The OP.GG link

`components/hextech/opggProfile.ts` → `opggProfileUrl(server, gameName, tagLine)`.

- Canonical form only: `https://op.gg/lol/summoners/<region>/<name>-<tag>`.
  **Independently confirmed 200 with 0 redirects** via curl with a browser UA.
- Name and tag are `encodeURIComponent`d **separately**, so the `-` separator
  stays literal while a space in the game name becomes `%20`.
- Region is mapped from the Riot **platform** id, never lowercased from it
  (`EUW1`→`euw`, `EUN1`→`eune`, `LA1`→`lan`, …). `match_routing` is not consulted
  and the tests assert `europe`/`americas`/`asia` do **not** resolve.
- **Unmapped or missing platform → `null` → plain text, exactly as before.** No
  guessed region, no dead link to a stranger's profile.

Presentation: `target="_blank" rel="noopener noreferrer"`, an external-link
glyph, hover underline, a real `focus-visible` ring, and an accessible name that
says whose profile it is and that it opens a new tab.

Touch target: the anchor is a pure inline element, so `py-2.5` extends the hit
area without changing the h3's line box — hero band height is unchanged.
**Measured 44px at 390px and 49px at desktop.** It needed `relative z-10`:
`elementFromPoint` at the anchor's own bottom edge returned the hero's pill row
(a later sibling that won hit-testing), so the bottom quarter of a 44px target
was dead. Both edges now hit the anchor at all three widths.

---

## 4. Accessibility — what the change broke and what it now is

The brief was right that the old structure's safety premise dies here. Stating
exactly what was wrong, because it is worse than "inert":

Five cards each carried `role="tabpanel"`. **Three of them pointed at the same
`hextech-tab-build`**, and only one of those three owned the
`hextech-tabpanel-build` id that the tab's `aria-controls` names. So there were
three panels for one tab and two `aria-controls` targets that resolved to
nothing. It survived review because at `lg` the tablist was `lg:hidden` — the
whole relationship was inert exactly where it was wrong.

Now: **one tabpanel per tab**, each with the id its own tab points at, each
labelled by that tab, each `tabIndex={0}` per the ARIA Tabs pattern.

Keyboard, which the old touch-only strip never implemented:
- Roving tabindex — the tablist is **one** stop in the page tab order, not three.
- Left/Right move and wrap; Home/End jump to the ends.
- Selection follows focus (permitted, because revealing a panel is instant here).
- `preventDefault` fires only for keys the resolver owns, so vertical arrows,
  Tab, Enter and Space still behave normally.

Verified in-browser at 390 / 1024 / 1920: `[-1, -1, 0]` roving indexes, every
arrow/Home/End press moved focus and selection together and left exactly one
panel visible, zero dangling `aria-controls`, zero dangling `aria-labelledby`,
zero duplicate DOM ids.

Tab switching is `display:none` only — no transition, no unmount. Peak usage is a
30-second champ select, so the swap is a repaint. That also means the inactive
panels stay mounted and switching re-fires no fetch. Nothing animates, so
`prefers-reduced-motion` has nothing to reduce here.

---

## 5. Pre-existing bug found and fixed — PRO card overflow

**`ProConsensusCard`'s two-column body was overflowing its own card by 44px at
the `lg` boundary, and had been since v0.63.2 shipped it.** The page wrapper's
`overflow-x-clip` (`app/page.tsx`) is why it was never seen, and why a
document-level `scrollWidth` check reports zero. Percentages and fractions on the
right of the Starting/Items rows were cut off mid-glyph.

Measured on Ahri mid at 1024×900: card 728px → content box 688px, but the tracks
resolved to **385.0px + 307.5px + 40px gap = 732.5px**. The `5fr` track is the
cause — an `fr` track's automatic minimum is its **min-content**, and the rune
group's min-content is 385px, well above the 287px its 5/12 share allows. So the
left track refuses to shrink and the right one is squeezed until its rows spill.

`min-w-0` on the children is the usual answer and is wrong here: it lets the
track drop below min-content, which moves the clipping *inside* the rune group.
The fix is to not attempt two columns at a width that cannot hold them — the
split moved `lg` → `xl` (card 986px there, tracks 401/561, clearing the 385px
floor), with the gap tightened 40px → 24px to keep margin at the 1280 boundary.
Below `xl` the card stacks, which is what it did at every width before v0.63.2.
Three sibling classes pinned to the same breakpoint moved with it
(`lg:grid-cols-[auto_auto_auto]`, `mt-5 lg:mt-0`, `mb-4 lg:mb-0`).

This is on my surface only. No data, model or aggregation code was touched.

---

## 6. How this was verified

`bash scripts/verify-fix.sh C:/Claude/AI/coachbuild` — **ALL CHECKS PASSED**
(tsc, lint 0 warnings, **2285 tests**, build, SW, manifest).

Browser, against a **running dev server** on `localhost:3000`, headless Chrome
via puppeteer-core with a **fresh `userDataDir` per run** (so no service worker
served a pre-change shell):

- **Screenshots read, full-page, all three tabs at 390 / 1024 / 1920** — nine
  states. Champion: Ahri mid (real data: 232 stored OTP games, 200 pro games).
- **Spill sweep** — walked every element inside each panel and compared right
  edges against the panel's content box, because `overflow-x-clip` hides this
  class of bug from `scrollWidth`. Run at **390, 768, 1024, 1280, 1440, 1920 ×
  Ahri and Ornn × all three tabs (36 states)**. Zero spill everywhere after the
  §5 fix. This is what caught §5.
- **A11y/keyboard** at all three widths — figures in §4.
- **CLS**: `0.0194` over a champion load, **`0` across four tab switches**
  (`pro → otp → build → otp`).
- **The OP.GG link was clicked for real.** It opened a new tab at
  `https://op.gg/lol/summoners/euw/TWTV%20Peng04-Yuqi`. That page returned
  CloudFront 403 **to headless Chrome** — bot detection, not a bad URL. The same
  URL returns **200 with 0 redirects** to curl with a browser UA, checked
  separately.
- Zero console errors and zero page errors in every run.

### What I did NOT verify
- **No pre-change CLS baseline.** I claim the tab strip rendering during loading
  removes a 45px jump; the mechanism is certain but I did not measure the before
  number. Measuring it needs a stash, and two other agents are live in this repo,
  so I left git state alone.
- **Production.** Nothing was deployed; everything above is the dev server.
- **Only two champion shapes** (Ahri, Ornn) in the spill sweep. Not a champion
  with an unusually long rune name or a thin OTP sample.
- **The OP.GG link on any region other than EUW1.** The mapping is unit-tested
  against all 17 platforms, but only the `EUW1` row has been clicked, because
  that is the featured player the live data gave me.
- **Real touch input.** Hit areas were checked with `elementFromPoint`, not a
  finger on a device.

---

## 7. FOR YOU TO DECIDE — the "WPA" label

The user typed **"redesign and add the tabs for WPA, Pro, OTP"**, and also
**"just like in mobile"**, where that first tab is labelled **"Build"**. Those
two instructions conflict, so per the brief I changed nothing: the labels are
still `Build | Pro | OTP`, identical to mobile.

My read, offered but not acted on: **"WPA" is the better label.** The card inside
that tab is headed "WPA BUILD", the app's own subtitle is "WPA INTELLIGENCE", and
"Build" is the weakest of the three names because all three tabs are builds — it
says the category, not which one. "WPA | Pro | OTP" names the *source* of each,
which is the actual distinction. Against it: it also changes mobile, and it is a
three-letter acronym in the primary nav.

If you want it, it is a **one-line change** in `components/hextech/buildTabLayout.ts`
(`BUILD_TAB_OPTIONS[0].label`) plus the label assertion in
`components/__tests__/buildTabLayout.test.ts`. The `value` stays `"build"` — it
is in DOM ids and does not need to move.

---

## 8. Housekeeping

Scratch files I created in the repo root and could **not** delete — the
safety-gate hook blocks file deletion, and its own `approved.txt` path points at
the dead `S:/AI/urgot/` root, so I could not take the approval route either. Not
routed around; surfacing instead. All untracked:

```
_tabs-verify.mjs   _shots.mjs   _probe.mjs   _link-verify.mjs   _tabs.json   _tabs.err
```

(`_smoke-*.mjs`, `_probe-branches.mjs` and `scripts/_tmp-*` are the other agents',
not mine.)

Dev server started for verification was stopped cleanly (PID confirmed gone off
port 3000), so nothing is holding `.next/trace`.

### Proposed CLAUDE.md update
The Builds paragraph still says *"the mobile tab strip is now BUILD | PRO | OTP"*
and describes `ProConsensusCard` rendering both variants. Both are stale: the
strip is not mobile-only any more, and OTP has been `FeaturedOtpCard` since
2026-07-29. Suggested replacement sentence:

> The Builds page is a three-tab interface at **every** width — **BUILD | PRO |
> OTP** (`components/hextech/buildTabLayout.ts` owns the tab set;
> `HextechTabs.tsx` implements the ARIA Tabs keyboard contract). BUILD is the WPA
> recommendation (runes + item build + skill order), PRO is `ProConsensusCard`,
> OTP is `FeaturedOtpCard` (one featured one-trick, with an outbound OP.GG
> profile link built by `components/hextech/opggProfile.ts`).

### Worth knowing next time
`app/page.tsx`'s `overflow-x-clip` means **a card can overflow its own container
and no `scrollWidth` check anywhere will report it.** On this page, compare
element right edges against the container's content box, or the only symptom is
cut-off glyphs in a screenshot nobody took.
