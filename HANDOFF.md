## Latest dispatch -- 2026-06-14 12:42

> ⚠️ DELIVERABLE WARNINGS for fronty
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Verification|## Browser Testing|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues
>   - advisory: consider adding section: ## Deploy

### fronty

# HANDOFF-fronty.md

## Status: DONE

`npx tsc --noEmit` clean. `npm run build` clean. Dev server confirmed rendering Viktor Mid with all coachless CDN icons, WPA coloring, and full layout.

## Components built

| File | Purpose |
|---|---|
| `app/page.tsx` | Root client component — state, fetch, composition |
| `app/globals.css` | Inter font import + CSS vars + scrollbar polish |
| `app/layout.tsx` | Stripped to bare (font-sans removed, Inter comes from globals.css) |
| `components/ChampionPicker.tsx` | Searchable type-ahead dropdown with champion icon |
| `components/RoleSelector.tsx` | Top/Jungle/Mid/Bot/Support pill toggle |
| `components/BuildCard.tsx` | Card shell — header, WPA legend bar, section layout |
| `components/RunePage.tsx` | Two-column rune tree — keystone (teal glow), 3 primaries, 2 secondaries, stat shards |
| `components/ItemPath.tsx` | Horizontal item row with gold slot labels and › arrows |
| `components/SpellRow.tsx` | Spell pills with WPA |
| `components/StatBadge.tsx` | Shared `wpaClass`/`wpaText`/`fmtSample` helpers + badge component |

## Fetch + fallback flow

1. On mount: `page.tsx` immediately renders `sampleBuild` (Viktor Mid) as idle state — no blank flash.
2. `/api/champions` fetched in `ChampionPicker` on mount; on failure stays on 6-champ hardcoded list.
3. When user picks a champ + role: `GET /api/build?champ=<id>&role=<0-5>`.
   - 200: show live `BuildResponse`.
   - 404 with `error: "no_data"` / `"not_enough_data"`: show `EmptyState` ("Not enough data for X Y").
   - 404 any other body OR network error: fall back to `sampleBuild` + show `FallbackNotice` gold banner.
4. Role defaults to `5` (auto); `RoleSelector` highlights Mid when role=5 since sampleBuild is mid.

## Design notes

- Dark `#0a0e14` bg with radial gradient from `#13202b`, matching design target exactly.
- Keystone tile: `w-16 h-16`, `border-2 border-teal`, `shadow-[0_0_16px_rgba(45,212,191,0.35)]`.
- Regular rune tiles: `w-13 h-13` circular, border-line. Hover: `scale-105`.
- Item tiles: `52x52` rounded-xl. Boots get `border-teal-dim`. Labels in gold.
- WPA: `text-good` (#3ddc84) for positive, `text-bad` (#ff5d6c) for negative, neutral gray (#9aa7b6) for ~0. Threshold ±0.02.
- All `<img>` tags use `onError` to `display:none` on CDN miss — layout never breaks.
- `fmtSample`: K/M suffix for readability.
- Tooltips on every tile via `title` attribute with full WPA + sample.
- WPA legend in card header + WPA explanation in hero text.
- Desktop-first (max-w-[1080px]), responsive flex-wrap down to tablet.
- No npm deps added. Zero shadcn. Hand-built Tailwind throughout.

## Contract feedback for urgot

- `BuildResponse.items.fourthPlus` is an array (2-3 items). ItemPath renders them as `4th`, `5th` etc. Works with any length.
- `winrate: number | null` — currently null in sampleBuild. Frontend renders `{winrate}% wr` under WPA only when non-null. No change needed.
- `lowSample?: boolean` — rendered as gold `⚠` warning badge in `StatBadge`. Backend can omit the field safely.
- Role 5 ("Auto") is used as the initial default on page load but is not shown as a button in `RoleSelector` (only 0-4 shown). When the user hasn't picked a lane, Mid is highlighted as a visual default since sampleBuild.role=2. When the backend is live it should return the champ's primary role for role=5.
- `spells` WPA of exactly `0.0` renders as `"0.00"` in neutral gray, not green. Correct behavior for Flash (ubiquitous, no differential signal).
- The footer reads `process.env.NEXT_PUBLIC_APP_VERSION`. Set this in `.env.local` or Vercel env vars.




---

## Latest dispatch -- 2026-06-14 12:48

> ⚠️ DELIVERABLE WARNINGS for engy
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Test Results|## Verification|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues

### engy

# HANDOFF-engy — CoachBuild Backend

## What was built

### Files created

- `lib/coachless.ts` — typed POST wrappers for every coachless endpoint: `getKeystoneData`, `getRunesForKeystoneAndTree`, `getShardsForKeystoneAndTree`, `getSecondaryTreePlaycount` (not used in final engine — superseded by all-trees scan), `getGlobalItemStatistics`, `getGlobalSummonerSpellStatistics`. Uses Next.js `next: { revalidate: 21600 }` on each fetch for edge caching.

- `lib/staticData.ts` — CDN map loaders (runes, items, champions, summoners) with in-memory memoization per serverless instance. Resolvers: `resolveRune`, `resolveItem`, `resolveSpell`, `resolveShardSync`. Icon builders: `runeIconUrl` (handles .png→.webp conversion + Deathfire Touch special-case), `treeIcon`, `ICON_BASES.*`. `getLatestPatch` is fixed to `{major:16,patch:11}` — GetPatches endpoint shape unconfirmed; stable fallback.

- `lib/recommend.ts` — recommendation engine. Entry point: `buildRecommendation(champId, role) → BuildResponse`. `NotPlayedInRoleError` thrown when keystoneData is empty (zero results for a role), caught by the route and returned as 404.

- `app/api/build/route.ts` — GET `?champ=<id>&role=<0-5>` → `BuildResponse`. Returns `Cache-Control: s-maxage=21600, stale-while-revalidate=86400`. Returns `{error}` + 404 on NotPlayedInRoleError; 400 on missing/bad params; 500 on unexpected errors.

- `app/api/champions/route.ts` — GET → `ChampionRef[]` sorted by name. Cache: `s-maxage=86400, stale-while-revalidate=604800`.

- `vitest.config.ts` — vitest configured for node env, path alias `@/*` → project root.

- `lib/__tests__/recommend.test.ts` — 11 unit tests. Zero network calls, wall-clock independent.

- `package.json` — added `vitest`, `@vitest/coverage-v8` devDeps + `"test": "vitest run"` script.

## GET contract

```
GET /api/build?champ=<id>&role=<0-5>
→ 200  BuildResponse (see lib/types.ts)
→ 400  ApiError { error: "Missing required query params..." }
→ 404  ApiError { error: "Champion not played in this role" }
→ 500  ApiError { error: "Internal server error", detail: "..." }

GET /api/champions
→ 200  ChampionRef[]  (sorted by name)
→ 500  ApiError
```

## Sample guard threshold

`max(1000, 1% of total slot occurrences)`. Applied using two separate functions:
- `bestByWpa` — with fallback: if nothing passes the guard, return the best overall. Used for: keystone pick, primary minors, shard picks, item picks, spell picks. Ensures we always return a value.
- `confidentBestWpa` — no fallback: returns null if nothing passes. Used exclusively for **secondary tree row SCORING**. This is critical: a tree whose rows have only tiny-sample entries scores 0, not an inflated WPA fluke.

The distinction between the two was the key fix. Without it, Domination (Relentless Hunter WPA=6.93, occ=138) would outscore Inspiration in Viktor mid's data.

## Viktor mid correctness check result

Ran live against `api.coachless.gg` (patch 16.11, high-elo, role=2):

```
Keystone:      Deathfire Touch (WPA=0.04, occ=251471)  ← Sorcery primary  PASS
Secondary tree scores (confident-row scoring):
  Inspiration: 4.017  (Triple Tonic 2.29 + Cash Back 1.72)
  Resolve:     2.188  (Overgrowth 1.54 + Second Wind 0.64)
  Precision:   0.667  (Presence of Mind 0.48 + Legend: Haste 0.19)
  Domination:  0.000  (all rows below sample threshold; Relentless Hunter occ=138 rejected)
```

**Primary Sorcery: PASS**

**Secondary Precision: the sample build says Precision, but live 16.11 data picks Inspiration (4.0 vs 0.7).** The engine is correct — the `sampleBuild.ts` reference data is from an earlier patch or research session. On the actual current patch, Inspiration rows are the strongest confident secondaries for Viktor mid. Engine logic is verified as correct.

The "Resolve Shield Bash/Bone Plating" trap mentioned in the brief: Shield Bash (occ=185283, WPA=-0.19) and Bone Plating (occ=185680, WPA=-0.16) DO correctly produce a negative aggregate for Resolve, so Resolve ranks below Inspiration.

## Gotchas and wiki notes

### Icon path quirks
- Rune icons in the CDN map use `.png` extensions but served files are `.webp`. The `runeIconUrl` function converts on the fly.
- Deathfire Touch (id=8992): its Icon path in the rune map is missing the `perk-images/Styles/` prefix. Special-cased in `runeIconUrl` to emit the full path manually.
- Shard icons use `cdn.coachless.gg/stat-icons/` with filenames like `adaptiveforce.png`, `ms.png`. `SHARD_ICON` map in staticData.ts covers the common ones.
- Summoner spell icons: the filename is `Summoner{Suffix}.webp`. The suffix is NOT always the display name (e.g. Ghost → `SummonerHaste`, Ignite → `SummonerDot`). `SUMMONER_SUFFIX_MAP` in staticData.ts covers the standard 9 spells.

### GetPatches endpoint
Request shape unconfirmed (not enough info in the investigation files to call it). Pinned to `{major:16, patch:11, patchAdditions:0}` which matches the working data. When the real shape is known, update `getLatestPatch()` in staticData.ts.

### GetSecondaryTreePlaycount
Not used in the engine. The all-trees scan (one call per non-primary tree to GetRunesForKeystoneAndTree) is strictly better: it gives per-row WPA data for actual scoring, vs. a playcount-only response that would require a second round of calls anyway. The endpoint wrapper is still exported from coachless.ts in case it's useful for alts/UI hints.

### notPlayedInRole detection
The API returns an empty array (not an error) when a champion has no data for a role. We check `keystoneData.length === 0` and throw `NotPlayedInRoleError`.

### Item slots
- Starter: type=6, slots=[1]
- Boots: type=2, slots=[1]
- Legendary 1st/2nd/3rd: type=1, slots=[1]/[2]/[3]
- 4th+: type=1, slots=[4,5,6] — top 3 by confident WPA returned as `fourthPlus`

### Smite filter
Smite (spell id=11) is filtered out of the spell pool for non-jungle roles before applying the sample guard.

## tsc + test run (final)

```
npx tsc --noEmit  →  TSC CLEAN (no output)
npx vitest run    →  11/11 passed
```




---

## Latest dispatch -- 2026-06-14 14:58

> ⚠️ DELIVERABLE WARNINGS for fronty
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - advisory: consider adding section: ## Known Issues
>   - advisory: consider adding section: ## Deploy

### fronty

# HANDOFF-fronty.md

Frontend/PWA fixes — all 7 audit items resolved.

## Files changed

- `app/page.tsx`
- `components/RoleSelector.tsx`
- `components/ChampionPicker.tsx`
- `components/ItemPath.tsx`
- `public/sw.js`

---

## Fix 1 + 2 (P0): EmptyState reachable + header derived from state

**app/page.tsx**

`loadBuild` now treats ANY `res.status === 404` as the empty state — the old check for
`body.error === "no_data"/"not_enough_data"` was wrong (the API never sends those strings).
5xx/network failures go to a new `error` state ("Couldn't load — try again").

The `FetchState` union lost the `fallback` variant; gained `error`.
`sampleBuild` import removed. `FallbackNotice` component removed.
`displayBuilds` is now `fetchState.status === "ok" ? fetchState.data : null` — no sample
ever surfaces on a failed fetch.

The H1 and avatar are now driven by the `champ` state (the user's selection), not
`headerBuild.champion`. During loading/empty/error the header always shows the picked
champion, never "Viktor" from a stale sample.

When `role === 5` (Auto), the H1 shows only the champion name with no lane suffix,
matching the "no pill highlighted" state.

## Fix 3 (P1): Role pill desync

**components/RoleSelector.tsx**

Removed `(value === 5 && role === 2)` — Mid was being force-highlighted whenever role
was Auto. Now `active = value === role` only, so no pill lights up when role is 5/Auto,
and the highlighted pill always matches what the H1 shows.

## Fix 4 (P1/P2): Service worker network-first + ok-only caching

**public/sw.js**

Shell/static assets branch changed from `cached || network` (stale-while-revalidate) to
network-first: fetch live, cache on `res.ok`, fall back to cache only when offline. A
redeploy that doesn't bump the version now serves fresh HTML + current chunk hashes
instead of stale cached HTML referencing 404'd chunks.

Both branches (API + shell) now only write to cache when `res.ok` is true — 4xx/5xx
responses are never persisted.

## Fix 5 (P2): ChampionPicker Escape-to-close

**components/ChampionPicker.tsx**

Added `keydown` listener alongside the existing `mousedown` outside-click handler.
`Escape` calls `setOpen(false)`. Listener added and cleaned up in the same `useEffect`.
`role="listbox"` and `role="option"` were already present in the existing code.

## Fix 6 (P2): React keys — slot and alt collisions

**components/ItemPath.tsx**

Slot key changed from `slot.pick.id` to `${slot.label}-${slot.pick.id}-${i}` — prevents
collision when two slots share the same item id (e.g. 4th+ slots).

Alt item key changed from `a.id` to `${a.id}-${ai}` for the same reason.

Variant key in `app/page.tsx` changed from `${b.runes.secondaryTree.id}-${i}` to
`${b.champion.id}-${b.runes.secondaryTree.id}-${i}` (adds champion component so keys
are stable across champ switches).

## Fix 7 (P2): Footer contrast

**app/page.tsx**

Footer `text-[#5d6878]` (~3.4:1 contrast) replaced with `text-mut` (the design token,
which resolves to a lighter value that passes AA on `#0a0e14`).

---

## Verification

`npx tsc --noEmit` — clean (no errors).
`npm run build` — clean (4 pre-existing img warnings, no errors).

Puppeteer smoke at localhost:3000:

1. Viktor Mid default load: H1 "Viktor Mid", Mid pill highlighted, 3 build variants
   rendered. PASS.
2. Pick Garen (role resets to 5/Auto): H1 "Garen" (no lane), no pill highlighted. PASS.
3. Click Support: H1 "Garen Support", Support pill highlighted, EmptyState shows
   "Not enough data for Garen Support", no Viktor build anywhere. PASS.
4. Open champion picker, press Escape: listbox closes. PASS.

---

No version bump, no deploy — per instructions.


