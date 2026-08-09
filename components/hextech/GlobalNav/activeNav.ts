// Pure active-route matcher for the rail/bottom-bar (v0.50.0). `/` (Builds)
// must match ONLY the exact root — a prefix match there would light up
// Builds on every other route too (every href starts with "/"). Every other
// route matches itself or a nested path under it (e.g. a future
// `/history/[id]` sub-route should still light up "Pro Players"). Query intent
// is part of the route contract for the Post-Game hand-off: `/mystats` and
// `/mystats?intent=game-detail` render different surfaces and must not both
// light up the rail.
export function isActiveNav(pathname: string, href: string, search = ""): boolean {
  const [route, query = ""] = href.split("?", 2);
  if (route === "/") return pathname === "/";
  if (pathname !== route && !pathname.startsWith(`${route}/`)) return false;

  const target = new URLSearchParams(query);
  const current = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  // A query-bearing item is an intent-specific destination. It is active only
  // when every declared query value matches the current URL.
  for (const [key, value] of target) {
    if (current.get(key) !== value) return false;
  }

  // The query-less My Stats item is the ordinary stats surface, not the
  // Post-Game intent. Keep it inactive while that intent is open.
  if (target.size === 0 && current.get("intent") === "game-detail") return false;
  return true;
}
