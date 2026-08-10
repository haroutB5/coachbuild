// Global nav redesign (v0.50.0, global-nav-plan.md) — single source of truth
// for the branded left rail (desktop) + bottom tab bar (mobile). Replaces
// components/hextech/navLinks.ts (5 utility links, no icons/grouping) and
// components/TabNav.tsx's own hardcoded TABS array. Pure data, no JSX — kept
// importable from a plain .ts vitest file (same constraint as navLinks.ts /
// situational.ts before it).
//
// Nocturne order: PLAY (Draft, Builds, Post-Game), DATA (Pro Players, Patch
// Movers, My Stats), then SETUP (Companion). The Post-Game surface is still
// hosted by My Stats until stage 4 gives it a dedicated route; its query
// intent keeps that hand-off explicit without inventing a new screen here.
// Mobile bottom bar keeps the existing four-destination pattern in the bar
// itself — Draft, Post-Game and Companion are NOT bar destinations. They are
// no longer desktop-only, though: `mobile: false` now means "reached through
// the bar's More sheet", not "unreachable on a phone".
//
// 2026-08-10 — WHY THAT CHANGED. At 390px the only navigation destinations
// anywhere in the DOM were the bar's four (/, /history, /movers, /mystats).
// There was no drawer, no hamburger, no overflow menu, so /draft,
// /mystats?intent=game-detail and /live-setup had no entrance at all — you
// could only reach them by typing the URL. The pages themselves are built for
// mobile and work fine once reached (/draft renders, its enemy picker opens,
// tabs and sort operate, scrollWidth 390). The sharpest case was /live-setup:
// it is the COMPANION PAIRING page, and its only entrance was the desktop
// rail's companion card. The `mobile` flag now splits the bar from the sheet
// instead of splitting reachable from unreachable — see MobileTabBar.tsx.
export interface NavItem {
  id: string;
  href: string;
  label: string;
  /** Bottom-bar-only label, when `label` does not fit a fifth of a phone.
   *
   *  Added 2026-08-10 with the More cell: five columns at 390px is 78px each
   *  (64px at 320px), and "Patch Movers" measured 81.6px on one line, so it
   *  wrapped to two lines and spilled out of the 56px cell. Measured, not
   *  guessed — see MobileTabBar.tsx.
   *
   *  Two rules, both enforced by the tests beside this file:
   *  1. It must be a SUBSTRING of `label`, never a different word. The bar and
   *     the desktop rail are the same destination, and WCAG 3.2.4 (Consistent
   *     Identification) is the reason a phone user should not have to learn a
   *     second name for it. "Pro Players" -> "Players", not "Pros".
   *  2. It is rendered as the visible text with NO aria-label override. An
   *     aria-label carrying the full label would break WCAG 2.5.3 (Label in
   *     Name) — the accessible name must contain the visible text, so a
   *     voice-control user saying "click Players" would match nothing. */
  shortLabel?: string;
  group: "play" | "data" | "setup";
  iconKey: string;
  mobile: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "draft", href: "/draft", label: "Draft", group: "play", iconKey: "draft", mobile: false },
  { id: "builds", href: "/", label: "Builds", group: "play", iconKey: "builds", mobile: true },
  { id: "post-game", href: "/mystats?intent=game-detail", label: "Post-Game", group: "play", iconKey: "post-game", mobile: false },
  { id: "pro-players", href: "/history", label: "Pro Players", shortLabel: "Players", group: "data", iconKey: "trophy", mobile: true },
  { id: "patch-movers", href: "/movers", label: "Patch Movers", shortLabel: "Movers", group: "data", iconKey: "patch-movers", mobile: true },
  { id: "my-stats", href: "/mystats", label: "My Stats", group: "data", iconKey: "my-stats", mobile: true },
  { id: "companion", href: "/live-setup", label: "Companion", group: "setup", iconKey: "companion", mobile: false },
];

/** The four fixed destinations IN the bottom bar. Unchanged, deliberately —
 *  they are the common path and moving them would cost every existing user
 *  their muscle memory to buy nothing. */
export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.mobile);

/** Everything else, reached through the bar's More sheet. Derived as the exact
 *  complement of MOBILE_NAV_ITEMS so the two can never drift: a nav item added
 *  to NAV_ITEMS lands in one list or the other and cannot end up in neither,
 *  which is precisely how three destinations went unreachable on a phone. */
export const MOBILE_OVERFLOW_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => !item.mobile);
