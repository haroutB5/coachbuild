# Gotchas

Verified facts that cost real debugging time. Cite these before touching the relevant area.

## Build-surface invariants (v0.100.1, 2026-08-06 — all three user-reported on Jax)

- **Hidden-gem pools dedupe by item id, keeping the largest-occurrence entry** — the pool
  merges core + optimizedPath + situational, and the same id arrives from different
  conditioned fetches with different stats. The dedupe lives INSIDE `selectHiddenGemPicks`
  (components/hextech/itemSetBody.ts) so the build-page card and the exported shop block
  cannot disagree. Dedupe happens BEFORE the median baseline, on purpose.
- **OPTIMIZED ORDER only reorders the WPA build's own legendary ids** (`wpaBuildItemIds` in
  lib/recommend.ts → `buildOptimizedPath`'s `allowedItemIds`). The constraint is enforced via
  `conditionedLeader`'s EXCLUSION predicate, never by pre-filtering the pool: the
  adoption-relative floor (`OPTIMIZER_ADOPT_FRAC`) is a fraction of the conditioned slot's
  TOTAL games, and a pre-filter shrank that total up to 8.7x (measured: Lee Sin floor
  8,707→999), re-admitting the thin-adoption spikes the floor exists to reject. LATENT: the
  dead matchup path can replace first/second/third AFTER the set is built — see the warning
  comment at the `wpaBuildItemIds` site before waking that path up. Known product question:
  the constrained chain can surface a negative-WPA step (Lee Sin: Black Cleaver −0.17).
- **OTP builds backfill to 5 full items + boots when the 15% display floor is sparse**
  (`MIN_FULL_ITEMS_FOR_BUILD` in lib/otp/featuredBuild.ts), showing real low percentages.
  Two guards discovered the hard way: (1) support-quest finals are excluded from
  recommendation surfaces for non-support lanes (`excludeSupportFinalItems` — mis-roled
  stored games put Bloodsong in Jax TOP's exported item set; `fullBuild` stays untouched,
  it is a record); (2) the slots include-set is floor-clearing ids ∪ displayed ids — capping
  it at the displayed six re-priced contested pairs and silently dropped deep-sampled
  champions' sixth item (Viktor lost Rabadon's).
- **`npm run dev` is broken on this machine** (Turbopack can't spawn its PostCSS worker,
  `0xc0000142`; every page 500s). Use `npx next dev --webpack` for local browser checks.

## Riot timeline / skill orders (2026-08-04 session, all verified live)

- **`SKILL_LEVEL_UP` events are NOT all skill points.** `levelUpType: "EVOLVE"` fires for
  Viktor augments, Kha'Zix evolutions, Kai'Sa evolutions — counting them as ranks stores
  impossible orders (6 Q ranks). `buildSkillOrder` in `lib/pro/extract.ts` filters to NORMAL
  (missing field tolerated as NORMAL). Verified: match NA1_5614721385, Viktor participant,
  22 events = 18 NORMAL + 4 EVOLVE.
- **Aphelios' auto-R IS serialized** as NORMAL SKILL_LEVEL_UP events even though it costs no
  point (contradicts docs-inference; every stored game shows R markers at exactly the auto-rank
  positions). His R events are stripped as zero-cost markers (`rAuto` in `lib/championKit.ts`)
  so his 18 stat points land one per level. Jayce's auto-R emits NO events — same mechanic,
  different serialization. Do not assume consistency across champions.
- **Viego possession produces phantom skill-ups** under Viego's participantId (all NORMAL,
  distinct timestamps, survive dedupe; e.g. EUW1_7937343328 stored 4 R ranks). The timeline
  exposes no possessed-champion marker. `buildSkillOrder`'s kit-aware budget guard drops events
  exceeding the champion's own caps; under-cap phantoms are undetectable and accepted.
- **Dropped events shift kept positions.** The extract guard removes phantom events, so a kept
  R taken at champion level 11 can sit at position 10. This is fine: no surface renders otp
  per-game orders raw, and the aggregate re-slots R by evidence at 6/11/16. Do not "fix"
  position gaps by re-inserting anything.
- **Sequence position ≠ champion level** when a player banks a skill point (real games show R at
  position 5: Kled, Sona, Zeri) or for Yuumi (one extra starting point, ±1 skew). The grids
  render position-as-level as an approximation; the aggregate's R normalization to 6/11/16
  absorbs the R case.
- **Seven champions break the 5/5/5/3 model** (Udyr, Jayce, Aphelios, Yuumi, Elise, Nidalee,
  Karma — see `lib/championKit.ts` header for the measured ddragon sweep). Any code that
  hardcodes standard caps or `ULTIMATE_LEVELS` for recorded data is wrong for them. Kits thread
  through `aggregateRecordedSkillOrders` and all skill grids; keep it that way.
- **The same `skill_order` shape lives in TWO tables**: `coachbuild.otp_matches` AND
  `coachbuild.pro_matches` (53k rows), both written by `extractMatch`. Any extractor fix needs a
  backfill of BOTH — missing pro_matches shipped a live impossible grid once.
  (`prostage_matches` has no skill_order column.)

## Operational

- **Scheduled ingest jobs hold pre-fix code in memory.** `ingest-otp-priority.mjs` (--max-hours
  12) and `ingest-matches.mjs` run long; after fixing extractor code, kill or cycle them, then
  mop-up backfill — they re-contaminated data for 2+ hours after a fix landed and starved the
  shared Riot API key (backfill at 55s/row vs 1.3s paced).
- **`scripts/backfill-skill-orders.mjs`** re-fetches timelines and rewrites skill_order:
  `--table otp_matches|pro_matches`, `--dry-run`, `--limit/--offset` chunking. Full runs take
  ~1-2s/row × thousands of rows — run DETACHED (nohup), never inline in an agent shell (a 70-min
  inline dry-run died on the tool timeout with all work lost). 404'd timelines → skill_order
  NULL (absent beats wrong). Candidate selection is kit-aware; Udyr/Jayce/Aphelios/Yuumi rows
  that conform to their own kits are not candidates.
- **`lib/otp/ingest.ts` writes skill_order only `WHERE skill_order IS NULL`** — backfilled rows
  are safe from re-clobbering, but a bad non-NULL row never self-heals; it needs an explicit
  backfill.

## Aggregation

- **Never aggregate skill orders by per-level marginal vote.** An ability every game takes early
  (at varying levels) can lose every single-level vote and surface at level 9 (the original
  Zaahen bug). `aggregateRecordedSkillOrders` uses a prefix-conditional walk: electorate at slot
  b = games whose basics-prefix matches the chosen prefix; marginal fallback only when the
  electorate empties. While the electorate is non-empty, every emitted basics-prefix is one some
  real game played.
