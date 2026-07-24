# Global Navigation Redesign — CoachBuild v0.50.0 — Implementation Plan

> Authored by the opus Plan agent 2026-07-24 (persisted by urgot). Base HEAD v0.49.2 → ships as **v0.50.0** (mockup "v0.50" = injected NEXT_PUBLIC_APP_VERSION).

## Goal
Replace the fragmented nav (per-page TabNav + Builds-only hextech Sidebar + MobileNavMenu) with ONE branded global left rail (desktop) + a bottom tab bar (mobile), per the user's mockup.

**Mockup (desktop rail):** CB logo tile + "COACHBUILD" / "WPA INTELLIGENCE" wordmark; section **PLAY** (Builds [crossed-swords], Draft [medal], Companion [broadcast]); section **DATA** (Pro Players [trophy], Patch Movers [trending-up], My Stats [bar-chart]); bottom **companion status card** (green dot · "COMPANION · ON" / "Client detected" / "Waiting for queue…"); footer "PATCH 16.13" + "v0.50".
**User directive:** mobile = "similar but remove Companion AND Draft AND the companion card — desktop-play-only." Mobile nav = Builds, Pro Players, Patch Movers, My Stats only.

## Decisions (resolved forks)
1. **Global shell in app/layout.tsx inside CompanionProvider.** New `components/hextech/AppShell.tsx` ("use client") wraps `{children}`: `<div className="lg:flex min-h-screen">` → `DesktopRail` (hidden lg:flex, w-[232px]) + `<main className="flex-1 min-w-0 pb-16 lg:pb-0">{children}</main>` + `MobileTabBar` (lg:hidden fixed bottom-0). Inside CompanionProvider so the card reads `useCompanion()`. Layout: `<CompanionProvider><AppShell>{children}</AppShell><AutoExporter/></CompanionProvider>`.
2. **Builds search+lanes relocate** to new `components/hextech/BuildsSearchBar.tsx` at the TOP of app/page.tsx's `<main>` content (above ChampionHero). Reuse `SidebarChampionSearch` verbatim (keeps CHAMPIONS/PROS toggle, combobox a11y, pro typeahead, request-id guards) + a horizontal lane selector (lanes lifted from Sidebar; searchMode==="champions"-gated; grid/wrap NOT overflow-x). PROS-search machinery (searchMode/selectedPlayer/isProsSearchEmpty/ProsSearchPrompt/deriveMainView) PRESERVED IN PLACE — do NOT route PROS→/history (would fork the state). **VERBATIM RULE:** every effect/handler in app/page.tsx preserved byte-for-byte (deep-link mount, companion.tick follow, getMostPlayedLane + mostPlayedLaneRequestRef, sheetNav/useSheetBackNav, tabRef/gamesSourceRef); ONLY JSX changes — delete the two `<Sidebar>` renders + their lg:flex wrapper, insert `<BuildsSearchBar>` with identical props.
3. **Companion status card — honest state→copy** (pure `companionStatusModel` in `components/hextech/GlobalNav/companionStatusCard.ts`), from real useCompanion fields only:
   - session===null → grey dot, "COMPANION · OFF" / "Not paired" / "Set up →" (href /live-setup)
   - session set, !clientConnected → amber, "COMPANION · ON" / "Client not detected" / "Waiting for League client…"
   - clientConnected, phase not ChampSelect/InProgress → green, "ON" / "Client detected" / "Waiting for queue…"
   - phase ChampSelect → green, "ON" / "In champ select" / "Locking in…"
   - phase InProgress → green, "ON" / "In game" / "Live"
   Mirrors /live-setup's grey/gold/green vocabulary. IMPROVEMENT over mockup (always-green): degrade honestly; unpaired card links to /live-setup.
4. **Mobile = bottom tab bar** `components/hextech/GlobalNav/MobileTabBar.tsx` (lg:hidden fixed bottom-0 inset-x-0 grid grid-cols-4), 4 items (Builds, Pro Players, Patch Movers, My Stats), icon-over-label, aria-current, ≥44px targets. NO Companion/Draft/card. grid never overflow-x. (Bottom bar over drawer: 4 fixed destinations = canonical bottom-nav; drawer hides nav for no benefit.)
5. **Theme: rail stays Hextech GOLD on all routes incl /draft** (rail is chrome, not content). Rail lives OUTSIDE `.draft-tactical`. Required CSS change: `.dt-circuit-bg` `position: fixed`→`absolute` in globals.css (confine cyan circuit bg to the draft content column, not under the rail; `.draft-tactical` is already position:relative;isolation:isolate). Verify no cyan on rail at /draft.
6. **Version+patch footer:** version = process.env.NEXT_PUBLIC_APP_VERSION → "v0.50". Patch: NEW `app/api/patch/route.ts` GET → `{ patch: await getLatestPatch() }` (s-maxage=3600; patch never empty). AppShell fetches once (best-effort, catch→null), feeds rail footer `PATCH {patch ?? "—"}` left + `v{version}` right.
7. **Retire:** TabNav.tsx (→ rail + MobileTabBar; remove from draft/history/movers/mystats), hextech/Sidebar.tsx (→ rail header + BuildsSearchBar; delete both renders from app/page.tsx), MobileNavMenu.tsx (→ MobileTabBar), navLinks.ts + navLinks.test.ts (→ navItems.ts + test). KEEP SidebarChampionSearch.tsx (reused in BuildsSearchBar).

## New files
- `components/hextech/GlobalNav/navItems.ts` (pure): `NavItem{id;href;label;group:"play"|"data";iconKey;mobile:boolean}`; `NAV_ITEMS` (6, mockup order), `MOBILE_NAV_ITEMS` (filter mobile, 4). Play: Builds `/`, Draft `/draft`, Companion `/live-setup`. Data: Pro Players `/history`, Patch Movers `/movers`, My Stats `/mystats`. mobile:true only Builds/ProPlayers/PatchMovers/MyStats.
- `components/hextech/GlobalNav/activeNav.ts` (pure): `isActiveNav(pathname, href)` (exact for `/`, prefix otherwise).
- `components/hextech/GlobalNav/companionStatusCard.ts` (pure): model per Decision 3.
- `components/hextech/GlobalNav/NavIcon.tsx`: inline-SVG map (crossed-swords/medal/broadcast/trophy/trending-up/bar-chart + CB tile) by iconKey.
- `components/hextech/GlobalNav/CompanionStatusCard.tsx` ("use client"): reads useCompanion, renders model.
- `components/hextech/GlobalNav/DesktopRail.tsx` ("use client", usePathname): header + PLAY + DATA + mt-auto card + PATCH/version footer. `hidden lg:flex lg:flex-col w-[232px] bg-sidebar border-r border-line min-h-screen`.
- `components/hextech/GlobalNav/MobileTabBar.tsx` ("use client").
- `components/hextech/AppShell.tsx` ("use client"): rail + main + mobile bar; fetch /api/patch once.
- `components/hextech/BuildsSearchBar.tsx` ("use client"): props identical to what Sidebar received; SidebarChampionSearch + horizontal lane row.
- `app/api/patch/route.ts`: GET → {patch}.
- Tests: GlobalNav/__tests__/{navItems,activeNav,companionStatusCard}.test.ts (pure).

## Modified
- app/layout.tsx (wrap in AppShell).
- app/page.tsx (delete 2 Sidebar renders + lg:flex wrapper; insert BuildsSearchBar; effects VERBATIM; keep page footer legal attribution).
- app/draft/page.tsx, app/history/page.tsx, app/movers/page.tsx, app/mystats/page.tsx (remove TabNav import + render).
- app/globals.css (.dt-circuit-bg fixed→absolute; height guard to fill .draft-tactical).
- package.json (0.49.2 → 0.50.0).

## Deleted
TabNav.tsx, hextech/Sidebar.tsx, hextech/MobileNavMenu.tsx, hextech/navLinks.ts, __tests__/navLinks.test.ts.

## Pinned contracts (if engo used — else fronty owns all)
```ts
export interface NavItem { id: string; href: string; label: string; group: "play"|"data"; iconKey: string; mobile: boolean }
export const NAV_ITEMS: NavItem[]; export const MOBILE_NAV_ITEMS: NavItem[];
export function isActiveNav(pathname: string, href: string): boolean;
export type CompanionTone = "off"|"idle"|"live";
export interface CompanionStatusModel { tone: CompanionTone; dotClass: string; header: string; title: string; subtitle: string; href?: string }
export function companionStatusModel(input: { session: string|null; phase: string|null; clientConnected: boolean; champSelect: unknown|null }): CompanionStatusModel;
```

## Agent split: fronty-solo recommended (one owner for the fragile app/page.tsx conversion). engo optional for the 3 pure modules + tests behind the contracts; coordination cost likely exceeds benefit. Do NOT split app/page.tsx or AppShell.

## Tests (pure .ts, vitest)
- navItems: 6 items; groups partition; MOBILE_NAV_ITEMS === [Builds,ProPlayers,PatchMovers,MyStats] in order, EXCLUDES /draft + /live-setup; no dup hrefs; real routes. (replaces navLinks.test.ts)
- activeNav: `/` matches only `/` not `/draft`; prefix cases.
- companionStatusCard: full 5-row truth table; assert dotClass + copy exactly.

## Risk register
- R1 (highest): app/page.tsx effects byte-for-byte; diff shows ONLY the 2 Sidebar deletions + BuildsSearchBar insertion below the return. Re-verify deep-link, live-follow, back/forward.
- R2: BuildsSearchBar calls the SAME handlers (handleChampionSelect/handleLaneChange/handlePlayerSelect); no new history mutation from rail/bar (plain next/link).
- R3: no horizontal scroll — mobile bar grid-cols-4, Builds lane row grid/wrap, never overflow-x. 390px every route.
- R4: /draft live-sync + entryStateRef + dirty latch untouched (only TabNav removed + CSS scope). Verify champ-select autofill + Reset-to-live.
- R5: after fixed→absolute, .dt-circuit-bg still fills draft content (not 0-height) AND not under rail. Screenshot /draft 1440.
- R6: card reflects live useCompanion, never fabricates. Smoke unpaired vs paired.
- R7: /api/patch failure → "PATCH —", never crash. Best-effort catch→null.
- R8: version bump → SW cache name; keep icon-cache exclusion.

## Staged ship (A+B together if bandwidth): A desktop rail + AppShell + BuildsSearchBar + strip TabNav + delete Sidebar + /api/patch + CSS. B MobileTabBar + delete MobileNavMenu/navLinks.

## Puppeteer acceptance
Desktop 1280+1440: (1) rail on ALL routes with CB+COACHBUILD+WPA INTELLIGENCE; (2) PLAY+DATA groups, active pill correct; (3) card bottom fed by live useCompanion (unpaired→grey "OFF/Not paired/Set up"); (4) footer PATCH n + v0.50; (5) every item navigates; (6) /draft rail GOLD no cyan bleed, draft content keeps cyan bg; (7) Builds search+lanes at top of content, CHAMPIONS/PROS toggle works, PROS→ProsSearchPrompt, lane re-fetch, back round-trips; (8) zero console errors.
Mobile 390: (9) bottom bar EXACTLY 4 (Builds/ProPlayers/PatchMovers/MyStats), NO Companion/Draft/card; (10) no full rail, no hscroll (scrollWidth<=clientWidth); (11) Builds search+lanes usable no clip; (12) /draft + /live-setup still reachable by URL (deep-link `/?championId&role&session` lands); (13) fixed bar no footer overlap (pb-16); (14) zero console errors.
