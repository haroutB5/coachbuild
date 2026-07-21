# /draft Redesign — Implementation Plan (Tactical Draft Analyzer)

> Authored by the opus Plan agent 2026-07-21 (persisted verbatim by urgot — the planner runs read-only).
> Target repo: `C:/Users/Harout/urgot-travel-bundle-2026-06-18/AI/coachbuild` · HEAD `v0.41.0` prod

## 0. Summary

The prototype re-skins `/draft` from the app's Hextech-gold theme to a cyan "tactical HUD" and reorganizes it into a two-panel top (ENEMY TEAM / MY CHAMPION), a team-comp radar, a sortable SUGGESTED PICKS table, and a SUGGESTED BANS table with an "UPDATE READY" refresh. Every honesty guarantee already baked into `/draft` (n= samples, LOW SAMPLE `v0.39.1` contract, main vs POTENTIAL COUNTERS split, ban 1000-game floor, explainer lines, manual-mode banner + champ-select re-attach, `useCompanion` live sync, display-only "My pool") survives unchanged — the scoring formula in `lib/draft/score.ts` is not touched. Three of the prototype's stats are fabrications with no data behind them; they are replaced with honest, explicitly-labeled derived values (§2). Two agents split the work: **engo** ships an entirely additive, independently-deployable data layer (Stage 0), **fronty** rebuilds the page + radar on top of it (Stage 1). No DB migration is required.

## 1. Investigation findings (what data actually exists)

- `app/draft/page.tsx` is a standalone shell (not the two-Sidebar layout). Its live-sync effect keys on `companion.tick` and threads a `dirty` latch + `entryStateRef` (champ-select entry detection, `v0.40.0`) + a race-guarded debounced fetch (`reqIdRef`, gotcha (q)). These effects and handlers are load-bearing and must be preserved byte-for-byte through the rewrite.
- `getChampionIconMap()` (`components/proAssets.ts`) hits `/api/champions` and builds `Map<number, ChampionIconEntry{name, icon}>`. `/api/champions` → `getAllChampions()` (`lib/staticData.ts`), whose source `champion.json` is ddragon's **summary** file — it carries `info.{attack,defense,magic,difficulty}` and `tags[]` per champion, but `loadChampsData`'s `ChampDataEntry` currently reads only `id/key/name` and discards the rest. This is the join seam for Difficulty (§2.1) and the coarse tag basis (§2.2/§2.3).
- Radar axes (CC/Damage/Tank/Mobility/Utility/Engage) have **no source** anywhere in the DB or the CDN payloads. `draft_champ_stats`/`draft_matchup` hold only winrate/pickrate(null)/banrate(null)/total_games and per-matchup wins/games.
- u.gg `stats2` rankings JSON is an unverified, deliberately-stubbed decoder (`decodeRankingsJson` returns `{}`), and the zone is Cloudflare-blocked except via `execFile('curl')` from a script. There is no verified per-vs-champion item-split endpoint. Item-counter data (§2.3) is not obtainable honestly this ship.
- The per-candidate score is `baselineWr + Σ weightᵢ·shrunkDeltaᵢ` (`computeScoredPool`). The synergy band (§2.4) is a pure re-banding of `score − baselineWr` — the exact terms already computed, no new math.

## 2. Data-gap decisions

### 2.1 Difficulty column — SHIP (deterministic, already fetched)
ddragon summary `champion.json` carries `info.difficulty` (1–10), already downloaded by `loadChampsData` and thrown away. **Join point:** extend `ChampDataEntry` to keep `info.difficulty` + `tags`, surface through `getAllChampions`/`getChampionById` → `/api/champions` → `ChampionIconEntry`. Join is **client-side** (row reads difficulty by `champId`); `lib/draft/recommend.ts` stays free of ddragon coupling.
- Banding (`lib/draft/difficulty.ts`, pure, unit-tested): `1–3 → "Low"`, `4–6 → "Medium"`, `7–10 → "High"` (named constants).
- Gap-filled champions (ddragon `findChampionGaps`) also carry `info.difficulty`; `null` difficulty renders `—`, never a fabricated value.
- Display-only. Never enters `score`. No migration.

### 2.2 Team-comp radar — curated static ratings dataset
Rejected: (a) CommunityDragon bin parsing (heavy, not honest scalars); (c) deriving from our winrate data (underivable). Winner: curated map.
- **`lib/draft/compRatings.ts`** — static `Record<championId, CompRatingVector>` for ~173 champs, axes `{cc, damage, tankiness, mobility, utility, engage}` rated **0–3** integers. Deterministic, versionable, unit-testable.
- **Rubric** (file header): 0 = none, 1 = minor, 2 = notable, 3 = defining (e.g. Leona = cc 3 / engage 3 / tankiness 3 / damage 0 / mobility 1 / utility 2). Editorial classification of kit identity, NOT a stat — UI labels the radar "Team profile (curated kit ratings)".
- **Maintenance:** new champion = one hand-added row; until then `deriveFallbackRating(tags, info)` gives a coarse vector (Tank → tankiness 2, Mage → damage 2, Marksman → damage 3/mobility 1, …), flagged `estimated: true`, chart footnotes "some ratings estimated." CI test: every live champ id resolves (curated or fallback, never blank).
- **Aggregation:** `aggregateEnemyComp(enemyIds): AggregatedComp` — mean per axis across resolved enemies; handles <5 gracefully.

### 2.3 MATCHUP ANALYSIS popover — one real stat, two honest replacements
Per lane opponent:
- **"Win Rate vs You" — REAL.** `draft_matchup` row `(laneOpponentId, hover, lane)` → `wins/games`, shipped with its `n`.
- **"Kill Pressure: High (62%)" — FABRICATED, replace** with **"Lane threat: Low/Medium/High"** derived from the lane opponent's shrunk matchup advantage (−shrunkDelta magnitude, gated by `N_FLOOR`), labeled "derived from matchup record", NO invented percentage. Below floor → suppressed.
- **"Key Item Counter" — FABRICATED, replace** with **"Suggested defense"** from the enemy's damage profile (`lib/draft/damageProfile.ts`: info.magic vs info.attack + tags → "Magic resist / Mercury's Treads" | "Armor / Plated Steelcaps" | "Tenacity (Mercury's Treads)" for high-CC comps), sublabeled "(derived from their damage type)".

### 2.4 Matchup Synergy column — re-band of existing score terms
New **derived** field `synergyDelta = score − baselineWr` on each `PlayResult` (existing terms, no new arithmetic). `synergyBand(delta)`: `≥ +0.015 → "Strong"`, `≤ −0.015 → "Weak"`, else `"Even"` (named constants `SYNERGY_STRONG_DELTA`/`SYNERGY_WEAK_DELTA`, tunable, not part of the locked formula). Empty enemies → ~0 → "Even" (or suppressed). Display-only.

### 2.5 UPDATE READY button — existing live-sync state, restyled
- `dirty && ChampSelect && champSelect` → glowing **"UPDATE READY ⟳"** (tap = `handleResetToLive()`).
- `liveSyncing` (`!dirty` in ChampSelect) → quiet "LIVE" pulse indicator, no button.
- No companion → hidden.

## 3. Two-agent split & file-by-file plan

### engo — data layer (Stage 0, additive, ships alone)
| File | Change |
|---|---|
| `lib/staticData.ts` | Extend `ChampDataEntry` with `difficulty: number \| null` + `tags: string[]`; read from `champion.json` in `loadChampsData`; carry through `getAllChampions`/`getChampionById`; `findChampionGaps` sets difficulty too. |
| `lib/types.ts` | Additive optional fields on the `/api/champions` row type (or new `ChampionMeta`). |
| `app/api/champions/route.ts` | Emit additive fields (keep 24h cache headers). |
| `components/proAssets.ts` | Extend `ChampionIconEntry` with optional `difficulty`/`difficultyBand`/`tags`. |
| `lib/draft/difficulty.ts` (new) | Pure `difficultyBand(n)` + constants. |
| `lib/draft/compRatings.ts` (new) | Curated map + `aggregateEnemyComp` + `deriveFallbackRating`. |
| `lib/draft/damageProfile.ts` (new) | Pure `suggestedDefense(tags, info)` → `{label, reason}`. |
| `lib/draft/score.ts` | Add `synergyDelta` to `PlayResult` (in `computeScoredPool`, = `score − baselineWr`); pure `synergyBand` + constants. No formula change. |
| `lib/draft/recommend.ts` | Populate `synergyDelta`; additive `enemyAnalysis: EnemyAnalysis[]` on `RecommendResult` (lane-opp winRateVsYou + laneThreatBand; per-enemy suggestedDefense). One extra `draft_matchup` lookup `(laneOpp, hover)`. Guarded/soft-fail like `attachPersonalRecords`. |
| `app/api/draft/recommend/route.ts` | No logic change; fields flow through. |
| `components/live/draftRecommend.ts` | Extend normalizer types + safe defaults (`synergyDelta: 0`, band "Even", `enemyAnalysis: []`) — never crash on an older cached response. |

### fronty — page composition, theme, radar (Stage 1)
| File | Change |
|---|---|
| `app/globals.css` | **Scoped** cyan token block under `.draft-tactical` (NOT `:root`); circuit-board background utility (SVG data-URI/CSS gradients, GPU-cheap); chamfer via `clip-path`; glow via `text-shadow`/`box-shadow` (not filter blur); new keyframes inside the existing `prefers-reduced-motion` guard. |
| `app/draft/page.tsx` | Wrap in `.draft-tactical`; **preserve all state, refs, effects, handlers verbatim**; re-lay-out into panels/radar/tables/UPDATE READY. Re-home every honesty state (loading, pending, error, empty, stale-patch, potential counters, ban-empty, My-pool empty, low-sample). |
| `components/hextech/DraftCompRadar.tsx` (new) | Pure SVG 6-axis radar (no chart lib); cyan filled polygon; dataviz-skill palette; curated/estimated footnotes; reduced-motion-safe. |
| `components/hextech/DraftPicksTable.tsx` (new) | Sortable table: Rank/Champion/Win Rate (bar+%)/Difficulty/Synergy; 390px → stacked cards or h-scroll container; `IconWithFallback` everywhere. |
| `components/hextech/DraftBansTable.tsx` (new) | Champion/Priority (existing ban bar)/Difficulty — drops the prototype's cryptic dual glyph columns. |
| `components/hextech/MatchupAnalysisPopover.tsx` (new) | INLINE popover (no history entry): Win Rate vs You (real), Lane threat band (derived), Suggested defense (derived). Anchored to highlighted lane-opp portrait. |
| `components/hextech/EnemyTeamPanel.tsx` / `MyChampionPanel.tsx` (new) | Enemy portrait stack (role icons, lane-opp glow) + My Champion picker/role toggles, reusing existing handlers. |

## 4. Pinned contracts (exact TS)

```ts
// lib/draft/difficulty.ts
export type DifficultyBand = "Low" | "Medium" | "High";
export function difficultyBand(difficulty: number | null): DifficultyBand | null;

// ChampionIconEntry (additive)
export interface ChampionIconEntry {
  name: string;
  icon: string;
  difficulty?: number | null;
  difficultyBand?: DifficultyBand | null;
  tags?: string[];
}

// lib/draft/compRatings.ts
export interface CompRatingVector {
  cc: number; damage: number; tankiness: number;
  mobility: number; utility: number; engage: number;   // each 0..3
}
export interface AggregatedComp extends CompRatingVector { estimatedCount: number }
export function aggregateEnemyComp(enemyIds: number[]): AggregatedComp;

// lib/draft/damageProfile.ts
export interface SuggestedDefense { label: string; reason: string }

// lib/draft/score.ts — PlayResult += synergyDelta: number  (= score - baselineWr)
export type SynergyBand = "Strong" | "Even" | "Weak";
export function synergyBand(delta: number): SynergyBand;

// recommend/draftRecommend (additive)
export interface EnemyAnalysis {
  champId: number;
  isLaneOpponent: boolean;
  winRateVsYou: number | null;
  winRateVsYouGames: number | null;
  laneThreatBand: DifficultyBand | null;
  suggestedDefense: SuggestedDefense | null;
}
// DraftPlayResult += { synergyDelta: number; synergyBand: SynergyBand }
// DraftRecommendResponse += { enemyAnalysis: EnemyAnalysis[] }
```
Rule: fronty consumes these; neither agent changes `K`, `N_FLOOR`, `W_DIRECT`, `W_OFFLANE`, pool floors, or the ban floor.

## 5. Prototype elements to IMPROVE, not copy
1. "Kill Pressure: High (62%)" → qualitative **Lane threat** band backed by real matchup delta + n; no percentage.
2. "Key Item Counter" → **Suggested defense** derived from damage profile, labeled derived.
3. Cryptic dual ban glyph columns → existing honest **ban priority bar** + single Difficulty column; `BAN_MIN_MATCHUP_GAMES` floor + empty state preserved.
4. Sortability → allowed, but default order = server's honest rank; sorting is display-only; n=/LOW SAMPLE/split survive every sort; caption when non-default sort active ("Sorted by X — ranking is CoachBuild's").
5. Radar → enemy polygon labeled "Team profile — curated kit ratings" (+ "some estimated" footnote); optional second polygon for the user's hovered champ; handle <5 enemies.
6. Win Rate bar → keep numeric % + low-sample dimming; never a bare bar.
7. Neon H1 → `text-shadow` glow (GPU-cheap), reads at 390px.

## 6. Test plan
- `lib/__tests__/draft-difficulty.test.ts` — band boundaries (0/1/3/4/6/7/10/null).
- `lib/__tests__/draft-compRatings.test.ts` — every live champ resolves; aggregate with 0/1/5 enemies + missing ids; fallback flags estimated.
- `lib/__tests__/draft-damageProfile.test.ts` — AP/AD/mixed/CC → expected labels.
- `lib/__tests__/draft-score-synergy.test.ts` — `synergyDelta = score − baselineWr` exactly; band thresholds; empty-enemies → ~0/"Even"; **pin `rankPlays`/`splitPlaysBySampleSize`/`rankBans` byte-identical** (locked-formula regression guard).
- `lib/__tests__/draft-recommend-enemyAnalysis.test.ts` — lane-opp lookup, null below N_FLOOR, soft-fail, unchanged plays/bans.
- `components/__tests__/draftRecommend.test.ts` (extend) — normalizer defaults for absent new fields.
- staticData/proAssets tests — difficulty/tags surface; gap-fill carries difficulty.
- Manual/live QA: 390px cards, prefers-reduced-motion, Lighthouse compositor cost, live re-attach + dirty latch + back-nav.

## 7. Migration needs
**None.** All additive/derived/static. Stage 0 independently shippable.

## 8. reactbits.dev consultation (fronty, standing directive)
Free-tier, decorative-only, reduced-motion-safe, GPU-cheap. Candidates: "Dot Grid"/"Squares" (base grid) + static SVG trace overlay for PCB traces ("Particles"/"Threads" lighter alts; prefer mostly-static CSS/SVG with slow opacity pulse); "Star Border"/"Spotlight Card"/"Glare Card" for luminous chamfered panels (if they blur large surfaces, hand-roll clip-path + inset box-shadow instead); "Count Up" for win-rate/priority numbers (must render final value instantly under reduced motion). Consult `dataviz` skill for radar palette + `fixing-motion-performance` for the background/glow pass.

## 9. Risk register
- **Live-sync effects (highest risk):** `companion.tick` effect, `entryStateRef`, `dirty` latch, `reqIdRef` debounced fetch must survive verbatim — a dropped dep silently recreates the v0.40.0 P0.
- **AutoExporter app-wide:** `.draft-tactical` wrapper lives INSIDE the page; never wrap/remount layout/provider tree.
- **Back-nav:** /draft does NOT use pushState (gotcha (n)/(p)); MATCHUP ANALYSIS popover must be inline, no history entry.
- **Theme leakage:** scoped class only, no `:root` edits.
- **Honesty-state loss:** §6 checklist is a required pre-merge gate.
- **Radar blanks/NaN:** fallback + estimated footnote + CI test.
- **Icons:** all portraits via `IconWithFallback` (gotcha (m)).
- **Sort vs live refresh:** sort = pure transform over latest `state.data` (gotcha (q) class).
- **Perf/reduced-motion:** keyframes inside the reduce guard; glow via shadow not filter; Lighthouse before ship.

## 10. Staged ship sequence
- **Stage 0 — engo:** additive data layer + tests; back-compat; independently verifiable.
- **Stage 1 — fronty:** scoped tactical theme + panels/radar/tables/popover/UPDATE READY consuming Stage 0.
- **Stage 2 — polish:** reactbits decorative pass, reduced-motion + 390px QA, Lighthouse.
