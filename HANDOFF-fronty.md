<!-- merged into HANDOFF.md 2026-07-27 17:50:16Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 — Empty-state redesign: Builds (`/`) and Pro Players (`/history`)

Solo fronty round (no parallel engo — task was pure FE, ≤4 files/2 surfaces). User request: the two empty states wasted a full mobile screen with a big heading + prose + nothing. Redesigned both to surface real, already-available data instead. Consulted reactbits.dev's showcase first per standing directive — nothing fit (it's hero/background decorative material; this is a dense functional data surface), skipped per the "if nothing fits, move on" guardrail.

### Builds (`/`) — `components/hextech/ChampionPickPrompt.tsx` (rewritten in place, same export/import site so `app/page.tsx`'s diff stays small)

Cut the two explanatory paragraphs to a one-line heading (prose only reappears if literally nothing else loaded). Below it, three real sections, each independently hidden when its source is empty/unavailable — never a fake placeholder:

- **Your Lanes** — `GET /api/mystats/summary` (no role/championId filter), decorated via `buildMyStatsRows`/`myStatsRoleLabel` imported straight from engo's `components/hextech/myStats.ts` (read-only reuse, did not touch that file). One pill per lane showing the account's top champion + win rate in that lane; lanes with no data render muted/non-interactive rather than disappearing (keeps the 5-lane grid visually stable). Verified live against this user's real 82-game account: TOP 67%, JG 0%, MID 60%, BOT 100%, SUP 43%.
- **Recently Viewed** — new `lib/recentChampions.ts` (small localStorage list, deduped by champion, cap 6, newest-first). Separate key/shape from `lib/lastChampion.ts` on purpose — that one remembers exactly one champion for mount-restore; this keeps a short list for the empty state. Written from `app/page.tsx`'s existing persist effect (same `shouldPersistLastChampion` guard, one extra call). **Verified at the data layer** (clicking a quick-pick correctly wrote `[{championId:50,lane:"top"}]` to `coachbuild:recentChampions:v1`) but I could not get a clean screenshot of the populated chip row — every attempt to force a genuinely-empty-but-has-recents state ran into `useSheetBackNav`'s `window.history.state` correctly resuming a real prior pick in the same tab (that's pre-existing, correct behavior I didn't touch, not a bug — see the trace in this round's transcript if it matters later). The rendering itself is the identical `IconWithFallback` + button chip pattern already screenshot-verified working in the other two sections, so I'm confident in it without forcing that exact screenshot.
- **Trending This Patch** — `GET /api/patch-movers` (already computed for `/movers`, not recomputed), top 4, colored delta consistent with `MoverRow.tsx`'s own good/bad convention. Links to `/movers` for the rest.

All three tap targets call one new handler, `handleQuickPick(championId, lane)` in `app/page.tsx` — resolves the id against `/api/champions` (same fetch the existing deep-link effect already uses) and lands directly on the known lane, skipping the async most-played-lane lookup `handleChampionSelect` needs for a blind search pick (not needed here — every section already knows the lane).

### Pro Players (`/history`) — new `components/ProPlayersSpotlight.tsx`, replaces the inline `PromptState()` in `app/history/page.tsx`

Player mode: spotlights the most-recently-starred favorite (`lib/favorites.ts`, unchanged) with `ProHistoryResults` embedded directly (`limit=4`, no `historySheet` props so each card manages its own open state locally — confirmed that's a supported standalone mode by reading `ProGameCard.tsx`). Zero favorites falls back to resolving one well-known pro (`Faker` → `Chovy` → `Caps` → `Ruler`, in order) via the real typeahead (`GET /api/players?q=`), labeled "Popular" instead of "Favorite" so it's honest about why it's showing. All real numbers — the fallback only picks WHO to show, never fabricates what's shown. Champion mode does the same off `getFavoriteChampions()`; with no favorite champions it falls straight to the honest short prompt (no synthetic "notable champion" list — no real signal for that, so it doesn't guess).

**Bug caught and fixed before shipping:** the notable-pro fallback effect originally gated re-entry on `fallback.status !== "idle"`, with `fallback.status` also in its own dependency array — so the moment it called `setFallback({status:"loading"})`, the resulting re-render fired the effect's cleanup, which flipped the in-flight fetch's `cancelled` flag to `true` before the (already-resolved, ~1ms) response could report back. Result: the UI sat in the loading skeleton forever even though the request had already succeeded — confirmed via `performance.getEntriesByType('resource')` showing the request completed while the component stayed stuck. Fixed by moving the "already started" guard to a `useRef` instead of state, and dropping `fallback.status` from the effect's deps. Both modes screenshot-verified working after the fix (real Faker games in the fallback case, real Viktor games in the favorite case).

**Unrelated finding, not fixed (out of scope, not touched by this round):** the local dev environment had a stale `.next/cache` build cache serving `NEXT_PUBLIC_APP_VERSION="0.65.2"` in some client chunks against a `0.68.4` SSR render, throwing a real React hydration-mismatch toast (`DesktopRail`'s version footer). This reproduced even after clearing the service worker, all caches, and localStorage, and only went away after `rm -rf .next` + a full dev-server restart — confirming it was disk-cache staleness from a prior local session, unrelated to any file this round touched (`AppShell`/`DesktopRail`/`next.config.mjs` are untouched). Flagging in case a future dev-server session on this machine shows the same version-mismatch toast — the fix is `rm -rf .next` + restart, not a code change.

### Gates (from `C:/Claude/AI/coachbuild`, all green)
- `npx tsc --noEmit` — clean
- `npx vitest run` — **1919 passed, 0 failing** (baseline 1915+)
- `npm run lint` — clean (only pre-existing `<img>`/`next/image` warnings, none in new files)
- Live-verified via `npx next dev` + puppeteer at 390×844/950/1000: both empty states render real data, no horizontal scroll at any width (`scrollWidth === clientWidth` confirmed), tap targets confirmed via `elementFromPoint` hit-testing AND a real click-through (Builds → Swain/Top landed correctly on the real build page with runes/items).
- Did NOT bump version, commit, or deploy, per the brief.

### Files touched
- `components/hextech/ChampionPickPrompt.tsx` — rewritten (Builds empty state)
- `components/ProPlayersSpotlight.tsx` — new (Pro Players empty state)
- `app/page.tsx` — added `handleQuickPick`, recent-champion persist call, prop wiring
- `app/history/page.tsx` — swapped inline `PromptState` for `ProPlayersSpotlight`
- `lib/recentChampions.ts` — new, small localStorage helper

Read-only reuse (not edited): `components/hextech/myStats.ts` (`fetchMyStatsSummary`, `buildMyStatsRows`, `myStatsRoleLabel`), `components/hextech/MoverRow.tsx` (`Mover` type import), `lib/favorites.ts`, `components/ProHistoryResults.tsx`, `components/ProGamesSkeleton.tsx`.
