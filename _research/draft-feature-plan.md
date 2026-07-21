# "Draft" Recommender — Implementation Plan (Plan agent, 2026-07-21)

Research (LOCKED decisions): `counterpick-research.md`. Target: app v0.37.0 + companion 1.4.0. engy = data/ingest/API/companion; fronty = UI/wiring/provider.

## Grounding facts (verified in repo)
- Neon: `getSql()` lib/pro/db.ts, schema `coachbuild` only, no-store fetchOptions load-bearing. Migrations: `migrations/NNNN_name.sql` via scripts/db-migrate.mjs → NEXT: `0009_draft.sql`.
- Ingest route pattern: copy app/api/ingest/prostage/route.ts (isAuthorized/CRON_SECRET, runtime nodejs, force-dynamic, maxDuration 60, ?cursor=N → nextCursor).
- Egress: Node fetch can be JA3-403'd where curl works → ingest lib MUST take injectable transport (mirror scripts/_curl-transport.mjs + Referer header for the script path).
- Patch discovery: reuse getLatestPatch() (lib/staticData.ts) → u.gg segment `${major}_${patch}`.
- Cache Gotcha: populated → s-maxage; empty/degraded/pending → no-store (patch-movers route is the reference).
- Companion already fetches FULL /lol-champ-select/v1/session (theirTeam/actions/timer in hand — no extra LCU calls needed).
- ONE poller rule: app/page.tsx owns the single 3s status poll incl. the Round-B P1 driven-mark logic — do not fork/duplicate.
- App lanes 0=TOP 1=JG 2=MID 3=BOT 4=SUP; u.gg roles top=4 jg=1 mid=5 adc=3 sup=2 → MAP AT INGEST, serve side is app-convention only.

## 1. DB — migrations/0009_draft.sql (engy)
`coachbuild.draft_matchup(patch text, tier smallint, role smallint, champ_id int, opp_id int, wins int, games int CHECK(wins<=games) CHECK(games>=0), ingested_at timestamptz DEFAULT now(), PK(patch,tier,role,champ_id,opp_id))`
`coachbuild.draft_champ_stats(patch, tier, role, champ_id, winrate real, pickrate real, banrate real, ingested_at, PK(patch,tier,role,champ_id))`
PKs cover the hot queries; no extra indexes v1. patch = "16.14" label (NOT the 16_14 segment). Retention: keep last 2 patch labels, pruned in ingest lib on final cursor only (never mid-fill).

## 2. Ingest (engy)
- `lib/draft/ugg.ts`: fetchMatchups/fetchRankings — `https://stats2.u.gg/lol/{schema}/matchups/{seg}/ranked_solo_5x5/{champId}/{schemaVer}.json`, REQUIRED `Referer: https://u.gg/`, injectable transport. Decoder: data[region][tier][role]→[[rows],meta], row=[oppId,wins,matches,...15]; validate wins<=games per row (drop+count violations, emit errorCount/skippedRows). Anchors: region 12 World, tier 10 Emerald+, role map above. Map u.gg role→app lane HERE.
- `lib/draft/patch.ts`: segment from getLatestPatch; schema vers hardcode 1.5/1.5.0 + probe fallback (1.5.1/1.6/1.6.0) on 404, cached.
- `lib/draft/ingest.ts`: mirror lib/prostage/ingest.ts. Cursor = batch index over champion list, BATCH≈8-10 champs/invocation (<50s worst case), upsert ON CONFLICT DO UPDATE. Retention on nextCursor===null. `runDraftIngest({cursor, transport, fastFailOnRatelimit})`.
- `scripts/ingest-draft.mjs` (+ package.json "ingest:draft"): full walk in-process, CURL transport, runs the empirical assertions (role indices via known-champ-max-sample, 1.5.0 liveness, wins<=matches, 2-3 lopsided matchups vs u.gg UI).
- `app/api/ingest/draft/route.ts`: prostate-route copy. `vercel.json` cron `0 8 * * *`; self-chain next cursor via internal guarded fetch with hard cap (recommended) — document single-tick-per-cron otherwise.
- Vercel-egress probe at deploy: one stats2 call from a Vercel function; 403 → non-blocking (script fallback documented).

## 3. Scoring — lib/draft/score.ts (engy, PURE)
K=200, N_FLOOR=30, W_DIRECT=1.0, W_OFFLANE=0.2, POOL_MIN_PICKRATE=0.005.
shrunkDelta(mWr, bWr, n) = n<30 ? null : (mWr−bWr)·n/(n+K).
playScore = baselineWr + Σ w_i·shrunkDelta_i (null terms omitted).
banScore(m,t) = max(0,(bWr(m)−mWr(m vs t))·n/(n+K)) · presence(t,lane); presence = pickrate + small·banrate.
API: rankPlays(pool, matchupsByOpp, enemies)→top10 {champId, score, winVsLaneOpp|null, confidence, minGames}; rankBans(hover,pool,matchups)→top5. Confidence: low when any contributing n<K. Stable tiebreak by champId.
Tests (exhaustive): shrink anchors (n=20≈9%, n=2000≈91%), floor 29/30, missing-row omitted, empty-enemies = pure baseline meta ranking, pool cutoff, weight ordering, ban clamp+presence, determinism.

## 4. API — app/api/draft/recommend/route.ts (engy)
GET ?lane=<0-4 required>&enemies=<csv>&hover=<id> → {plays≤10, bans≤5|null, meta:{patch,tier,fetchedAt}, pending?}. Neon-only. Direct-lane-opponent: tagged enemy (companion) or the enemy placed in the lane slot (manual). meta from max(ingested_at) + latest patch present. Headers: populated → s-maxage=300 swr=600; empty/pending/degraded → no-store. 400 malformed; DbUnavailable 503. Route tests incl. header assertions both ways.

## 5. Companion 1.4.0 (engy)
Snapshot gains `theirTeam` (championId ints >0; include enemy pickIntent when championId==0 — visible info, IDs ONLY, never names) + `timerPhase` (session timer.phase, null if absent). No extra LCU calls. Wire-contract comments both sides; SelfTest field/shape assertions (+null outside ChampSelect). Mock route: `?theirTeam=1,2,3&timerPhase=` params, defaults fixture. companion.version 1.4.0.

## 6. UI (fronty)
- `app/draft/page.tsx`: lane SegmentedControl (concrete lane, no auto); enemy multi-picker (SidebarChampionSearch field pattern + removable chips; ONE slot flagged "lane opponent" = isDirectLaneOpp); hover-your-champ picker → Bans section appears; results: rank/icon/name/score/win% vs lane opp/confidence badge (show n; low when n<K)/patch+fetch-date stamp/tier label. Debounced fetch + request-id race guard. States: pending ("Draft data being prepared for patch X"), no-companion (manual is default, no nag), low-sample (badge, never hide).
- Sidebar.tsx: "Draft" link BOTH render sites (desktop footer + mobile bar), next to Companion.
- **CompanionProvider lift (recommended, fronty owns):** new components/live/CompanionProvider.tsx in app/layout.tsx owning THE single status poll; app/page.tsx poll effect refactored to consume context — ALL follow/markCompanionDriven logic stays in place reacting to context updates (Round-B P1 fix must not regress — driven-mark re-establishes on every status change). /draft consumes read-only: phase==ChampSelect → auto-fill enemies=theirTeam, lane from roleId, hover=own champ; manual edits win (dirty latch) until "Reset to live". Pure helper lib-style `draftLiveSync` decision fn + tests. Fallback option (2nd choice): /draft-local single poll — only if provider lift proves too risky mid-build; document choice.
- companionClient.ts: FRONTY adds theirTeam/timerPhase types + defensive normalizer (old companion → []/null, never reject status) + degradation test. Contract fixed by plan — no waiting on engy.

## 7. Compliance
IDs/champion-names only, zero summoner names (SelfTest + client test assert). Copy = "suggested/statistically favored", never "pick this". /draft never POSTs to companion (no auto-pick).

## 8. Tests/split/shared/off-device
Vitest: draft-score, draft-ugg-decode (fixtures, zero network), draft-ingest (cursor/retention, mock sql), draft-recommend-route (headers!), draftLiveSync, companionClient extension.
Shared ledger: companionClient.ts → fronty (contract from plan); app/page.tsx → fronty (poll lift; engy hands off); mock-companion route → engy; CHANGELOG/HANDOFF both (prepend).
Off-device: real LCU theirTeam shape (mock route is the harness), Vercel egress probe (deploy-time), u.gg perspective/role-index checks (bootstrap script asserts).

## 9. Ship sequence (LOAD-BEARING)
1. Migration to live Neon (additive, safe during build).
2. FULL bootstrap ingest via scripts/ingest-draft.mjs LOCALLY (curl transport) + empirical assertions + u.gg UI spot-check. UI must not ship on empty tables.
3. Combined gate (verify-fix) → single deploy (backend+UI+companion) — acceptable because data is pre-bootstrapped.
4. Prod smoke: recommend endpoint w/ hand-picked enemies vs u.gg site; header discipline (curl -I both cases); companion live mode = user's gaming PC (mock route covers the rest).
