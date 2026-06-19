# CoachBuild — Champion + Lane Rune/Item Recommender

**Working name:** CoachBuild (rename later)
**One-liner:** Desktop-first web app. Pick any champion + lane, get the highest win-probability runes, shards, item path and summoner spells — powered by coachless.gg's WPA data, presented in the clean card layout we built for Viktor.
**Date:** 2026-06-14
**Verdict:** ✅ **Highly feasible.** coachless.gg exposes a clean, public, no-auth JSON API covering every champion, role, item slot and rune. The only architectural requirement is a thin serverless proxy (the API sends no CORS header, so the browser can't call it directly).

---

## 1. Investigation findings (confirmed live)

### API base: `https://api.coachless.gg/api/`
- **Auth:** none. Stats endpoints return full data with no token/cookie. (Only `User/GetSavedBuilds` needs login — we don't use it.)
- **Transport:** all **POST**, `Content-Type: application/json`, body is a JSON filter object.
- **CORS:** ❌ no `Access-Control-Allow-Origin` header → **browser-direct calls are blocked**. Server-side (curl/Node) works fine. → **we need a serverless proxy** (Next.js route handler). This is the single non-negotiable architecture fact.

### Endpoints we need
| Endpoint | Purpose | Extra body fields |
|---|---|---|
| `Rune/GetKeystoneData` | Keystones across all trees (runeType 0) | — |
| `Rune/GetRunesForKeystoneAndTree` | Minor runes for a tree (rows 1/2/3) | `mainTree`, `treeToLoad`, `keystone` |
| `Rune/GetShardsForKeystoneAndTree` | Stat shards `{offense[],flex[],defense[]}` (runeType 2) | `keystone` |
| `Rune/GetSecondaryTreePlaycount` | Which secondary tree is most run | `tree`, `keystone` |
| `ChampionWinprob/GetGlobalItemStatistics` | Items by slot/type | `itemSlots`, `itemType`, `keystone`, `starterId`, `firstPurchaseId`, `firstLegendaryId`, `secondLegendaryId`, … |
| `ChampionWinprob/GetGlobalSummonerSpellStatistics` | Summoner spells | `pairedSpell` |
| `ChampionWinprob/GetPatches` | Available data patches | (request shape TBD; ddragon fallback below) |

### Shared request schema (`commonFilters`)
```json
{
  "commonFilters": {
    "patch": { "major": 16, "patch": 11, "patchAdditions": 0 },
    "championIds": [112],          // Riot champ key, array
    "matchupChampionIds": null,    // set for vs-enemy matchup data
    "leagueTiers": [5,6,7],        // rank bracket filter (see enum)
    "regions": null,
    "role": 2                      // see role enum
  }
}
```

### Enums (decoded live)
- **role:** `0=TOP, 1=JUNGLE, 2=MIDDLE, 3=BOTTOM(ADC), 4=UTILITY(SUPPORT), 5=auto/primary`
  (verified: Garen→0, LeeSin→1, Viktor→2, Caitlyn→3, Thresh→4; role 5 returns each champ's main-role data).
- **tree IDs:** `8000 Precision, 8100 Domination, 8200 Sorcery, 8300 Inspiration, 8400 Resolve`.
- **itemType:** `1=legendary, 2=boots, 6=starter` (others exist; we use these 3).
- **itemSlots:** `[1]=1st legendary, [2]=2nd, [3]=3rd, [4,5,6]=4th+`. Boots/starter ignore slots.
- **leagueTiers:** rank brackets. `[5,6,7]` = high-elo default the site uses; `[1..10]` = all ranks (≈ Iron→Challenger). Exact per-tier mapping TBD — expose as a preset selector (High-elo / All).
- **summonerSpell ids** (Riot): `1 Cleanse, 3 Exhaust, 4 Flash, 6 Ghost, 7 Heal, 11 Smite, 12 Teleport, 14 Ignite, 21 Barrier`.

### Response fields (rich — includes real win rate, not just WPA)
- Runes/shards: `{ rune, runeType, wpaOverall, occurrence, runeEffects[] }`
- Items: `{ itemId, wpaOverall, wpaStandalone, occurrence, occurrenceRelative, winrateExpected, winrateObserved, averagePurchaseTime, bias, goodPurchaseSituations[] }`
- Spells: `{ summonerSpell, wpaOverall, occurrence, occurrenceRelative, winrateExpected, winrateObserved, averageCasts }`
→ **We can show both WPA and actual win rate.** `occurrence` = our sample-size/confidence signal.

### Static reference data (CDN, public, no auth)
| Data | URL |
|---|---|
| Patch versions | `https://ddragon.leagueoflegends.com/api/versions.json` |
| Champions (id↔name) | `https://cdn.coachless.gg/static-files/{ver}/{ver}/data/en_US/champion.json` |
| Summoner spells | `https://cdn.coachless.gg/static-files/{ver}/{ver}/data/en_US/summoner.json` |
| Items | `https://cdn.coachless.gg/item-base-v2/items-bundled.json` |
| Rune id→name/icon | `https://cdn.coachless.gg/rune-translations-v2/runes-bundled-en_US.json` |

### Icon URLs (reuse from the Viktor page)
- Champion: `…/static-files/{ver}/img/champion/{Name}.webp`
- Item: `…/static-files/{ver}/{ver}/img/item/{id}.webp`
- Summoner: `…/static-files/{ver}/{ver}/img/spell/Summoner{X}.webp`
- Rune perk: `…/static-files/{ver}/img/perk-images/Styles/{Tree}/{Rune}/{file}.webp`
- Tree: `https://cdn.coachless.gg/runes/{tree}.png` · Shard: `https://cdn.coachless.gg/stat-icons/{x}.png`

---

## 2. Risks & mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| Private/undocumented API can change or break | Med | Centralize all calls + the enum/ID maps in one module; cache responses so a brief upstream outage still serves last-good data; add a health check. |
| Rate limiting / being a bad neighbour | Med | Aggressive caching (data only changes per patch); proxy collapses duplicate requests; set a sane UA; never hammer per keystroke (debounce + cache). |
| ToS / legal (their data + Riot icons) | Med | Personal/non-commercial use; visible "Data from coachless.gg" attribution; Riot assets are allowed under Riot's Legal Jibber Jabber for non-commercial fan projects. Review coachless ToS before any public/commercial launch. |
| Patch skew (static assets vs API data patch) | Low | Use `GetPatches` (or observed latest) for the API `patch` filter; ddragon latest for asset version; tolerate a 1-patch gap. |
| Rune "minor" data needs per-tree calls | Low | Confirmed endpoints exist; fetch primary tree + top secondary tree (from `GetSecondaryTreePlaycount`) + shards in parallel. |

---

## 3. Product scope

### MVP (v0.1)
- Champion picker (searchable, all champs) + role selector (Top/Jungle/Mid/Bot/Support, default = champ's primary).
- One **recommended build**: keystone + primary tree (3 minors) + secondary tree (2 minors) + 3 shards + summoner spells + full item path (starter → 1st → boots → 2nd → 3rd → 4th+).
- Each pick shows **WPA**, **win rate**, and **sample size**; sample-size guard hides ultra-noisy picks from the "recommended" slot but lists them as alternatives.
- The card layout/visual language from the Viktor page (dark/teal, icon tiles, WPA colour-coding).
- "Last updated / patch X / high-elo" header + coachless attribution.

### Fast-follow (v0.2+)
- **Alternatives per slot** (expand a slot to see ranked options, like the real coachless table).
- **Rank bracket** selector (High-elo / All ranks).
- **Matchup mode** (`matchupChampionIds`): pick the enemy laner for matchup-specific data.
- **Metric toggle:** rank by WPA vs by win rate vs by popularity.
- **Sequential build optimizer:** use `firstLegendaryId`/`secondLegendaryId` so 2nd-item advice is conditioned on your actual 1st item (the API supports this — a genuine edge over op.gg/u.gg).
- Copy-to-clipboard / export, shareable URL (`/build/{champ}/{role}`), compare two champs.

### Explicitly out of scope (for now)
- User accounts / saved builds, live game overlay, importing runes into the client (Riot LCU is a separate, heavier integration — note as a "someday").

---

## 4. Architecture
```
Browser (Next.js App Router, desktop-first)
   │  fetch /api/build?champ=112&role=2&tiers=high
   ▼
Next.js Route Handler (Vercel serverless)  ── proxy + normalize + cache
   │  POST (server-side, no CORS issue)
   ▼
api.coachless.gg  +  cdn.coachless.gg static JSON
```
- **Stack:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, deployed on Vercel. (Matches our standard; reuse the Viktor page styling.)
- **Proxy layer:** route handlers under `app/api/*` fan out to the coachless endpoints in parallel (Promise.all), normalize into one `BuildResponse`, return to client. Keeps the upstream contract in one place.
- **Caching:** `Cache-Control: s-maxage` + `stale-while-revalidate` on the route (data changes per patch). Optional Vercel KV/Upstash for a shared warm cache + last-good fallback. Static maps (champion/rune/item/summoner JSON) fetched once and memoized per patch.
- **Static maps module:** loads ddragon/coachless JSON, builds `id→{name,iconUrl}` lookups for champs, items, runes, spells, trees, shards. Single source of truth for rendering.
- **Versioning from day one:** `scaffold-versioning.sh` — package.json version → `__APP_VERSION__` → footer + CHANGELOG; SW cache name tied to version (per app-build standard).

---

## 5. Recommendation algorithm
The site shows per-slot leaders by WPA; we mirror that but add a confidence guard so a +6 WPA / 200-sample fluke doesn't become "the build":
1. For each slot, drop options below a min `occurrence` (relative threshold, e.g. < 1% of the role's games or < N absolute).
2. Rank survivors by `wpaOverall` (default); expose toggles for win rate / popularity later.
3. "Recommended" = rank-1 survivor; "Alternatives" = next 3–4, each badged with WPA / WR / sample.
4. Secondary tree = top tree from `GetSecondaryTreePlaycount`, then its two highest-WPA rows.
5. Flag low-confidence picks (small sample) visually rather than hiding them entirely.

---

## 6. UI / UX (desktop-first)
- **Top bar:** champion search (icon grid + type-ahead), role toggle, rank preset, patch label.
- **Hero:** champ portrait + name + role + headline (patch, sample size, "from coachless.gg").
- **Build card:** exactly the Viktor layout — Runes (two tree columns + shards), Item Path (icon row with `›` arrows + WPA/WR/sample), Summoner Spells. Each slot expandable to alternatives (v0.2).
- **States:** loading skeleton, empty (champ not played in that role), error (upstream down → serve cached).
- Responsive but optimized for ≥1024px (per the request); graceful down to tablet.

---

## 7. Build phases & routing
| Phase | Work | Agents (per CLAUDE.md) |
|---|---|---|
| 0 Scaffold | Next.js + Tailwind + shadcn, versioning, deploy skeleton to Vercel | devy (scaffold + Vercel) |
| 1 Data layer | Proxy route handlers, coachless client, enum/ID maps, normalizer, caching | engy (backend) + data-engineer if cache layer grows |
| 2 UI | Champion/role picker + build card (port Viktor styling) | fronty + engo split |
| 3 Recommendation logic | Sample-size guard, ranking, secondary-tree resolve | engy (opus — correctness-sensitive ranking) |
| 4 Polish + verify | Loading/empty/error states, a11y, smoke test, prod smoke | fronty + audity cold-start verify |
- Full app-build loop (bugs → best-solution critique → best-UI critique) since this is a new app (≥3 surfaces, ≥10 files).
- Gates: `verify-fix.sh` → cold-start verify → `smoke-test.sh` + puppeteer drive (pick champ, change role, confirm icons + numbers render) before each deploy.

---

## 8. Open product decisions (my recommended defaults)
1. **Metric:** show WPA + win rate + sample on every pick; rank by WPA by default. *(Recommend.)*
2. **Matchup mode:** v0.2, not MVP. *(Recommend — keeps MVP tight.)*
3. **Rank bracket:** MVP fixed to high-elo `[5,6,7]`; selector in v0.2. *(Recommend.)*
4. **Faithfulness:** mirror coachless's per-slot leaders + our confidence guard (not a from-scratch model). *(Recommend.)*
5. **Sequential optimizer** (2nd item conditioned on 1st): strong differentiator, schedule for v0.2.

---

## 9. Effort estimate
- MVP (phases 0–2 + basic logic): ~1 focused build session with the parallel pairs.
- v0.2 (alternatives, matchup, rank selector, sequential optimizer): a second session.
- Lowest-risk path: scaffold + data layer first, prove one champ/role end-to-end through the proxy, then build the UI on real data.
