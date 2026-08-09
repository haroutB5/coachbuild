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
// Mobile bottom bar keeps the existing four-destination pattern — Draft,
// Post-Game, and Companion remain desktop-only.
export interface NavItem {
  id: string;
  href: string;
  label: string;
  group: "play" | "data" | "setup";
  iconKey: string;
  mobile: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "draft", href: "/draft", label: "Draft", group: "play", iconKey: "draft", mobile: false },
  { id: "builds", href: "/", label: "Builds", group: "play", iconKey: "builds", mobile: true },
  { id: "post-game", href: "/mystats?intent=game-detail", label: "Post-Game", group: "play", iconKey: "post-game", mobile: false },
  { id: "pro-players", href: "/history", label: "Pro Players", group: "data", iconKey: "trophy", mobile: true },
  { id: "patch-movers", href: "/movers", label: "Patch Movers", group: "data", iconKey: "patch-movers", mobile: true },
  { id: "my-stats", href: "/mystats", label: "My Stats", group: "data", iconKey: "my-stats", mobile: true },
  { id: "companion", href: "/live-setup", label: "Companion", group: "setup", iconKey: "companion", mobile: false },
];

export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.mobile);
