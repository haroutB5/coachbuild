// ─────────────────────────────────────────────────────────────────────────────
// topBarChrome.ts — pure route -> TopBar chrome mapping (v0.63.4 mobile-parity
// fix). TopBar (./TopBar.tsx) is global chrome mounted on EVERY route by
// AppShell.tsx; two of its three zones need to react to route + form factor:
//
// - Apply Runes is ALWAYS desktop-only (companionClient.ts talks to
//   http://127.0.0.1:<port> — a same-machine League-client bridge that simply
//   has no meaning on a phone). That's a flat rule, not route-dependent, so it
//   lives as a static class on ApplyRunesButton itself, not in this file.
// - TopBarChampionSearch duplicates a search box some PAGES already own
//   (/history's "Search a pro player…", /draft's two champion inputs) — on
//   narrow (mobile, below the `lg` breakpoint DesktopRail/MobileTabBar already
//   split on) that's two-to-three stacked search boxes on one screen. Desktop
//   always keeps the global search on every route — there's room, and it's a
//   genuine global-nav affordance; only mobile needs the route-aware hide.
//
// Extracted as a pure function (not inlined in TopBar.tsx) so this route list
// is ONE source of truth and is unit-testable without mounting TopBar/
// AppShell/CompanionProvider.
// ─────────────────────────────────────────────────────────────────────────────

const HIDE_SEARCH_ON_MOBILE_ROUTES = new Set(["/history", "/draft"]);

export interface TopBarChromeConfig {
  /** True => TopBarChampionSearch is hidden below the `lg` breakpoint on this
   *  route (the page already owns its own champion/player search there).
   *  Always visible at `lg`+ regardless of this flag. */
  hideSearchOnMobile: boolean;
}

export function topBarChromeConfig(pathname: string | null): TopBarChromeConfig {
  return { hideSearchOnMobile: pathname != null && HIDE_SEARCH_ON_MOBILE_ROUTES.has(pathname) };
}
