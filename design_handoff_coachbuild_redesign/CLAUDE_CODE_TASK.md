# Task: implement the CoachBuild redesign

You are implementing a completed, high-fidelity redesign of this repository's UI. Everything you need is in `design_handoff_coachbuild_redesign/`.

## Read first

1. `design_handoff_coachbuild_redesign/README.md` — the full spec: tokens, shell, every screen, every component, exact colors and type.
2. `design_handoff_coachbuild_redesign/screenshots/` — the visual acceptance target. Each PNG is 1440×900, 1:1.
3. `design_handoff_coachbuild_redesign/CoachBuild Redesign.dc.html` — the interactive prototype. Open it in a browser and click through before writing code. **Do not port this file.** It is a standalone inline-styled reference with no relationship to this repo's structure.

## Ground rules

- **Recreate, don't copy.** Build in Next.js + React + Tailwind using this repo's existing components (`components/hextech/*`, `components/live/*`) and data pipelines. The prototype's inline styles are a specification, not source.
- **No data-layer changes.** Every screen consumes what already exists — `BuildResponse`, `SkillOrderModel`, the draft matchup matrix, `CompanionProvider`, My Stats. If a screen seems to want data the API doesn't return, it doesn't: re-read the spec.
- **Preserve the honesty posture.** It is a product feature, not boilerplate. Sample sizes, `off-meta` tags, `(low data)` / `(suggested)` labels, the "levels 16–18 withheld" refusal, the `JUDGMENT` tag on inferred claims, and the companion's five real states all have designed treatments in the spec. Do not simplify any of them away, and never let a step or a stat read as confirmed when it isn't.
- **Tabular numerals everywhere.** Every stat, delta, timer and count uses `font-variant-numeric: tabular-nums`.
- **Signal color is for data only.** `#46c79b` and `#e8736e` never appear as decoration.

## Order of work

1. **Tokens** — replace the Hextech-gold palette in `app/globals.css` and `tailwind.config.ts` with the Nocturne values from `nocturne-styles.css`. Keep the existing token *names* so untouched call sites pick up the new palette for free (the same trick the repo used for the cyan → gold reskin). Ship and eyeball this step alone before continuing.
2. **Shell** — left rail (PLAY / DATA / SETUP), top bar, and the phase spine, in `AppShell.tsx` + `components/hextech/GlobalNav/*`. Everything else renders inside it. The rail loses the Live Game destination.
3. **Builds** — champion view with the three tabs (WPA BUILD / PRO CONSENSUS / ONE-TRICK), then the landing state. Most-used screen; get it right first.
4. **Draft Assistant** — the verdict card is the highest-value element in the redesign. Its reason line must be generated from data the app already has, in plain words.
5. **Companion** — status hero, 4-step rail, install, automation, and the in-game overlay card. Retire any in-app live screen; the overlay app is the only live surface.
6. **Post-Game, My Stats, Patch Movers, Pro Players.**

## Definition of done

Each screen matches its screenshot at 1440×900 — spacing, type scale, color and copy — and degrades cleanly to ~1280 by collapsing the 372px right column. Existing tests still pass; the item-set, skill-order and companion-state invariants documented in `CLAUDE.md` are untouched.
