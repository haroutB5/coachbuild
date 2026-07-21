# Champion-Select Recommender — Research (rechy, 2026-07-21)

Decisions locked by urgot on this evidence: u.gg stats2 primary; ingest→Neon→serve; shrunk-delta scoring; ban = disadvantage × presence; v1 scope as cut below.

> **P0 CORRECTION (engy, 2026-07-21, user-caught with external + internal
> evidence):** the "Winrate vs opp = wins/matches" claim below and its
> Aatrox-vs-Mordekaiser 52.02% anchor are WRONG about WHOSE wins the `wins`
> column holds. `wins` in champion X's OWN matchups file is the OPPONENT's
> wins in that pairing, not X's — this file's original probe validated
> `wins<=matches` (true under either perspective) and matched the anchor
> figure (also true under either perspective, since it never checked WHICH
> side 3173 belonged to) without ever actually confirming perspective. The
> real Aatrox-vs-Mordekaiser figure (Aatrox's own winrate) is
> 2927/6100 = 47.98%, not 52.02% — 3173/6100 is Mordekaiser's. See
> `lib/draft/ugg.ts`'s `decodeMatchupsJson` doc comment and
> `migrations/0011_draft_perspective_fix.sql` for the full incident, fix,
> and the new permanent cross-source guard (`lib/draft/ingestGuard.ts`)
> this ships with. The role-index anchors below (region/tier/role mapping)
> were separately, independently verified via game-volume dominance (not
> just this wins/matches claim) and remain correct.

## Source: u.gg stats2 CDN (PRIMARY, probe-verified)

- `GET https://stats2.u.gg/lol/1.5/matchups/16_14/ranked_solo_5x5/{CHAMPION_ID}/1.5.0.json` with REQUIRED header `Referer: https://u.gg/` (403 without, 200 with — app-level gate, not Cloudflare JS). 2.43MB JSON per champion.
- Structure: `data[regionId][tierId][roleId]` → `[ [rows], meta ]`; rows at node[0]. Row = `[opponentChampionId, rawWins, matches, ...15 statDiff cols (gold/xp/cs incl GD@15)]`. **CORRECTED (see the P0 note above): `rawWins` is the OPPONENT's wins in this row, not the file-owner champion's — winrate vs opp = (matches-rawWins)/matches.** Aatrox vs Mordekaiser raw row 3173/6100 @ region 12/tier 10/role 4 (111,890 games in that bucket) — Aatrox's real winrate is (6100-3173)/6100 = 2927/6100 = 47.98%, not the 52.02% originally (wrongly) computed here.
- Index anchors (empirical): region 12 = World; tier 10 = big default bucket (Emerald+/Plat+ aggregate); role 4 = Top. Standard u.gg role map top=4 jungle=1 mid=5 adc=3 support=2 — VERIFY 1/2/3/5 empirically at build.
- Companion files, same gate: rankings (wr/pickrate/banrate by rank+role): `.../rankings/16_14/ranked_solo_5x5/{champ}/1.5.0.json`; lane tier lists: `.../champion_ranking/world/16_14/.../1.5.0.json`.
- Patch segment `16_14` from ddragon versions.json (`16.14.1` → `16_14`); `1.5`/`1.5.0` are u.gg schema versions — hardcode + fallback probe on 404.
- FALLBACK: lolalytics SSR HTML `lolalytics.com/lol/<champ>/counters/` (200, data embedded, "min 100 games" rows); its `a1.lolalytics.com/mega/` JSON API is live but ep names unknown (don't blind-ship). op.gg: old REST DNS-dead; official MCP exists (emergency only).
- BUILD-IT-OURSELVES: INFEASIBLE — ~72k lane-matchups × ~300 games ≈ 10.7M matches; personal key ≈ 72k pulls/day → ~150 days per patch, patch cadence 14 days. Never spend the Riot key on this.

## Scoring (v1)

PLAY (candidate c, lane, tier; enemies e_i):
```
score(c) = baseline_wr(c,lane,tier) + Σ_i w_i · shrunk_delta(c vs e_i)
shrunk_delta = (matchup_wr(c vs e) − baseline_wr(c,lane,tier)) · n/(n+K)   // K≈200, hard floor n≥30 else drop term
w_i = 1.0 direct lane opponent; 0.2 off-lane
pool = lane champs with pickrate > 0.5% (rankings file), ~30-45 candidates; top-10
```
Delta-vs-baseline isolates matchup effect from champion strength (the lolalytics delta concept — raw matchup WR is confounded). n/(n+K) = closed-form shrinkage toward no-effect (20 games keeps ~9%, 2000 keeps ~91%).

BAN (user hovers m first):
```
ban_score(t) = max(0, (baseline_wr(m) − matchup_wr(m vs t)) · n/(n+K)) · presence(t, my_lane)
presence = pickrate(t,lane,tier) + small banrate term; top-5
```

## Architecture

INGEST (off hot path): Vercel cron (VERIFY stats2 200 from Vercel egress — unverified; fallback origins: companion/dev box, decoupled) → decode → Neon patch-scoped tables: `matchup(patch,tier,role,champ_id,opp_id,wins,games)` (~127k rows/tier), `champ_stats(patch,tier,role,champ_id,winrate,pickrate,banrate)`. Refresh on patch change (ddragon poll) + 2×/week. Validate wins≤matches invariant on ingest.
SERVE (hot path): companion→API→Neon→score()→top-10/top-5. NEVER live-fetch u.gg during champ select.

## Compliance (clear)

Riot explicitly APPROVES "overlays that provide static data available prior to the game". op.gg/Mobalytics/Blitz all ship champ-select counter suggestions (Overwolf-certified). Prohibited list is real-time in-game only (cooldowns/ult timers/power-spike alerts) — not applicable. Anonymity: render ZERO summoner names (rule covers allies too, May 29 2025 policy). Enemy champ picks in champ select are on-screen visible info, not hidden. Frame as suggestions/statistics; never auto-pick.

## UX notes

Show win% + delta score, sample-size/confidence badge (flag when n<K), patch + fetch-date stamp, tier label. Complaints to avoid: patch-lagged data (stamp it), low-sample garbage (shrinkage+floor+visible n), recommending champs user can't play (defer mastery-boost to v1.5), counter-vs-blind confusion (we know pick order from LCU — label "picking into known X" vs "enemy lane open").

## v1 scope

Ship: one tier (10/Emerald+, world), ingest matchups+rankings, PLAY top-10, BAN top-5, UX badges. Defer: mastery pool boost, comp AD/AP weighting, tier selector, synergy, lolalytics cross-check.

## Verify-at-build checklist
1. stats2 200 from Vercel egress (only dev-box verified — CONFIRMED at ship time: Vercel's own serverless egress to stats2.u.gg is ALSO Cloudflare-challenged (403), same class of block as this session's dev-box findings; non-blocking since the bootstrap runs from a script-transport machine instead — see HANDOFF-engy.md).
2. ~~wins/matches perspective = subject champ~~ **FAILED THIS CHECK AND SHIPPED ANYWAY (P0, caught post-ship by a user, 2026-07-21): the perspective is the OPPONENT's, not the subject champ's.** "Confirm vs u.gg UI on 2-3 lopsided matchups" was done at build time but only checked the wins<=matches invariant and a raw number match — neither actually confirms WHOSE win rate the number represents. Fixed in `lib/draft/ugg.ts`'s decoder + `migrations/0011_draft_perspective_fix.sql`; a permanent cross-source guard (`lib/draft/ingestGuard.ts`, checked against coachless as an independent third source) now makes a future recurrence of this exact class of miss self-detecting instead of user-detected.
3. Role indices 1/2/3/5 empirical validation — CONFIRMED correct (game-volume-dominance probe: Garen=top/LeeSin=jungle/Viktor=mid/Jinx=adc/Thresh=support all landed >85% of their total games in the expected role bucket).
4. `1.5`/`1.5.0` segments still live — CONFIRMED, no fallback probe needed during the full 173-champion bootstrap.
