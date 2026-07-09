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




---

## Latest dispatch -- 2026-07-06 20:03

### engy

# HANDOFF-engy — CoachBuild review-fix session (2026-07-06, follow-up)

Continuation of the same-day P1/P2/P3 review-fix pass (v0.4.0 already deployed with dynamic patch selection + low-sample caution + "Most played" label). This round closes the reviewer's remaining P3s: icon-version drift, probe robustness, and a threshold mismatch. Did NOT deploy, did NOT bump version — orchestrator ships as 0.4.1.

## 1. Icon CDN versions now derive from the resolved patch — DONE

**Evidence gathered before writing any code** (curled directly against `api.coachless.gg`'s CDN, not assumed):

```
rune icon  under 16.11.1  -> 200
rune icon  under 16.12.1  -> 200
rune icon  under 16.13.1  -> 200
champ icon under 16.11.1  -> 200
champ icon under 16.12.1  -> 200
champ icon under 16.13.1  -> 200
item icon  under 16.11.1  -> 200
item icon  under 16.12.1  -> 200
champion.json under 16.12.1 -> 200
summoner.json under 16.12.1 -> 200
```

**Conclusion**: coachless's `static-files` CDN mirrors ddragon's own per-patch asset bundle (icons + data JSON) and is published on every patch immediately — it is NOT gated behind WPA-data availability the way `api.coachless.gg`'s stats endpoints are (16.13's `GetKeystoneData` still 403s; 16.13's icons already exist). So there was no evidence for the "keep RUNE one notch behind ASSET" branch in the brief — both icon families are safe to derive from the SAME resolved data patch, formatted `<major>.<patch>.1`. The old `RUNE_VER="16.11.1"` / `ASSET_VER="16.12.1"` split in `lib/staticData.ts` was an artifact of when each happened to be manually spot-checked during the original investigation, not a real technical constraint.

**Implementation** (`lib/staticData.ts`):
- `RUNE_VER`/`ASSET_VER` constants deleted. `ICON_BASES.rune/item/spell/champ` now take a `ver: string` parameter instead of closing over a hardcoded constant; `runeIconUrl()` gained a third `ver` param.
- New `versionFolder(patch: ResolvedPatch): string` (pure, exported) formats `{major:16,patch:12}` → `"16.12.1"`.
- New `getIconVersion(): Promise<string>` calls the existing `getLatestPatch()` (Fix 1 from earlier this session) and formats the result — **no new network call or cache layer**, it rides on `getLatestPatch()`'s own TTL/single-flight/fallback chain. Wrapped in try/catch falling back to `ICON_VERSION_FALLBACK = "16.11.1"` as pure defense-in-depth (`getLatestPatch()` itself never throws — it has its own static floor — so this catch is realistically unreachable, but it's the "icon URL can never be undefined" guarantee the brief asked for).
- `loadChampsData`/`loadSummonersData` (which build versioned `champion.json`/`summoner.json` URLs) and every resolver that builds an icon URL (`resolveRune`, `resolveItem`, `resolveSpell`, `getAllChampions`, `getChampionById`) now `await getIconVersion()` alongside their existing data fetch (`Promise.all`'d where both are needed, so no added latency vs. before).
- `tree`/`shard` icon bases are NOT versioned (confirmed: those CDN paths have no per-patch folder in them at all) — left untouched.
- The existing `onError → display:none` fallback in every `<img>` (`ItemPath.tsx`, `RunePage.tsx`, `SpellRow.tsx`, `ChampionPicker.tsx`, `app/page.tsx`) is unchanged and still the last-resort guard if a specific icon file is ever missing from a given patch folder.

Tests (extended `lib/__tests__/staticData.patch.test.ts`): `versionFolder` unit test; `resolveItem`/`resolveRune` integration tests (mocked coachless probe + CDN fetches) asserting the built icon URL contains today's resolved patch folder (`16.12.1`) — the rune-icon assertion is the literal curl-verified URL shape; a fallback test confirms the icon URL drops to `16.11.1` when patch resolution itself falls back to the static default.

## 2. Probe robustness — DONE

**(a) Per-probe timeout.** `lib/coachless.ts`'s `post()` and `getKeystoneData()` gained an optional trailing `signal?: AbortSignal` param (backward compatible — `recommend.ts`'s existing calls are unaffected). `lib/staticData.ts`'s `candidateHasData()` now passes `AbortSignal.timeout(PROBE_TIMEOUT_MS)` (4000ms) on every candidate probe. A timed-out/aborted probe throws, which the existing try/catch already treats as "this candidate has no confirmed data, try the next one" — same code path as a 403 or network error, no new branching needed.

**(b) Single-flight guard.** New module-level `inFlight: Promise<ResolvedPatch> | null`. In `getLatestPatch()`: on a cache miss, if a resolution is already in progress, concurrent callers `await` that SAME promise instead of each independently re-fetching ddragon + re-walking probes. Cleared in a `finally` block so the NEXT cache-miss (after TTL expiry) starts a genuinely fresh walk rather than being stuck replaying a finished promise. `__resetPatchCacheForTests()` now also resets `inFlight` for test isolation.

Tests: one asserts `getKeystoneData` was called with an `AbortSignal` instance on every probe call (proves the wiring without waiting out a real 4s timeout in the suite); one simulates an aborted probe (`DOMException("...", "AbortError")`) on the newest candidate and confirms the walk still lands on the next populated one; two single-flight tests — 3 concurrent `getLatestPatch()` calls on a cold cache produce exactly 1 ddragon fetch + 1 probe walk (not 3), and a later cache-miss (past TTL) still triggers a genuinely fresh walk rather than reusing the finished in-flight promise.

## 3. "Most played" vs. neutral-gray WPA — ALIGNED (my call, documented)

Reviewer's note: `isNegativeHeadlineWpa` fired on any `wpa < 0`, but `wpaClass` only reddens below `-0.02` — so a headline keystone at e.g. `-0.01` WPA showed "Most played" next to a *neutral gray* number, which reads as "explaining nothing" rather than "explaining the red."

**Decision: aligned the threshold** (`components/StatBadge.tsx`) — `isNegativeHeadlineWpa` now returns `wpa < -0.02`, exactly matching `wpaClass`'s own red cutoff. Rationale documented in a comment on the function: the label's entire purpose is to explain a red number, so it should only ever appear next to one. Ranking logic (`recommend.ts`) is completely untouched — this is a display-only threshold change on an already-display-only label.

Test (`components/__tests__/StatBadge.test.ts`, extended): boundary cases at `-0.01` (false, was true before this fix), exactly `-0.02` (false — matches `wpaClass`'s own boundary), `-0.021` (true), plus a parametrized check across 9 sampled WPA values asserting `isNegativeHeadlineWpa(wpa) === (wpaClass(wpa) === "text-bad")` for every one — this is the test that would catch the two functions drifting apart again in the future.

## Files touched (this round)

- `lib/staticData.ts` — icon version derivation (`versionFolder`, `getIconVersion`, `ICON_BASES` reshaped to take `ver`), probe timeout, single-flight guard, dead `resolvedPatch` var removed (was unused even before this session)
- `lib/coachless.ts` — optional `signal` param threaded through `post()`/`getKeystoneData()`
- `components/StatBadge.tsx` — `isNegativeHeadlineWpa` threshold aligned to `-0.02`
- `lib/__tests__/staticData.patch.test.ts` — extended: +12 tests (icon version x3, probe timeout x2, single-flight x2, plus the shared fixture/helper additions those needed)
- `components/__tests__/StatBadge.test.ts` — extended: +5 tests (boundary alignment + parametrized cross-check)

## Gates (all run, all pass)

```
npx tsc --noEmit     -> clean, no output
npm test (vitest)    -> 52/52 passed (was 40 before this round; +12 new)
npm run build        -> Compiled successfully (lint runs as part of build: 0 errors,
                         5 pre-existing <img>/no-img-element warnings, unrelated/unchanged)
```

**Live re-verification** (ran the standalone probe script against the real `api.coachless.gg` + `ddragon.leagueoflegends.com` again, same result as the earlier round today):
```
candidates: [ '16.13', '16.12', '16.11', '16.10' ]
probe 16.13: ERROR coachless -> 403
probe 16.12: 8 keystone rows
=> RESOLVED PATCH: 16.12
```
With this round's change, `resolveItem`/`resolveRune`/`getAllChampions`/etc. will now build their icon URLs against `16.12.1` too (previously `16.11.1`/`16.12.1` split, hardcoded).

## Known issues / not done

- `getIconVersion()`'s catch-and-fallback branch is untested by DIRECT unit test (only indirectly, via the "patch resolution itself fell back to static" integration test) — `getLatestPatch()` genuinely never throws today, so there's no way to hit that branch without mocking `getLatestPatch` itself, which would require restructuring the module for DI. Left as documented dead-code-shaped defense-in-depth rather than manufacturing an artificial test for it.
- `PROBE_TIMEOUT_MS = 4000` is a judgment call, not measured against coachless's real p99 latency — if cold-probe false-negatives show up in prod logs (a slow-but-real 16.13 probe getting timed out and skipped in favor of 16.12), this is the first knob to check.
- No deploy, no version bump — per the brief.




---

## Latest dispatch -- 2026-07-09 18:40

> ⚠️ DELIVERABLE WARNINGS for fronty
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Verification|## Browser Testing|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues
>   - advisory: consider adding section: ## Deploy

### fronty

# HANDOFF — fronty (Pro Games UI, Phase 1)

## Files added (all `components/**`, scope-clean vs engy's `lib/pro/**`, `app/api/**`, `migrations/**`, `scripts/**`)

- `components/proGames.types.ts` — local `ProGame`/`ProGamesApiResponse` types, mirroring the `/api/pros` contract exactly. Deliberately NOT imported from `lib/types.ts` (kept local per dispatch brief, since backend contract was still in flight).
- `components/proAssets.ts` — icon URL helpers for the section. Mostly pure functions (item/spell/tree/shard icons are id+version only, no fetch). The one async piece is `resolveRuneDisplay(id, ver)`, which lazily fetches coachless's rune-translations JSON (module-level cache, one fetch shared by every card on the page) to get a keystone/primary/secondary perk's name + icon path — mirrors `lib/staticData.ts`'s pattern but is a standalone copy, not an import (per brief: don't couple to the file engy might also touch).
- `components/proGames.fixtures.ts` — 3 realistic fixtures (`FIXTURE_GAME_WIN`, `FIXTURE_GAME_LOSS`, `FIXTURE_GAME_EVENTFUL`) for dev verification. All item/rune/shard ids in these were spot-checked against the live coachless CDN (see "CDN gotcha" below) so the fixtures render clean.
- `components/ProGameCard.tsx` — single game card: header (player/team/region/patch/relative-time/win-loss pill/KDA/game length), runes+spells row (keystone prominent, primary tree + minor primary runes, secondary tree + minor secondary runes, shards, 2 summoner spells), items row (final items + trinket), and an expandable detail panel (chevron button, `aria-expanded`/`aria-controls`) with a purchase-order timeline (horizontally scrollable, minute-stamped, "Hide consumables" checkbox toggle) and a skill-order strip (R highlighted teal).
- `components/ProGamesSection.tsx` — fetches `/api/pros?championId&role&limit=20` client-side on `[championId, role]` change (abort-safe via a `cancelled` flag), renders loading skeleton / quiet error / friendly empty state / 2-col grid of `ProGameCard`.

## Integration point

`app/page.tsx`:
- Added import for `ProGamesSection`.
- Inside the `fetchState.status === "ok"` branch, after the `displayBuilds.map(...)` block, renders:
  ```tsx
  {champ && (
    <ProGamesSection
      championId={champ.id}
      championName={champ.name}
      role={displayBuilds[0].role}
    />
  )}
  ```
  Uses `displayBuilds[0].role` (always 0-4, resolved) rather than the page's own `role` state, because that state can be `5` ("auto") and `/api/pros` only accepts 0-4 per the contract. This also naturally satisfies "only visible when a champion+role result is shown" — it's nested inside the same conditional as the build cards.

## CDN gotcha found while verifying (not a bug in this code — pre-existing coachless CDN gap)

While visually verifying with fixture data via puppeteer, found that **some coachless CDN assets 403 regardless of patch version**:
- Rune icon for keystone id `8230` (Phase Rush / "Stormraider's Surge") — 403 on `16.11.1`, `16.12.1`, AND `16.13.1`.
- Stat shard icon `magicresist.png` (shard id `5003`, Magic Resist) — 403.

Both are asset-URL-construction-correct (verified the JSON map entries exist and my code derives the exact path `lib/staticData.ts`'s own pattern would produce) — the assets themselves are just missing/blocked on coachless's CDN. Swapped those two ids out of the fixtures to avoid a blank-icon false alarm in the demo. **This is a pre-existing gap that also affects the main build-recommendation UI** (`RunePage.tsx`/`BuildCard.tsx` use the identical `SHARD_ICON` map from `lib/staticData.ts` — any live build whose defense shard resolves to Magic Resist, or whose keystone is Phase Rush, will show the same blank circle). Flagging for awareness, not fixing — out of scope (`lib/staticData.ts` wasn't mine to touch) and the existing `ImgWithFallback` pattern already degrades gracefully (blank circle, no broken-image icon, no crash).

## Verification performed

- `npm run typecheck` — clean (before engy's parallel `lib/pro/**` landed; see below).
- `npm run build` — clean, only pre-existing `<img>` lint warnings (same pattern as every other component in the repo, no new ones from my files).
- `npm test` — 52/52 passing, no regressions.
- Browser-verified via puppeteer/chrome-devtools MCP at 1200px width: temporarily wired `ProGamesSection` to fall back to the fixtures on fetch failure (since `/api/pros` doesn't exist yet), screenshotted full page + expanded-timeline state, checked console for errors/hydration warnings (none), then **reverted the fixture fallback** before finishing — production code always hits the real `/api/pros` route, no dev-only branching left in.
- No dev server left running (killed the process explicitly after verification).

## Known gap at handoff time

`npm run typecheck` / `npm run build` currently fail — but the failure is 100% in engy's in-flight `lib/pro/db.ts` (`Cannot find module '@neondatabase/serverless'`), confirmed via `git status`: only `lib/pro/**`, `app/api/ingest/**`, `migrations/**`, `scripts/**` are implicated (all his scope, all untracked/in-progress). My files (`components/Pro*`, `proAssets.ts`, `proGames.types.ts`, `proGames.fixtures.ts`, and the `app/page.tsx` diff) typechecked and built clean on their own before his commit landed mid-session. Nothing for me to fix here — `package.json` (where the missing dep would get added) is explicitly out of my scope. Re-run `verify-fix.sh` once engy's `npm install` for `@neondatabase/serverless` lands.

## Nothing else touched

Did not touch `lib/pro/**`, `app/api/**`, `migrations/**`, `scripts/**`, `lib/types.ts`, or `package.json`, per scope.




---

## Latest dispatch -- 2026-07-09 18:47

> ⚠️ DELIVERABLE WARNINGS for engy
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Test Results|## Verification|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues

### engy

# HANDOFF — engy (Pro Soloq Match History backend, Phase 1)

## Summary

Built the full backend for pro-player soloQ match history: lolpros.gg roster resolver + PUUID fallback chain, Riot match/timeline ingest with a shared rate-pacer, Neon Postgres schema (`coachbuild` schema, migration applied to the live DB), and the `GET /api/pros` read API exactly per contract (one deviation, see below — reconciled, not left open). Everything degrades gracefully with no `RIOT_API_KEY` / no `DATABASE_URL`, matching the brief.

## Files touched (all new, per scope)

- `lib/pro/types.ts` — `ProGame`/`ProsResponse` contract types + lolpros/Riot raw shapes + DB row shapes.
- `lib/pro/errors.ts` — `RiotUnavailableError`, `DbUnavailableError`.
- `lib/pro/regionMap.ts` — lolpros server string -> Riot platform/regional routing.
- `lib/pro/roleMap.ts` — `teamPosition` -> role (0-4) and lolpros `position` -> role (0-4).
- `lib/pro/pacer.ts` — process-wide serialized queue for every Riot call (1.3s min gap, ~46 req/min, safely under both 20/s and 100/2min).
- `lib/pro/lolpros.ts` — ladder + profile client (see "Live-verified facts" below — the real shapes differ from the brief's assumption).
- `lib/pro/riot.ts` — account-v1, match-v5 ids/detail/timeline, all paced.
- `lib/pro/puuidResolve.ts` — the 3-tier resolution chain (lolpros puuid probe -> by-riot-id fallback -> unresolved).
- `lib/pro/db.ts` — memoized `neon()` client (HTTP driver, works in serverless + plain Node scripts).
- `lib/pro/extract.ts` — match+timeline -> stored row (patch parsing, undo-adjusted purchase order, skill-order dedupe, rune extraction, role mapping).
- `lib/pro/auth.ts` — `Authorization: Bearer <CRON_SECRET>` guard.
- `lib/pro/ingestRoster.ts`, `lib/pro/ingestMatches.ts` — shared core logic used by both the scripts and the routes.
- `migrations/0001_init.sql` + `scripts/db-migrate.mjs` — schema + idempotent runner (tracks applied files in `coachbuild._migrations`).
- `scripts/_env.mjs`, `scripts/ingest-roster.mjs`, `scripts/ingest-matches.mjs` — local runners (run via `npx tsx`, imports the TS core directly).
- `app/api/ingest/roster/route.ts`, `app/api/ingest/matches/route.ts` — guarded (401 without bearer token), chunked match ingest (`?cursor=&batch=`).
- `app/api/pros/route.ts` — THE CONTRACT endpoint.
- `vercel.json` — daily cron on `/api/ingest/matches` (Hobby-plan max frequency; finer cadence needs an external pinger looping the cursor, documented in the route file).
- `package.json` — added `@neondatabase/serverless` (dep), `tsx` (devDep), `db:migrate`/`ingest:roster`/`ingest:matches` scripts.
- `.env.local` (gitignored, verified via `git status` — not tracked) — `DATABASE_URL` copied from matchday; `RIOT_API_KEY`/`CRON_SECRET` left commented, not set (none available this session).
- Tests: `lib/__tests__/pro-extract.test.ts`, `pro-maps.test.ts`, `pro-puuidResolve.test.ts`, `pro-pros-route.test.ts`.

## Live-verified facts (probed before building — don't trust the brief blindly)

1. **lolpros `/es/profiles/{slug}` shape is NOT `{ accounts: [...] }` at the top level** as the brief's endpoint description implied. Real shape: `{ uuid, name, slug, country, league_player: { position, accounts: [...] } }`. `lib/pro/lolpros.ts` is written against the real shape (confirmed live 2026-07-09).
2. **`/es/ladder?page=N` empirically only returns EUW accounts** — probed pages 1 through 300 (ladder ends ~page 300, 20/page), every entry's `account.server === "EUW"`. No working region filter param was found (`?server=`, `?region=` both silently ignored, `?server=KR` alone 404s). This is a real limitation of the public ladder endpoint, not a bug in the client — documented in `lib/pro/lolpros.ts`'s file header. Non-EUW pros ARE still reachable once you have a slug (e.g. via a profile's `accounts[]`, which can span regions/smurfs), so the region-routing code is still fully exercised and correct — it's specifically the *discovery* step (ladder paging) that's EUW-skewed today. If broader region coverage is wanted later, it needs either a different lolpros endpoint or a seed list of known non-EUW pro slugs.
3. Ladder entries carry gamename/tagline directly (`account.gamename`, `account.tagline`) in addition to `summoner_name` — used those directly instead of string-splitting `"Name#Tag"` where available (more reliable).

## Contract deviation (found + reconciled, not left open)

**`purchaseOrder[].ts` unit.** The original brief spec'd `{ itemId: number, ts: number }[]` with no unit. I initially assumed milliseconds (Riot's raw timeline timestamp). Cross-checking fronty's already-integrated UI (`components/ProGameCard.tsx`'s `formatMinuteStamp(sec: number)` + `components/proGames.fixtures.ts`'s second-scale values like `65`, `420`, `1850`) showed fronty built against **seconds**. Changed `lib/pro/extract.ts::buildPurchaseOrder` to emit `Math.round(timestamp / 1000)` (seconds into the game) instead of raw ms, and updated the type doc comment in `lib/pro/types.ts`. No fronty changes needed — their side was already correct, mine was the one that would've broken on integration. Flagging here so urgot/fronty don't need to re-derive this — nothing further to do.

## Migration status — APPLIED to the live DB

```
$ node scripts/db-migrate.mjs
apply 0001_init.sql ...
done  0001_init.sql
```
Schema `coachbuild` created with `pros`, `pro_accounts`, `pro_matches`, `_migrations` tables + indexes (see `migrations/0001_init.sql`). Verified via a live query — only `coachbuild.*` was touched, `public` schema untouched.

**Also live-smoke-tested the roster pipeline end-to-end** (real lolpros API + real DB, no Riot key):
```
$ npx tsx scripts/ingest-roster.mjs 3
{ "pagesFetched": 1, "prosSeen": 3, "prosUpserted": 3, "accountsUpserted": 0, "accountsUnresolved": 10, "errors": [] }
```
Confirmed via direct query: 3 real pros (NattyNatt/jungle, Kaori/adc, BROHAN/mid) + 13 accounts stored correctly, all `active=false` (no key to validate against) — exactly the documented no-key degrade path. **This is real seed data sitting in the live `coachbuild` schema right now** — harmless (matches the feature's own purpose), not cleaned up.

`ingest-matches` was smoke-tested for its error path only (no `RIOT_API_KEY` available this session): confirmed `RiotUnavailableError` surfaces as a clean one-line message from the script and would map to a 503 from `/api/ingest/matches` (verified via the route logic + a direct dev-server curl, see below). **The full match-detail/timeline extraction path (extract.ts) is covered by unit tests with realistic fixtures, but has NOT been exercised against a real Riot match payload** — no key was available. First real run needs a `RIOT_API_KEY` in `.env.local`; recommend running `npx tsx scripts/ingest-matches.mjs 2 5` (small batch) first and checking `errors: []` before a full backfill.

## Test / build status

```
npx tsc --noEmit        -> clean, no output
npx vitest run           -> 8 files, 88 tests passed (was 52 before this session; +36 new, 0 regressions
                             in fronty's or the original build/route/staticData suites)
npx next lint            -> 0 errors, 6 pre-existing <img> warnings (fronty's/original components, untouched)
npx next build            -> Compiled successfully; 3 new routes present:
                             /api/ingest/matches, /api/ingest/roster, /api/pros (all ƒ dynamic, 0B)
```

**Live dev-server smoke test** (`next start -p 3911`, killed cleanly after):
```
GET /api/pros?championId=112&role=2          -> 200 {"games":[]}   (real DB, no matches ingested yet)
GET /api/pros                                 -> 400 missing params
GET /api/ingest/roster (no auth header)       -> 401 Unauthorized
GET /api/ingest/matches (no auth header)      -> 401 Unauthorized
GET /api/build?champ=112&role=2 (regression)  -> 200, unchanged, still works
```

## Known gaps / not done

- No `CRON_SECRET` set — the cron endpoint and manual pings will 401 until urgot/user sets one in Vercel env + `.env.local`.
- No `RIOT_API_KEY` this session — match ingest is unit-tested but not live-exercised. First live run should be a small batch (see above) before a full backfill, since the timeline event field names (`beforeId`/`afterId`/`levelUpType`) are transcribed from the brief, not independently re-verified against a live payload the way the lolpros shapes were.
- lolpros ladder discovery is EUW-skewed (see "Live-verified facts" #2) — fine for Phase 1 personal use, worth knowing if "100 pros" was expected to mean global coverage.
- `next lint`/`tsc` were run standalone; did not re-run `verify-fix.sh` (project-specific wrapper) — didn't see it in this repo's `scripts/`, may be an urgot-orchestrator-level script rather than per-project. Ran the equivalent commands individually instead.




---

## Latest dispatch -- 2026-07-09 19:28

> ⚠️ DELIVERABLE WARNINGS for engy
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Test Results|## Verification|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues

### engy

<!-- merged into HANDOFF.md 2026-07-09 17:47:45Z; previous content preserved there. Append new rounds below. -->

## 2026-07-09 — Pro History backend (player search + proId lookup)

Shipped the backend half for the "Pro History" tab (fronty owns UI against these contracts).

**New: `GET /api/players?q=`** (`app/api/players/route.ts`)
- Typeahead over `coachbuild.pros` LEFT JOIN `coachbuild.pro_matches` (grouped, `COUNT(pm.match_id)::int` so 0-game pros still return — cast to `::int` avoids the Neon driver's bigint-as-string coercion for COUNT).
- `q`: required, trimmed to 1-40 chars, else 400. `%`/`_`/`\` escaped via `escapeLikePattern()` before wrapping in `%…%` — Postgres's default LIKE/ILIKE escape char is already backslash so no explicit `ESCAPE` clause needed.
- Order gameCount DESC, name ASC, LIMIT 10. Same DB-absent/500-no-leak/cache-header conventions as `/api/pros`.
- Added `Player` / `PlayersResponse` to `lib/pro/types.ts`.

**Extended: `GET /api/pros`** (`app/api/pros/route.ts`)
- Now accepts `proId` (lolpros uuid) as an alternative to `championId` — exactly one required (400 on both/neither). `proId` validated against a standard UUID regex (`UUID_RE`), 400 if malformed.
- `role` is REQUIRED with `championId` (unchanged) but OPTIONAL with `proId` — absent defaults to the existing `role=5` "all lanes" sentinel, so the two branches share one role-parsing block.
- Two near-duplicate tagged-template queries (`WHERE pm.pro_id = …` vs `WHERE pm.champion_id = …`) instead of one dynamically-composed query — kept per the neon tagged-template pattern already in use in this file (the `@neondatabase/serverless` HTTP client's `sql` export doesn't support safely composing partial WHERE fragments into one template without dropping to `sql.query(text, params)`, which would've broken the existing tagged-template mock convention in the test file). If a third filter dimension gets added later, worth revisiting with `sql.query()` + a query-builder to kill the duplication.
- `ProGame[]` response shape is byte-identical for both paths — no contract change there.

**Tests:** extended `lib/__tests__/pro-pros-route.test.ts` with a `proId matrix` describe block (both/neither 400, malformed-uuid 400, proId happy path incl. asserting the SQL template text contains `pm.pro_id` not `pm.champion_id =`, proId+role filter asserts `2` is among the bound values, invalid role+proId 400). New `lib/__tests__/pro-players-route.test.ts` covers q validation (missing/empty/whitespace/41-char/40-char-boundary), the `%`/`_` escape (asserts the bound pattern is `%100\%\_win%`), Player shape mapping, empty-result, gameCount-0-not-filtered, no-DB fallback, 500-no-leak.

**Gates:** `tsc --noEmit` clean, `vitest run` 106/106 (16 new), `next lint` clean (only pre-existing `<img>`→`next/image` warnings, none in touched files), `next build` clean — both routes listed as `ƒ` dynamic.

**No contract deviations** from the brief. Files touched: `app/api/players/route.ts` (new), `app/api/pros/route.ts`, `lib/pro/types.ts`, `lib/__tests__/pro-pros-route.test.ts`, `lib/__tests__/pro-players-route.test.ts`. Did not touch `components/**`, `app/page.tsx`, `app/history/**`, `package.json`, `app/globals.css` per scope.





---

## Latest dispatch -- 2026-07-09 19:36

> ⚠️ DELIVERABLE WARNINGS for fronty
>   - missing required section: ## Summary (aliases: ## Summary|## Overview|## What Was Done)
>   - missing required section: ## Files Touched (aliases: ## Files Touched|## Files Changed|## Modified Files|## Changed Files)
>   - missing required section: ## Tests (aliases: ## Tests|## Testing|## Verification|## Browser Testing|## Skipped Tests)
>   - advisory: consider adding section: ## Known Issues
>   - advisory: consider adding section: ## Deploy

### fronty

<!-- merged into HANDOFF.md 2026-07-09 17:40:17Z; previous content preserved there. Append new rounds below. -->

## 2026-07-09 — Pro History tab (frontend half)

Built `/history` — search-then-reveal pro match history by player or champion. Backend half (`/api/players`, `/api/pros?proId=`) was in-flight with engy in parallel; built entirely against the contract in the dispatch brief, verified in-browser with temporary fixture wiring (reverted before finishing — `grep -rn "TEMP-DEV-FIXTURE-WIRING"` returns clean).

**New files (my scope only, no overlap with engy's `app/api/**`/`lib/**`):**
- `app/history/page.tsx` — new route, client component (no `metadata` export needed — mirrors `app/page.tsx`'s existing pattern of relying on root layout metadata).
- `components/proHistory.types.ts` — local `PlayerRef`/`PlayersApiResponse` mirroring `/api/players`, same "don't import the in-flight backend contract" discipline as `proGames.types.ts`.
- `components/proHistory.fixtures.ts` — dev fixtures, unwired (same pattern as `proGames.fixtures.ts` — not imported by any shipped component).
- `components/PlayerPicker.tsx` — debounced (250ms, 2-char floor) ARIA combobox typeahead against `/api/players?q=`. Race-guards stale responses via a bumped request-id ref. gameCount-0 entries render greyed but stay selectable per spec.
- `components/SegmentedControl.tsx` — generic 2-option pill toggle (Player|Champion), reusable.
- `components/LanePillRow.tsx` — 6-pill lane filter (All/Top/Jungle/Mid/Bot/Support) for Champion mode; `RoleSelector` couldn't be reused as-is since it has no "All"(=5) option.
- `components/TabNav.tsx` — Builds|Pro History nav, `aria-current="page"` on active tab, `usePathname()`-driven.
- `components/ProGamesSkeleton.tsx` — extracted from `ProGamesSection.tsx` (was inline) so `ProHistoryResults.tsx` can reuse the same skeleton without duplicating it.
- `components/ProHistoryResults.tsx` — fetches `/api/pros?proId=` (player mode) or `?championId=&role=` (champion mode); player mode resolves per-game champion icons via `proAssets.getChampionIconMap()` since games can span multiple champions.

**Edited (minimal, in-scope):**
- `app/page.tsx` — nav-only: added `<TabNav />` inside the existing header, no restructuring.
- `components/ProGameCard.tsx` — added optional `championIcon?: string` prop; header row now always shows champion identity (icon badge + `game.championName` text) in both champion-filtered (home page) and player-mode (new /history) views. Icon degrades to an empty placeholder box (no CLS, fixed w-5 h-5) if unresolved — name text is never optional so identity never disappears.
- `components/ProGamesSection.tsx` — swapped its inline skeleton for the extracted `ProGamesSkeleton` import, no behavior change.
- `components/proAssets.ts` — added `getChampionIconMap()`: fetches `/api/champions` once (module-level cache, same pattern as the existing rune-map cache), returns `Map<id, {name, icon}>`. Chose this over guessing a `championName -> CDN key` transform because `ProGame.championName` is a *display* name (e.g. "Lee Sin" with a space) and the CDN icon URL needs the *key* form ("LeeSin") — `/api/champions` already carries both plus the resolved icon URL, so reusing it sidesteps the transform entirely.

**Decisions / deviations from the brief:**
- Skipped the URL-state nice-to-have (`?player=`/`?champ=` sync) — brief explicitly allowed skipping if it added complexity, and syncing would need a slug→player resolution round-trip through the search API with no guaranteed exact match, which is real complexity for a "nice to have."
- Mode toggle preserves each mode's own selection independently (switching Player→Champion→Player doesn't lose your player pick) — small UX call, not spec'd either way.

**Verification:** `npm run typecheck` / `npm test` (106/106) / `npm run build` all clean from project root — confirmed both before AND after the temp fixture wiring was reverted. Browser-verified via chrome-devtools MCP at 1280px and 390px: prompt state, player-mode typeahead + race-safe debounce, player-mode results (champion icon correctly resolved against the REAL `/api/champions` endpoint, not fixtures), champion-mode results (icon passed straight from the picked `ChampionRef`), clear (×) resetting to prompt state, and the home page (`/`) re-verified for zero regressions (TabNav renders, existing champion-mode Pro Games section still uses the real `/api/pros`, unaffected by the temp fixture wiring which only ever touched `PlayerPicker.tsx`/`ProHistoryResults.tsx`). Did not empirically screenshot the error/empty states on `/history` — logic is line-for-line the same pattern as the already-shipped `ProGamesSection`, low risk.

**Known gotcha hit + resolved:** orphaned `next dev -p 3919` background process locked `.next/trace` (`EPERM`) on the post-revert `npm run build` — matches the existing memory `bash-bg-dev-server-gotcha`. Killed via PowerShell `Get-CimInstance`/`Stop-Process` (bash `kill` doesn't reach Windows PIDs spawned this way), confirmed port free, build then succeeded clean.


