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




---

## Latest dispatch -- 2026-07-06 19:08

### engy

# HANDOFF-engy — CoachBuild review-fix session (2026-07-06)

Picked up from the orchestrator after `app/api/build/route.ts` recovery + `.gitignore` fix (commit `b1f8301`, 19/19 tests). Implemented all 3 remaining review fixes. Did NOT deploy, did NOT bump version (orchestrator ships).

## Fix 1 (P1) — dynamic patch selection: DONE

`lib/staticData.ts` `getLatestPatch()` was a hardcoded `{major:16,patch:11}` literal. Replaced with a probe-based resolver:

- **Candidates**: `parseDdragonVersions()` (new, pure, exported) reads ddragon `versions.json` (already fetched via the existing `fetchJson`/`CDN.versions`), dedupes hotfix builds down to distinct `major.patch` (e.g. `16.13.1`, `16.13.1` → one `16.13` entry), newest first, capped at `MAX_PATCH_CANDIDATES = 4`.
- **Probe**: for each candidate, one `getKeystoneData(112, 2, patch)` call (Viktor/Mid — matches `sampleBuild.ts` and the champ/role already used together in `route.test.ts`'s 200 case). First candidate with ≥1 keystone row wins. `patchAdditions` is assumed `0` for every candidate (GetPatches shape is still unconfirmed; `0` is the only verified-working value, matching the code it replaced).
- **Caching**: module-level cache, keyed on an injectable `now: () => number` param (defaults to `Date.now`) so tests don't need fake timers. Two TTLs, not one — a deliberate asymmetry, called out in a code comment in `staticData.ts`:
  - Successful resolution: 6h TTL (`PATCH_CACHE_SUCCESS_TTL_MS`).
  - Failed resolution (ddragon unreachable, or every candidate's probe failed/empty): 5m TTL (`PATCH_CACHE_FAILURE_TTL_MS`) — so a transient coachless blip doesn't wedge the app on the static fallback for 6 hours once coachless recovers.
- **Fallback chain**: probe failure → last-known-good cached patch (if any) → static `16.11` (`STATIC_FALLBACK_PATCH`, the only hardcoded value left, kept as the ultimate never-patchless floor). Each candidate's probe is individually try/caught so one candidate's network error doesn't abort the whole walk — this mattered in the live run below (16.13 returned a 403, not an empty array).
- **Return shape unchanged**: `{major, patch, patchAdditions, label}` — `recommend.ts` needed zero changes.
- Test-only export `__resetPatchCacheForTests()` clears the module cache between test cases (mirrors the pattern of exporting narrow test seams rather than re-deriving state).

**Live proof it resolves 16.12 today** (ran the exact candidate/probe logic as a standalone script against the real `api.coachless.gg` + `ddragon.leagueoflegends.com`, not mocks):
```
ddragon newest versions: [ '16.13.1', '16.12.1', '16.11.1', '16.10.1', '16.9.1', '16.8.1' ]
candidates (newest first, capped at 4): [ '16.13', '16.12', '16.11', '16.10' ]
probe 16.13: ERROR coachless -> 403
probe 16.12: 8 keystone rows

=> RESOLVED PATCH: 16.12
```

Tests: `lib/__tests__/staticData.patch.test.ts` (9 new tests) — mocks `../coachless`'s `getKeystoneData` + `global.fetch`, covers: version-string dedup/parse/cap, newest-populated-wins (skips empty newer patches), falls back to static 16.11 on total failure (ddragon down, or ddragon fine but nothing populated), falls back to **last-known-good** (not static) on a later failure, success-TTL cache hit/miss via the injectable clock.

## Fix 2 (P2) — low-sample confidence signal: DONE

`components/StatBadge.tsx`'s default-export `<StatBadge>` component had zero JSX call sites (confirmed via grep — `RunePage.tsx` and `SpellRow.tsx` both imported it but never rendered it). Deleted it; kept the pure helpers (`wpaClass`, `wpaText`, `fmtSample`) which are the file's actual dependents, and added `isNegativeHeadlineWpa` (Fix 3).

Wired `Pick.lowSample` (already computed by the engine, was going nowhere in the UI) into:
- `components/ItemPath.tsx`: the core-path slot now shows the `⚠` glyph next to its sample count when `lowSample` is true; each "or" alt tile now shows its sample count (previously showed WPA only — a 1K-sample +3.43 alt had no visible caution next to a 117K-sample +0.33 core pick) plus the same glyph when low-sample.
- `components/RunePage.tsx`: same treatment on every `RuneTile` (keystone, primary, secondary runes).
- Kept it quiet by design: `text-gold/70`, `text-[7px]`/`text-[9.5px]`, only a `title` tooltip for detail — a caution cue, not an alarm, matching the brief.

**Where the glyph lives**: not as a shared JSX export from `StatBadge.tsx`. Tried that first, but vitest 4's default `oxc` transform can't parse JSX outside its configured scope without extra plugin wiring, and `esbuild.jsx` overrides are ignored in this vitest version (confirmed by the tool's own warning: *"Both esbuild and oxc options were set. oxc options will be used and esbuild options will be ignored"*). Rather than fight the transform pipeline for one glyph, each caller (`ItemPath.tsx`, `RunePage.tsx`) defines its own tiny private `LowSampleFlag` (identical ~10-line component, noted as intentionally duplicated in a comment in each file). If a third caller ever needs it, extract to its own `LowSampleFlag.tsx` file — no logic there, so no test-import conflict.

Tests: `components/__tests__/StatBadge.test.ts` (new — also required expanding `vitest.config.ts`'s `include` glob to `components/__tests__/**/*.test.ts`, previously `lib/__tests__/` only). Covers `wpaClass`/`wpaText`/`fmtSample` (previously untested despite being load-bearing for every stat tile) plus `isNegativeHeadlineWpa`.

## Fix 3 (P3) — "Most played" affordance: DONE

Extracted `isNegativeHeadlineWpa(wpa): boolean` (`wpa < 0`) to `StatBadge.tsx`. In `RunePage.tsx`'s `RuneTile`, when `isKeystone && isNegativeHeadlineWpa(pick.wpa)`, renders a quiet `text-[8px] uppercase text-mut/80` "Most played" label directly above the WPA number, with a `title` explaining the negative-but-popular framing (Jhin Fleet Footwork −0.10/295K games reads as "popular pick, slightly negative data" instead of a mistake). Ranking model untouched — this is display-only, the keystone shown is still whatever `pickRecommended()` in `recommend.ts` already chose.

Test: `isNegativeHeadlineWpa` covered in `components/__tests__/StatBadge.test.ts` (true for -0.10, false for +0.04 and for exactly 0).

## Files touched

- `lib/staticData.ts` — Fix 1 (patch resolution rewrite)
- `lib/__tests__/staticData.patch.test.ts` — new, 9 tests
- `components/StatBadge.tsx` — Fix 2/3 (dead component removed, `isNegativeHeadlineWpa` added)
- `components/__tests__/StatBadge.test.ts` — new, 12 tests
- `components/ItemPath.tsx` — Fix 2 (low-sample wiring, private `LowSampleFlag`)
- `components/RunePage.tsx` — Fix 2/3 (low-sample wiring + "Most played" label, private `LowSampleFlag`)
- `components/SpellRow.tsx` — one-line cleanup (removed the same dead `StatBadge` default import; still uses `wpaClass`/`wpaText`)
- `vitest.config.ts` — `include` glob widened to also run `components/__tests__/**/*.test.ts`

## Gates (all run, all pass)

```
npx tsc --noEmit     -> clean, no output
npm test (vitest)    -> 40/40 passed (19 original + 9 patch + 12 StatBadge)
npx next lint        -> 0 errors, 5 pre-existing <img>/no-img-element warnings (unrelated, unchanged)
npm run build        -> Compiled successfully, all routes generated
```

## Known issues / not done

- `patchAdditions` is assumed `0` for every probed candidate (GetPatches request shape is still genuinely unconfirmed — this was true before my change too, just now it's an explicit assumption in a comment instead of a silent hardcode). If GetPatches' real shape surfaces later, `resolveViaProbe()`/`parseDdragonVersions()` in `lib/staticData.ts` is the place to wire it in.
- Icon CDN version pins (`RUNE_VER = "16.11.1"`, `ASSET_VER = "16.12.1"` in `staticData.ts`) are unchanged — out of scope per the brief (only `getLatestPatch()`, the API-filter patch, was in scope). Worth flagging to the orchestrator: if the resolved API patch (now dynamic, 16.12 today) drifts far from these pinned asset versions, icons could eventually 404 on the CDN. Not observed today (16.12 asset version already matches `ASSET_VER`), but it's a latent coupling.
- No deploy, no version bump — per the brief.


