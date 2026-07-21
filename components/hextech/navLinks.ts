// Single source of truth for the 5 cross-route utility links shown in the
// Sidebar's desktop footer AND (v0.44.0) the mobile MobileNavMenu overflow
// menu — kept as one exported list so the two surfaces can't drift (plan
// §4/§17: "shared registry"). Pure data, no JSX, so it's importable from a
// plain .ts vitest file (see components/hextech/situational.ts for why that
// constraint exists).
export interface NavLink {
  href: string;
  label: string;
}

export const NAV_LINKS: NavLink[] = [
  { href: "/history", label: "Pro players" },
  { href: "/movers", label: "Patch movers" },
  { href: "/live-setup", label: "Companion" },
  { href: "/draft", label: "Draft" },
  { href: "/mystats", label: "My Stats" },
];
