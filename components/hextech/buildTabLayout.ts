// ─────────────────────────────────────────────────────────────────────────────
// The Builds page's tab set, and which cards live under each tab.
//
// Pure data + pure helpers, no JSX — plain .ts so vitest can import it (this
// repo has no JSX render harness, see CLAUDE.md). BuildTabContent.tsx maps over
// it; nothing here knows about Tailwind or the DOM.
//
// ── WHAT THIS FILE USED TO SAY, AND WHY IT WAS WRONG ────────────────────────
// Until 2026-07-29 this exported `BUILD_TAB_LAYOUT`, a left/right column
// membership list over five card ids: runes, core, starting, proConsensus,
// situational. That described the v0.44.0 composition and had been stale for a
// long time — v0.51.0 collapsed Starting/Core/Situational into ONE ItemBuildCard
// and v0.70.0/2026-07-29 added SkillOrderCard and FeaturedOtpCard, none of which
// this file had ever heard of. It had no importer outside its own test, so
// nothing caught the drift: a "unit-tested" module can still be describing a
// layout that no longer exists anywhere, and a passing test then certifies the
// wrong thing. It is rewritten rather than deleted because BuildTabContent's
// tab set genuinely benefits from a testable source of truth — but it is now
// wired into the component, which is what stops the same rot recurring.
//
// ── THE COMPOSITION THIS DESCRIBES (2026-07-29) ─────────────────────────────
// Build / Pro / OTP are the navigation at EVERY width now, not just below `lg`.
// Before this the tab strip was `lg:hidden` and every panel escaped its own
// gate through `lg:block`, so desktop rendered all five sections as one long
// scroll — deliberate at the time ("desktop keeps the current single-scroll
// layout"), and reversed by user directive 2026-07-29: "I dont want them all in
// a single long page."
//
// One tab owns the whole content width now, so each tab needs a composition
// that earns that width on its own:
//   build — RUNES beside ITEM BUILD (5fr/7fr), SKILL ORDER full-width beneath.
//           Unchanged from what desktop already showed; it was never the
//           broken part.
//   pro   — ProConsensusCard alone. It already spanned the full row before this
//           change ('pro pro') and carries its own measured 5fr/7fr split
//           internally (runes | starting+items), so it needs no outer grid.
//   otp   — FeaturedOtpCard alone, same story: it was already a full-width row.
//           Its BODY is what got the desktop composition — see that file. It
//           shipped 7fr/5fr build-left for a few hours and was reversed to the
//           house runes-left 5fr/7fr the same day, so all three tabs now put the
//           same thing under the reader's cursor. That reversal was a real DOM
//           reorder, not a grid-area shuffle — see OTP_BODY_GRID_CLASS for why
//           the cheaper option was refused.
// ─────────────────────────────────────────────────────────────────────────────

/** The three views of a champion's build. `"build"` is the WPA recommendation
 *  (the card inside is headed "WPA BUILD"), `"pro"` is pro consensus, `"otp"`
 *  is the featured one-trick. */
export type BuildTab = "build" | "pro" | "otp";

export interface BuildTabOption {
  value: BuildTab;
  label: string;
}

/**
 * Tab order and labels — identical to what mobile has shipped since 2026-07-28,
 * because desktop is adopting mobile's navigation rather than inventing a
 * parallel one ("just like in mobile").
 *
 * "Build" rather than "WPA": the labels are pinned to the mobile set on purpose.
 * See HANDOFF-fronty.md — whether this first tab should read "WPA" is an open
 * question left for the user, not a unilateral rename.
 *
 * OTP keeps its own tab rather than sharing "pro": pros and one-tricks answer
 * different questions ("what does the meta's best execution look like" vs "what
 * does the person who has played this 700 times build"), and stacking both under
 * one tab rebuilds the ~3,000px champ-select scroll these tabs exist to kill.
 */
export const BUILD_TAB_OPTIONS: readonly BuildTabOption[] = [
  { value: "build", label: "Build" },
  { value: "pro", label: "Pro" },
  { value: "otp", label: "OTP" },
];

/** The tab shown on load, and the fallback for any unrecognised value. */
export const DEFAULT_BUILD_TAB: BuildTab = "build";

// NO CARD-MEMBERSHIP CONSTANT LIVES HERE, ON PURPOSE.
//
// The obvious next export is a `Record<BuildTab, BuildCardId[]>` for
// BuildTabContent's markup and its loading skeleton to map over. It was written
// and then removed the same hour, because it cannot actually drive the markup:
// the cards are placed with Tailwind arbitrary classes (`[grid-area:runes]`),
// Tailwind's JIT scans SOURCE TEXT, and an interpolated `[grid-area:${id}]`
// generates no CSS at all. A membership list that the render cannot consume is
// a list with no importer — which is precisely the failure documented above,
// where five stale card ids sat here passing their own tests for months.
//
// If a future change does need this, it has to come with a safelist entry or a
// static class map, not a bare array.

/** DOM id of a tab button. Must match HextechTabs' own generated id — that
 *  component builds `hextech-tab-${value}` and `aria-controls` off the same
 *  shape, and the panels' `aria-labelledby` points back at it. */
export function buildTabId(tab: BuildTab): string {
  return `hextech-tab-${tab}`;
}

/** DOM id of a tab's panel — the target of the tab button's `aria-controls`. */
export function buildTabPanelId(tab: BuildTab): string {
  return `hextech-tabpanel-${tab}`;
}

/** Narrows an arbitrary string to a known tab. */
export function isBuildTab(value: string): value is BuildTab {
  return BUILD_TAB_OPTIONS.some((o) => o.value === value);
}
