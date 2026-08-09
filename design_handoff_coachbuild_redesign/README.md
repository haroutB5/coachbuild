# Handoff: CoachBuild redesign (Nocturne)

## Overview

A full visual + UX redesign of the CoachBuild desktop companion (`haroutB5/coachbuild`), covering all surfaces: Draft Assistant, Builds (with the BUILD / PRO / OTP tabs), Patch Movers, Pro Players, My Stats, Post-Game review, Companion setup, and the in-game skill overlay.

The redesign keeps every existing feature and data contract. It changes the shell, the information hierarchy, and the visual system. Two things are genuinely new:

1. **The phase spine.** A live rail in the top bar — `LOBBY → CHAMP SELECT → IN GAME → POST GAME` — present on every screen, reflecting real companion state. The app's state is the game's state.
2. **Verdict-first layout.** Every screen opens with one prescriptive answer at display size (*Lock in Galio*, *Level W next*, *Buy Rylai's back*), with the tables underneath for the user who wants to argue with it. This is the Blitz/u.gg posture the user asked for.

The app's honesty posture is preserved and made visible rather than removed: sample sizes, `off-meta` tags, `(low data)` / `(suggested)` labels, and the "levels 16–18 withheld" refusal all have designed treatments.

## About the design files

`CoachBuild Redesign.dc.html` in this folder is a **design reference created in HTML** — a prototype showing intended look and behavior. It is **not production code to copy**. It is a single-file component with an inline-styled template and a small state class; it has no build step and no relationship to the repo's React/Next.js structure.

The task is to **recreate these designs in the existing codebase**: Next.js App Router + React + Tailwind, using the repo's established components (`components/hextech/*`, `components/live/*`) and its existing data pipelines. Do not port the HTML. Read it for layout, spacing, color, copy and behavior, then build the equivalent in Tailwind classes and existing components.

Open it in a browser to click through. The left rail switches screens; on Builds, the three tabs switch build views.

`screenshots/` holds every screen captured at the 1440×900 design size, 1:1 — use them as the visual acceptance target.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii and copy are final. Recreate pixel-accurately using Tailwind + the repo's component patterns.

The one deliberate placeholder: **champion, item and rune art are monogram tiles** (a 2-letter monogram on a dark gradient with a 3px diagonal hatch). In the real app these become `<IconWithFallback>` with the coachless CDN URLs the API already returns. The tile geometry (size, radius, 1px inset ring) is the spec — swap the monogram for the `<img>` and keep everything else.

---

## Design tokens

The redesign is built on the **Nocturne** design system. `nocturne-styles.css` in this folder is the token sheet — port the `:root` block into `app/globals.css` and extend `tailwind.config.ts` from it, replacing the current Hextech-gold palette.

### Color

| Token | Value | Role |
| --- | --- | --- |
| `--color-bg` | `#161826` | App ground |
| `--color-surface` | `#232532` | Raised surface |
| `--color-text` | `#e9e9ed` | Body text |
| `--color-accent` | `#9184d9` | The single accent (blurple) |
| `--color-divider` | `rgba(233,233,237,.16)` | Hairline |

Accent ramp: `100 #f5f4ff` · `200 #e7e5fe` · `300 #d2cefd` · `400 #b5abfc` · `500 #968ae0` · `600 #796cbf` · `700 #5d5294` · `800 #423a6a` · `900 #2b2741`

Neutral ramp: `100 #f3f5fe` · `200 #e4e7f5` · `300 #cfd3e5` · `400 #b2b6ca` · `500 #9397ab` · `600 #75798c` · `700 #595d6c` · `800 #3f424d` · `900 #292b31`

**Non-token colors used in the design (only these three):**

| Value | Use |
| --- | --- |
| `#46c79b` | Positive signal — win rate above baseline, positive pp delta, wins, "on build" |
| `#e8736e` | Negative signal — losses, negative delta, enemy-side chrome, threat |
| `#1b1d2a` | Card ground. One step below `--color-surface`; cards sit *into* the page rather than on top of it |

`#46c79b` / `#e8736e` are the only additions to Nocturne's mono palette. A stats app needs a signal hue; both are pitched at the ramps' lightness so they don't shout. **They are for data only — never decorative.** This mirrors the repo's existing `--good` / `--bad` rule.

Two more page-chrome values: `#12141f` (title bar, left rail, code blocks) and `#1c1e2c` (inputs, segmented-control tracks).

### Typography

Inter throughout (`--font-heading` and `--font-body` are both Inter). Weights used: 400, 500, 600. **Never above 600** — hierarchy is size and space.

| Role | Spec |
| --- | --- |
| Screen title (h1) | 34px / 1 / 600 / `-0.025em` |
| Card headline | 26px / 1 / 600 / `-0.02em` |
| Section label | 10px / 1 / 600 / `+0.14em` / uppercase / `rgba(233,233,237,.5)` |
| Rail group label | 9px / 1 / 500 / `+0.16em` / uppercase / `rgba(233,233,237,.32)` |
| Kicker (accent) | 10px / 1 / 500 / `+0.16em` / uppercase / `var(--color-accent)` |
| Body | 12–13.5px / 1.5 / 400 |
| Table cell | 12–13px / 1 / 400–600 |
| Big stat | 32px / 1 / 600 / `-0.03em` |

**Every number gets `font-variant-numeric: tabular-nums`.** Win rates, deltas, games, KDA, timers, gold — all of them. This is non-negotiable for a stats app; columns must not jitter.

### Geometry

- Radii: `5px` chips/badges · `6–7px` small tiles and nav items · `8–9px` cards, buttons, inputs · `10px` hero cards and the window · `50%` runes
- Card border is **not** a border: `box-shadow: inset 0 0 0 1px rgba(233,233,237,.08)`. Accent cards use `inset 0 0 0 1px rgba(145,132,217,.22)`. Hero cards use an outer `0 0 0 1px rgba(145,132,217,.3)` plus `0 14px 40px rgba(0,0,0,.4)`.
- Row separators inside cards: `border-top: 1px solid rgba(233,233,237,.05)`
- **Freestanding rules fade at both ends** (a Nocturne signature): `linear-gradient(to right, transparent, rgba(233,233,237,.14) 48px, rgba(233,233,237,.14) calc(100% - 48px), transparent)`. Box outlines and in-control separators stay solid.

### Three repeated motifs

**1. Placeholder art tile** — every champion/item slot:
```css
background: linear-gradient(150deg, #2b2e42, #1c1e2c);
background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 3px, transparent 3px 6px);
box-shadow: inset 0 0 0 1px rgba(233,233,237,.12);
border-radius: 6–10px; /* scales with tile size: 26px→6, 32px→7, 50px→9, 88px→11 */
```
Enemy-side variant: `linear-gradient(150deg,#3a2733,#231a22)` + `inset 0 0 0 1px rgba(232,115,110,.28)`.
Featured/accent variant: `linear-gradient(150deg,#3a3663,#20223a)` + `inset 0 0 0 1px rgba(145,132,217,.45)` + `0 0 26px rgba(145,132,217,.2)`.

**2. Tier badge** — a notched rectangle, the redesign's signature mark:
```css
padding: 2–4px 6–9px;
border-radius: 4–5px;
clip-path: polygon(0 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%);
font: 700 10–13px/1 Inter;
```
Fills by tier: `S+` → bg `#9184d9`, fg `#191a28` · `S` → bg `rgba(145,132,217,.32)`, fg `#d2cefd` · `A` → bg `rgba(145,132,217,.16)`, fg `#b5abfc` · `B` and below → bg `rgba(233,233,237,.08)`, fg `rgba(233,233,237,.6)`.

**3. Hero-card scanline** — an absolutely positioned overlay on accent hero cards:
```css
background: repeating-linear-gradient(115deg, rgba(145,132,217,.05) 0 1px, transparent 1px 9px);
```
Purely atmospheric. Non-interactive; the card content sits in a `position:relative` sibling above it.

### Interaction states

Themed, never browser default.

- Row hover: `background: rgba(233,233,237,.04)`
- Card hover: swap the inset ring to `rgba(145,132,217,.35–.42)`
- Outlined button hover: `background: rgba(145,132,217,.14)`; pressed `.22`
- Neutral button hover: `background: rgba(233,233,237,.07)`
- Focus: `outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible` — every interactive element, including table rows and nav items
- Live dot: `@keyframes cbPulse { 0%,100%{opacity:.35;transform:scale(1)} 50%{opacity:1;transform:scale(1.35)} }`, 2s ease-in-out infinite. Used on the companion status dot only.

---

## Shell

Desktop window, 1440×900 design size (the app is resizable — the layouts below are the target at 1440 and were checked to survive down to ~1280 by collapsing the right column).

| Region | Spec |
| --- | --- |
| Title bar | 34px. `#12141f`. Brand chip 12×12 `linear-gradient(140deg,#9184d9,#5d5294)` r3 · "CoachBuild" 11px/500 at 72% · "Patch 16.14 · v0.103.2" 10px at 32% · window controls 44px each, close hovers to `#9c3b3b` |
| Left rail | 216px. `#12141f`, `border-right: 1px solid rgba(233,233,237,.08)`, padding `16px 12px 12px` |
| Top bar | 56px. `var(--color-bg)`, bottom hairline. Search 280×34 · phase spine centered · APPLY RUNES right |
| Content | Scrolls. Standard page padding `22px 24px 34px` |

### Left rail

Brand block: 30px rounded-7 mark, `radial-gradient(120% 120% at 30% 20%, #5d5294, #2b2741)`, ring `rgba(145,132,217,.4)` + glow `0 0 18px rgba(145,132,217,.22)`, shield-check icon. Beside it "CoachBuild" 13px/600 over "WPA INTELLIGENCE" 9px/`+0.14em`/38%.

Groups and items (this replaces the current PLAY / DATA split):

- **PLAY** — Draft, Builds, Post-Game
- **DATA** — Pro Players, Patch Movers, My Stats
- **SETUP** — Companion

Item: 8px 10px, radius 7, 13px/500, icon 15px stroked at 1.2. Inactive `rgba(233,233,237,.6)`; active `background: rgba(145,132,217,.14)`, text `var(--color-text)`, plus a 2px accent bar absolutely positioned at `left:0; top:9px; bottom:9px`, radius 2. Hover `rgba(233,233,237,.05)`.

Bottom of rail — companion status card: radius 8, `linear-gradient(150deg, rgba(70,199,155,.1), rgba(35,37,50,.9))`, ring `rgba(70,199,155,.24)`. Pulsing 6px dot + "COMPANION LIVE" 9px/`+0.14em` in `#46c79b`, then a 13px/600 state line and an 11px meta line at 50%. **Bind this to the real 5-state companion model** (`unpaired`, `paired-no-client`, `client-detected`, `champ-select`, `in-game`) — the dot and the accent tint go neutral (`rgba(233,233,237,.2)` / `rgba(233,233,237,.07)` ring) for anything that isn't genuinely connected. Never show green for an assumed state.

### Phase spine (top bar)

The redesign's spine. Container: `padding: 5px 12px`, radius 9, `#1c1e2c`, ring `rgba(233,233,237,.08)`.

Four nodes: `LOBBY`, `CHAMP SELECT`, `IN GAME`, `POST GAME`, each a dot + a 9px/`+0.12em` label, with 26×1px connectors between.

- Complete: 5px dot `#75798c`, label 42%
- Active: 6px dot `var(--color-accent)` + `box-shadow: 0 0 10px 2px rgba(145,132,217,.55)`, label `#b5abfc` at 600
- Pending: 5px dot `#3f424d`, label 30%
- Connector into/out of the active node: `linear-gradient(to right, rgba(233,233,237,.06), rgba(145,132,217,.5))` (and mirrored); all others flat `rgba(233,233,237,.06)`

Drive it from `CompanionProvider`. **Same honesty rule as the status card** — a step is only complete when it was genuinely polled.

### Top bar controls

- Search: 280×34, radius 8, `#1c1e2c`, ring `rgba(233,233,237,.1)`, 14px search icon at 45%, placeholder "Search champion, item or pro…" at 40%, and a `⌘K` chip (10px/500, `padding: 3px 5px`, ring `rgba(233,233,237,.14)`) right-aligned. Keep the existing global champion-search bus behind it.
- APPLY RUNES: 34px tall, `padding: 0 14px`, radius 8, **outlined** (`inset 0 0 0 1px #9184d9`), text `#b5abfc` 11px/600/`+0.08em`, bolt icon. Nocturne outlines primary actions — never fill them. Keep it desktop-only, as today.

---

## Screens

### 1. Draft Assistant — `app/draft/page.tsx`

The highest-value screen; it gets the most structure. Content grid: `1fr 372px`, gap 16.

**Header** — kicker "CHAMP SELECT · MID LANE · PICK 4", h1 "Draft Assistant", right-aligned data provenance line ("u.gg matchup matrix · patch 16.14 · refreshed 4m ago") at 11px/42%. Keep the existing staleness + ingest-health notices; render them in this same 11px muted style directly under the provenance line.

**Control row** — a 150px "YOUR ROLE" select card + a flex card holding YOUR TEAM (5 slots, label `rgba(70,199,155,.75)`) · a vertical fading divider · ENEMY TEAM (5 slots, label `rgba(232,115,110,.8)`) · right-aligned "LANE OPPONENT — Zed · inferred". Slots are 32px tiles; empty slots are a plus glyph at 25% in a `rgba(233,233,237,.1)` ring; your own slot reads "YOU" in a `rgba(145,132,217,.7)` ring on a `rgba(145,132,217,.1)` fill. Lane-opponent inference already exists — surface it here, and let an explicit tap override.

**THE CALL** (the verdict card) — the single most important element in the app.

Radius 10, `background: radial-gradient(130% 160% at 0% 0%, #2c2949 0%, #20222f 46%, #1b1d2a 100%)`, outer ring `rgba(145,132,217,.32)` + `0 14px 40px rgba(0,0,0,.4)`, scanline overlay, padding `18px 20px`. Layout: 82px champion tile (with the tier badge overhanging at `left:-6px; bottom:-6px`) → name block → a stat group separated by a `1px solid rgba(233,233,237,.1)` left border.

- Name 26px/600, role label 11px/`+0.1em`/45%, plus one verdict chip (`HARD COUNTERS ZED`) — `padding:3px 8px`, radius 5, `rgba(70,199,155,.14)` on `#46c79b`, 10px/600
- **Reason line, 13px/1.5 at 68%, max-width 430px.** This is the part that makes the app feel like a coach. Write it in plain words from data the app already has: which enemies the pick beats, what the comp is doing, whether it's blind-safe. Never a number restated as a sentence.
- Buttons: LOCK IN — filled `#9184d9` on `#171826` (the *one* filled button in the app; it's the terminal action), hover `#b5abfc`. SEE FULL BUILD — neutral outline, routes to Builds.
- Stats: WIN RATE (32px, with a `+6.1pp vs comp` line under it in `#46c79b`), FLOOR (with "worst 10%"), SAMPLE (with the confidence band). Floor is the Blind-Pick column that earns its place — keep it.

**Two alternate picks** — a 2-col grid of compact cards: 46px tile + notched badge, name + a role tag (`SAFEST`, `YOUR COMFORT`) in accent 9px, a 11.5px why-line at 52%, and right-aligned win rate + delta. Hover lifts the ring to `rgba(145,132,217,.42)`.

**Tab strip + filters** — segmented control (3px padding, radius 9, `#1c1e2c` track; active `rgba(145,132,217,.2)` on `#d2cefd`): Recommended / Blind Picks / Counters / Comfort. Right-aligned, a single filter summary button reading the live filter state ("Min 1,000 games · off-meta on") that opens the existing filter controls. Collapsing four separate controls into one summary is deliberate — they're rarely changed and were eating the row.

**Detailed rankings** — grid `30px 1fr 60px 74px 66px 78px 70px`, header row 9px/`+0.12em` at 40% on `rgba(233,233,237,.03)`. Rows: rank · 28px tile + name + tag chip (`META` accent, `OFF-META` neutral, `COMFORT` green) · notched tier badge · win rate 13px/600 · pick rate · Δ vs comp (signed, colored) · games. Footer line explains what the ranking is against. Keep "Carded recommendations · shown for reference" — same row style, a `rgba(233,233,237,.03)` group header above it.

**Right column, three cards:**
- **ENEMY COMP PROFILE** — 6 axes as 5px bars with a right-aligned value; physical/dive use `#e8736e`, magic/CC/frontline use `#9184d9`, anything under ~25 goes `rgba(233,233,237,.4)`. Header carries a comp-archetype chip (`DIVE · AD-HEAVY`). Below a fading rule, the takeaway chips (accent-tinted for specific claims, neutral for the honestly-generic "High ban priority").
- **MATCHUP GRID** — the u.gg pattern. Columns are the locked enemies, rows your top 5 candidates, cells 30px tall with a color scale: ≥53 `rgba(70,199,155,.22)`/`#7fe0c0` · ≥51 `rgba(70,199,155,.11)`/`#46c79b` · ≥49 `rgba(233,233,237,.06)`/60% · below `rgba(232,115,110,.14)`/`#e8736e`.
- **ON LOCK-IN** — accent-tinted card with the two automation toggles mirrored from Companion settings, so the user can see and change what will happen at lock without leaving the screen.

### 2. Builds — `app/page.tsx`

**Builds is one route with two states**, exactly as today.

**Landing** (no champion selected): a `radial-gradient(120% 180% at 8% 0%, #2a2748, #1d1f2c 55%, #1a1c28)` hero with scanline, kicker/h1 ("What are we playing?")/subhead and a 420px search field (44px, ring `rgba(145,132,217,.35)`). Then, in a `1fr 372px` grid: recent champions (4 cards with a win-rate bar), MID LANE TIER LIST (notched tier badge · tile + name + one-line note · a share bar · win rate · patch delta); right column carries YOUR LANES (5 bars from My Stats) and TRENDING THIS PATCH (rows linking to Patch Movers).

**Champion view** (a champion is selected — this is where the nav's Builds item lands):

- Hero band, `radial-gradient(90% 200% at 12% 0%, #2c2949, #1c1e2b 60%, #191b27)` + scanline, full-bleed to the content edges with `padding: 20px 24px 0`. A "← All builds" back link at 11px/45%, then 88px champion tile + notched tier badge, h1 33px, role label, a confidence chip (HIGH/MEDIUM/LOW from the existing sample-size band), then four stats (WIN RATE / PICK RATE / BAN RATE / GAMES) at 21px/600. Right: IMPORT BUILD (filled accent) + APPLY RUNES (outlined).
- **Tab row inside the hero**, underline style: 12px/600/`+0.1em`, active is `var(--color-text)` with `inset 0 -2px 0 var(--color-accent)`, inactive 40%. Tabs: **WPA BUILD · PRO CONSENSUS · ONE-TRICK**. Right-aligned, the rank-bracket segmented control (HIGH ELO / DIAMOND / EMERALD / …).

**WPA BUILD tab** — `1fr 372px`.
- BUY ORDER: horizontal item path, 50px tiles in 74px columns with 14px accent arrows between; under each, name (10px, 26px fixed height so labels align) and a meta line (`54% · 12.4k`). Header carries a `+4.1 WPA` chip. Respect the 6-slot cap; the arrows must not imply an impossible inventory.
- SITUATIONAL (list with a "when" line) and HIDDEN GEM (accent-tinted card: 44px tile, name, build rate, big green win rate, sample, and a plain-words why-line) side by side.
- SKILL ORDER: `22px repeat(18, 1fr)` grid, rows Q/W/E/R, 20px cells radius 4. Ranked cell = `rgba(145,132,217,.55)` (R = solid `#9184d9`) with the rank number in `#191a28`; empty = `rgba(233,233,237,.045)`. **Derived levels 16–18 render differently**: `rgba(145,132,217,.18)` fill, `inset 0 0 0 1px rgba(145,132,217,.5)` ring, `#b5abfc` numeral — plus the caption "Levels 16–18 derived from the published max order". The priority string (`W › E › Q`) sits beside the section label at 14px/600 in `#b5abfc`.
- Right column: RUNES (two tree columns; 54px keystone with a `0 0 0 2px rgba(145,132,217,.75)` ring and glow; rows of 28px circles, selected = `rgba(145,132,217,.28)` + `inset 0 0 0 1.5px #9184d9`, unselected = `rgba(233,233,237,.05)` + faint ring; 20px shards; spells row below a fading rule) and MATCHUPS THIS LANE (a centered ±bar around a 50% midpoint).

**PRO CONSENSUS tab** — visually distinct because it is a *different kind of claim*.
- Opens with an inline note: "Pick frequency, not WPA — what pros and high-elo players actually built, in the order they bought it. No score is applied here." plus the sample and window, right-aligned.
- MOST-BUILT PATH: same item-path geometry, but the meta line is a pick percentage in `#b5abfc` and the header chip reads `CONSENSUS`.
- **Separate STARTING ITEMS and BOOTS partitions** as two side-by-side cards with share bars. These must never merge into the completed-item list — that was a real shipped bug.
- SKILL ORDER: same grid, but **levels 16–18 stay empty** with the caption "Levels 16–18 stay blank: nobody in this sample reached them on record, and this tab never fills a level in by rule." Pro/OTP never derive.
- Right column: KEYSTONE SPLIT (34px rune circles + pick % + games), WHO'S PLAYING IT (links into Pro Players), and a closing note that consensus and WPA are different instruments, not each other's tiebreak.

**ONE-TRICK tab**
- Featured-player hero (accent gradient + scanline): 66px tile, kicker "THE BEST GALIO WE CAN FIND", handle, region/rank, a 12.5px description, and WIN RATE / GAMES / KDA behind a left border.
- THEIR BUILD: item path where **below-floor items are visually demoted** — ring drops to `rgba(233,233,237,.1)` and the percentage goes `rgba(233,233,237,.42)` instead of accent — with the caption explaining the 15% floor backfill. Header chip: `+10.4pp VS. LADDER`.
- THEIR SKILL ORDER: from the player's own timelines, with the real denominator ("19 of 386 games pulled so far"). If no timeline data exists yet, render the card with a plain sentence saying so — never an empty grid.
- Right column: WHERE THEY DIVERGE (2–3 bulleted differences from the WPA build, written as sentences), THEIR RUNES, THEIR LAST GAMES.

### 3. Post-Game — new surface, built from `app/mystats/page.tsx` + `GameDetailSheet.tsx`

Result banner: `radial-gradient(120% 200% at 6% 0%, rgba(70,199,155,.16), #1c1e2b 55%, #191b27)`, ring `rgba(70,199,155,.26)` (loss: swap both to the `#e8736e` family). Kicker "VICTORY · RANKED SOLO · 34:12", 60px champion tile, h1 "Galio · Mid", then KDA / CS-per-min / damage share at 26px.

**THREE THINGS TO FIX** — three cards, each a numbered badge (green/accent/red by kind) + title + a category tag (`BUILD` / `JUDGMENT` / `KEEP`) + a body sentence + a right-aligned stat. The `JUDGMENT` tag is load-bearing: it marks the card whose claim is inference rather than measurement, and its body says so out loud.

**WHAT YOU BUILT VS. WHAT WE'D BUILD** — two 40px item rows, yours over ours; items that differ in *position* carry a red ring on your row and an accent ring on ours. Closing sentence names the cost in plain terms.

Right column: BUILD ADHERENCE as a 132px SVG donut (`r=56`, `stroke-width=10`, track `rgba(233,233,237,.07)`, fill `#9184d9`, `stroke-linecap: round`, rotated `-90deg`) with the percentage inside and a season comparison below; then RECENT GAMES with a 3px result bar per row and the existing build-adherence chip — keeping the three distinct states (`ON BUILD` / `OFF BUILD` / `NO PATCH DATA`, the last in neutral, since "waiting for patch data" is not the user's fault).

### 4. Pro Players — `app/history/page.tsx`

Header with a source segmented control (All / Solo Queue / Pro Play). Favorite chips row: 22px tile + name + team, active chip `rgba(145,132,217,.16)` with a `rgba(145,132,217,.45)` ring.

Game cards in a 2-col grid. Header strip tinted by result (`rgba(70,199,155,.06)` / `rgba(232,115,110,.05)`): 44px tile, player + team, a champion/source/patch meta line, and a right-aligned W/L badge (`rgba(47,158,134,.3)` on `#7fe0c0` / `rgba(156,59,59,.34)` on `#f0b3b0`) over the KDA. Body: the 5v5 champion strip (26px tiles, ally tiles ringed green, enemy red, a "VS" divider) and a one-line rune/item summary. Keep the Leaguepedia CC BY-SA attribution in the footer.

### 5. Patch Movers — `app/movers/page.tsx`

One table, all lanes. Grid `1fr 78px 88px 210px 88px`. The SHIFT column is the redesign's addition: a bar in a track with a **center hairline at 50%** — positive shifts extend right of it, negative left — followed by the signed delta. Each row carries its curated patch note as a second line at 11.5px/42%, indented to the name column; when no note exists it renders `—`, never a fabrication.

### 6. My Stats — `app/mystats/page.tsx`

Kicker states the scope out loud: "RANKED SOLO · FULL SEASON · DISPLAY ONLY". Account chip top-right with the synced-at time.

Four stat tiles (GAMES / WIN RATE / MAIN / BUILD ADHERENCE), each with a value, a sub-label and a 4px progress bar. The adherence tile is the accent-tinted one — it's the tile that connects to the rest of the app.

Then `1fr 372px`: CHAMPION POOL table (champion · games · win rate · CS/min · an adherence bar + value). **CS/min shows for every champion**; a thin sample renders muted (`rgba(233,233,237,.38)`), never blank — a dash means only "nothing measured". Right column: THE PATTERN, an accent card holding one written insight that connects two of the user's own numbers, and LAST 20 GAMES as a row of 26×30 result tiles.

### 7. Companion — `app/live-setup/page.tsx`

Max width 900px; this page is prose, not a dashboard.

Status hero: green-tinted card, pulsing dot, state line, script version + last poll right-aligned, and the **4-step rail** (CLIENT → LOBBY → CHAMP SELECT → IN GAME) as 15px ring-dots with connectors — complete green, active accent with glow, pending a bare `rgba(233,233,237,.18)` ring.

INSTALL card: two labeled commands in `#12141f` code fields (12px `ui-monospace`, `#d2cefd`) each with an outlined COPY button.

AUTOMATION card: two rows, each a 38×21 toggle + title + body. Privacy footnote with a shield icon closes it.

**IN-GAME OVERLAY card** (replaces the removed Live Game screen — see below).

---

## The in-game overlay

The user does not want an in-app live screen. The only live surface is the overlay app, and its only job is naming the next ability to level.

Widget spec — **250px wide**, `padding: 12px 13px`, radius 10, `rgba(18,20,31,.88)`, `box-shadow: 0 0 0 1px rgba(145,132,217,.3), 0 10px 30px rgba(0,0,0,.55)`:

1. Header row: pulsing 5px green dot · "COACHBUILD · GALIO" 8.5px/`+0.14em` at 40% · right-aligned "LV 11"
2. Body: 46px ability tile (`linear-gradient(150deg,#4a4380,#25243c)`, ring `rgba(145,132,217,.55)`, glow `0 0 20px rgba(145,132,217,.3)`, glyph 20px/600 in `#e7e5fe`) + ability name 13px/600 + the rank transition `3 → 4` with a 12px arrow, in `#b5abfc`
3. Footer: a Q/W/E/R strip of four equal 22px cells; the next ability is `rgba(145,132,217,.3)` with an accent ring, the rest `rgba(233,233,237,.05)`

Three states, all of which the existing `lib/nextSkill.ts` resolver already distinguishes:

| State | Treatment |
| --- | --- |
| Next ability | The default above |
| Ultimate available | R tile solid `#9184d9` with `#191a28` glyph. Only when the game will legally allow the rank — the level gate is checked, never assumed |
| Refuses | Em-dash glyph on a neutral tile. Past level 15 the source has nothing; show the dash, not a guess |

The card on the Companion page presents the widget at real size over a `radial-gradient(120% 140% at 20% 0%, #1d2530, #0f1319 70%)` faux-game stage, with the three states listed beside it, a DOWNLOAD FOR WINDOWS outlined button, and the compliance line: "Reads only your own champion, level and ability ranks from the live game API. Nothing about enemies, no cooldowns, no input."

Keep `/compact` as the second-monitor variant of exactly this widget, scaled up.

---

## Interactions & behavior

- **Navigation** — rail switches screens; nav item for Builds highlights on both the landing and the champion view. "← All builds" returns to the landing. Tier-list, trending and recent-champion rows route into the champion view.
- **Build tabs** — local state, no route change; the hero band and rank-bracket control persist across tabs.
- **Draft tab strip** — Recommended / Blind / Counters / Comfort filter the same ranking. Comfort and Counters *filter*, never re-score — the order must stay identical to Recommended.
- **Live sync** — champ-select pickup drives the phase spine, the control row and the verdict card. A manual edit enters Manual mode: banner it at the top of the control row in the accent-tinted card style, and re-attach automatically on the next fresh champ select.
- **Transitions** — nav/tab/hover changes are 120ms ease; no layout animation, no page transitions. The only continuous motion in the app is the 2s companion pulse. Respect `prefers-reduced-motion` (the repo already has the global rule).
- **Loading** — skeletons in the shape of the real card, `rgba(233,233,237,.05)` blocks at the exact final geometry. Never a centered spinner.
- **Empty / error** — keep the existing distinct states. Style them as a card with a 13px sentence at 55% and, where relevant, one outlined action. Insufficient data and a fetch failure must stay visually and verbally different.

## State

No new state model. The redesign consumes what exists: `CompanionProvider` (phase spine, status card, live sync), the draft filter/tab state, the build tab + rank bracket, and the My Stats account selection. New local state is only: which build tab is active, and which champion the Builds route is showing.

## Files

In this bundle:

- `CoachBuild Redesign.dc.html` — the full interactive design reference. Open in a browser; the rail switches screens.
- `nocturne-styles.css` — the Nocturne token sheet. Port `:root` into `app/globals.css`.
- `nocturne-guide.md` — the design system's own written guidance (direction, color, type, do/don't).
- `screenshots/` — every screen at 1440×900, 1:1:

| File | Screen |
| --- | --- |
| `01-draft-assistant.png` | Draft Assistant — verdict card, alternates, rankings, comp profile, matchup grid |
| `02-builds-wpa-build.png` | Builds → WPA BUILD — hero band, buy order, situational, hidden gem, skill grid, runes |
| `03-builds-pro-consensus.png` | Builds → PRO CONSENSUS — most-built path, starting/boots partitions, keystone split |
| `04-builds-one-trick.png` | Builds → ONE-TRICK — featured player, their build, where they diverge |
| `05-builds-landing.png` | Builds landing — search hero, recent champions, tier list, your lanes, trending |
| `06-post-game.png` | Post-Game — result banner, three things to fix, build comparison, adherence donut |
| `07-pro-players.png` | Pro Players — source filter, favorite chips, game cards |
| `08-patch-movers.png` | Patch Movers — centered shift bars with per-row patch notes |
| `09-my-stats.png` | My Stats — stat tiles, champion pool, the pattern, last 20 games |
| `10-companion.png` | Companion — status hero, 4-step rail, install commands, automation |
| `11-in-game-overlay.png` | The in-game overlay at real size (2×) with its three states |

Where each screen lands in the repo:

| Screen | Repo files |
| --- | --- |
| Shell (rail, top bar, phase spine) | `components/hextech/AppShell.tsx`, `components/hextech/GlobalNav/*` |
| Draft Assistant | `app/draft/page.tsx`, `components/hextech/draftAssistantModel.ts`, `DraftCompBars.tsx`, `DraftPicksTable.tsx`, `EnemyTeamPanel.tsx`, `components/live/draftRecommend.ts` |
| Builds (landing + 3 tabs) | `app/page.tsx`, `components/hextech/BuildTabContent.tsx`, `ChampionHero.tsx`, `ItemBuildCard.tsx`, `CoreBuildOrderCard.tsx`, `HiddenGemCard.tsx`, `FeaturedOtpCard.tsx`, `components/RunePage.tsx`, `components/ItemPath.tsx`, `lib/skillOrderModel.ts`, `lib/buildSlots.ts` |
| Post-Game | `app/mystats/page.tsx`, `components/GameDetailSheet.tsx`, `components/hextech/myStats.ts` |
| Pro Players | `app/history/page.tsx`, `components/ProGameCard.tsx`, `components/proGames.types.ts` |
| Patch Movers | `app/movers/page.tsx`, `lib/patchMovers.ts` |
| My Stats | `app/mystats/page.tsx`, `components/hextech/mystats/*` |
| Companion + overlay card | `app/live-setup/page.tsx`, `components/live/CompanionProvider.tsx`, `components/hextech/companion/*` |
| Overlay app | `overlay-host/main.js`, `lib/nextSkill.ts`, `app/compact/page.tsx` |
| Tokens | `app/globals.css`, `tailwind.config.ts` |

## Assets

No new assets. Champion, item, rune and spell art comes from the coachless CDN URLs the API already returns — render through the existing `IconWithFallback`. The monogram tiles in the prototype are placeholders for exactly those images; keep the tile geometry and ring, replace the monogram with the `<img>`.

Icons are inline SVG on `currentColor`, 1.2 stroke weight, drawn in the Phosphor style at 12–15px. Nocturne specifies Phosphor — pull the real set from `@phosphor-icons/react` rather than reproducing the prototype's hand-drawn paths.

## Suggested order of work

1. Tokens: swap `:root` and `tailwind.config.ts` to Nocturne, keeping the existing token *names* so untouched call sites pick the new palette up for free — the same trick the repo used for the cyan → gold reskin.
2. Shell: rail, top bar, phase spine. Everything else renders inside it.
3. Builds champion view + the three tabs (the most-used screen).
4. Draft Assistant.
5. Companion + the overlay card; retire any in-app live screen.
6. Post-Game, My Stats, Patch Movers, Pro Players.
