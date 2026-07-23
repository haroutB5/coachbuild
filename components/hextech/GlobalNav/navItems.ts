// Global nav redesign (v0.50.0, global-nav-plan.md) — single source of truth
// for the branded left rail (desktop) + bottom tab bar (mobile). Replaces
// components/hextech/navLinks.ts (5 utility links, no icons/grouping) and
// components/TabNav.tsx's own hardcoded TABS array. Pure data, no JSX — kept
// importable from a plain .ts vitest file (same constraint as navLinks.ts /
// situational.ts before it).
//
// Mockup order (plan's Decision/New-files section): PLAY (Builds, Draft,
// Companion) then DATA (Pro Players, Patch Movers, My Stats). Mobile bottom
// bar is desktop-play-minus-Companion-and-Draft, per the user's explicit
// directive ("similar but remove Companion AND Draft AND the companion card
// — desktop-play-only") — MOBILE_NAV_ITEMS derives from `mobile: true` rather
// than being hand-duplicated, so the two surfaces can't drift.
export interface NavItem {
  id: string;
  href: string;
  label: string;
  group: "play" | "data";
  iconKey: string;
  mobile: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "builds", href: "/", label: "Builds", group: "play", iconKey: "crossed-swords", mobile: true },
  { id: "draft", href: "/draft", label: "Draft", group: "play", iconKey: "medal", mobile: false },
  { id: "companion", href: "/live-setup", label: "Companion", group: "play", iconKey: "broadcast", mobile: false },
  { id: "pro-players", href: "/history", label: "Pro Players", group: "data", iconKey: "trophy", mobile: true },
  { id: "patch-movers", href: "/movers", label: "Patch Movers", group: "data", iconKey: "trending-up", mobile: true },
  { id: "my-stats", href: "/mystats", label: "My Stats", group: "data", iconKey: "bar-chart", mobile: true },
];

export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.mobile);
