// Pure active-route matcher for the rail/bottom-bar (v0.50.0). `/` (Builds)
// must match ONLY the exact root — a prefix match there would light up
// Builds on every other route too (every href starts with "/"). Every other
// route matches itself or a nested path under it (e.g. a future
// `/history/[id]` sub-route should still light up "Pro Players").
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
