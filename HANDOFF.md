# CoachBuild — handoff

**Current state: 2026-07-26, v0.58.0.** Prod: `coachbuild.vercel.app`. Companion: 1.6.4. All gates green, prod-smoked.

> ⚠️ **This file is at ~880 lines, well past its own 150-200 rollup threshold** (the merged per-agent rounds are most of it). A rollup into `CHANGELOG.md`-referenced footnotes is DUE — do it deliberately, keeping the open-items list intact, rather than trimming ad hoc.

## What shipped 2026-07-26 — v0.58.0 (audit wave 3)

Two parallel lanes against the `AUDIT-2026-07-25.md` still-open list. **The audit is still not re-runnable — read `AUDIT-2026-07-25.md`, do not re-dispatch its agents.** Waves 4 (frontend/UX) and 5 (infra) were deliberately SKIPPED at user request, not forgotten.

- **Security cluster** — `/api/prostage/timeline` atomic claim + exponential backoff (migration `0016`; a concurrent or too-soon request 429s having made **zero** outbound calls, instead of launching its own ~750-request walk); `lib/fetchTimeout.ts` wired through every previously-bare `fetch`; `/api/patch-movers` junk-param 308 + single-flight cache; companion TLS bypass scoped to loopback. See CLAUDE.md gotchas (v), (w), (z).
- **Item sets / archetypes** — `resolveDamageFamily` now needs a margin of ≥2 before an item tally beats class tags (one incidentally-tagged item was making tank supports "AD"); three curated ids dead since 16.13.1 corrected (`3001`→`8020`); the rule-1 test fixture replaced with a real pinned catalog slice. See gotchas (x), (y).
- **Prod-verified:** Leona renders Tank/Engage with no `Bruiser (AD)`/`Lethality` lines, Abyssal Mask resolves at +1.93 WPA, `?zzz=1` on patch-movers 308s to canonical.

**⚠️ ONE THING SHIPPED WITHOUT PROOF — top of the open list:** the TLS loopback-scoping change has **never run against a real self-signed LCU certificate**. No League client in the build environment, and `-SelfTest`'s mock LCU is plain HTTP, so the one code path it touches is exactly the one SelfTest cannot reach. `-SelfTest` passing is NOT proof here. Verify on a live client before trusting the companion's TLS posture.

This file describes where things stand now. Full release-by-release detail lives in `CHANGELOG.md` (every 0.32.0→0.51.3 entry is there in depth) — this file is deliberately NOT an append-only log anymore; per-agent `HANDOFF-<agent>.md` files get merged in here and then reset to a one-line pointer (see the bottom of each of those files). If this file is passing ~150-200 lines again, roll the older-than-today content into `CHANGELOG.md`-referenced footnotes rather than deleting the open-items list.

## What shipped 2026-07-25

- **v0.51.4 / companion 1.6.4** — the companion opened a fresh pair of tabs every game (user screenshot: 4 stacked tabs). `Test-CompanionHasAttachedTab` counted a tab as attached only if it had polled within **8 seconds** — sized against the web poll's 3s cadence, which only holds for a FOREGROUND tab. This feature runs while the tab sits behind a fullscreen game, and Chrome's intensive throttling collapses hidden-tab timers to ~1 tick/minute after 5 minutes hidden, so the check always said "nothing attached" and re-opened both pages every champ select. Fix: attach window **8s → 150s** (`$script:AttachWindowSeconds`), plus a new **25s open→attach grace** (`$script:OpenGraceSeconds`) for a second, independent bug — a freshly opened tab cannot have polled yet, so a champion change inside its cold-start opened *another* pair (that race alone stacked 4 tabs within one champ select). Deliberate behaviour change: a champion swap seconds after the Builds tab opens no longer opens a second tab; the cold-starting tab live-follows to the new champion itself. 4 new mock cases; `-Mock` + `-SelfTest` green.
  - **Measured, not inferred** — probe at `<urgot>/.smoke-tools/cb-throttle-probe2.mjs`: hidden+occluded tab held 20 ticks/min for 5 min, then **1 tick/min from t+360s**, max gap **60.0s**, while a visible control held 20/min. Three earlier probe attempts were invalid and discarded: puppeteer's default args disable background throttling; an attached CDP session suppresses it independently (so you cannot measure from inside puppeteer at all); and a background tab in a *visible* window is a weaker condition than the real in-game state (minimise the window). Full write-up in memory: `browser-throttling-vs-local-bridge-heartbeat`.
  - **User action:** restart the companion on the gaming PC (autostart re-fetches via `irm | iex`) to pick up 1.6.4, then close the stacked tabs once.

## What shipped today (2026-07-24)

Full six-surface UI redesign to the user's WPA-Intelligence mockups, in waves, then three fast-follow fix rounds, then a build-slot-cap correctness fix:

- **v0.50.0** — global navigation redesign: `AppShell` + `DesktopRail` (branded left rail) + `MobileTabBar` (4-destination bottom bar), replacing the old per-page `TabNav`/Sidebar/MobileNavMenu patchwork.
- **v0.51.0** — the mockup redesign itself: global `TopBar` + champion search bus + live champ-select chip + Apply Runes button; Builds page unified (lane/elo tabs move into the hero, PROS-mode search removed); Draft gold retheme with comp bars + takeaway chips; Companion status hero card; My Stats tiles/recent-games/adherence (migration 0014); Patch Movers rewritten to per-champion win-rate shifts; Pro Players gained (then, see 0.51.2, lost again) a recent-games table. Large deletion sweep of now-orphaned components.
- **v0.51.1** — three user-reported fixes from the 0.51.0 ship: My Stats fields were silently dropped by a normalizer that predated the API extension (a cross-agent seam nobody owned); a one-time KDA backfill script for 110 pre-migration rows; Pro Consensus icon sizing; the "Update ready" toast's dismissal moved from per-tab `sessionStorage` to version-keyed `localStorage` (was resurfacing on every new tab).
- **v0.51.2** — removed the Pro Players recent-games table per user directive (added in 0.51.0, reverted here) — `/history` is search-first again. Deleted `ProPlayersTable.tsx`, `app/api/pros/recent/route.ts`, `lib/pros/recentModel.ts` + tests.
- **v0.51.3 (WEB-ONLY)** — fixed an impossible 7-tile build display (Galio MID showed 6 full items + boots). New choke point `lib/buildSlotCap.ts`: 5 full + boots for all lanes, 6 full + boots for Bot/ADC (documented late-game boots-sell exception). LCU item-set export verified independently already correct (unconditional 6-cap, by design — a set is a real loadout, not a progression display).

All rounds gated through `verify-fix.sh` (tsc/lint/tests/build/SW/manifest) green; 0.51.0 additionally had a cold-start adversarial audit (fix-then-ship, both P3s fixed, one P1 migration-before-deploy executed) and a puppeteer smoke pass across `/mystats`, `/movers`, `/history`, a champion deep-link, and mobile 390px. Test count: 1524 (from ~1454 baseline this session).

## Open items, roughly by priority

- **Prostage cron gap, still untriaged.** The daily pro-play ingest cron (`/api/ingest/prostage`, 07:00 UTC) has never reliably landed data in production despite being correctly configured and working when invoked manually. Freshness currently depends on manually running `npx tsx scripts/ingest-prostage.mjs --via-export`. Carried forward unchanged from the last several doc passes — nobody has root-caused it yet.
- **F3 — rank-bracket tier labels are inferred, not confirmed** against coachless.gg's own UI (`lib/rankBrackets.ts` — no tier-name endpoint exists upstream). The tier-SETS (which numeric ids belong to which bracket) are verified against real data; only the human-readable labels are a best guess. A wrong label never yields wrong data — one-line fix if a label turns out wrong.
- **F4 — Patch Movers still uses a curated per-role champion pool**, not a true ladder top-N (coachless has no champion-list/tier-list endpoint — verified absent). Survived the v0.51.0 semantic rewrite (WPA-swing → win-rate-shift); only the metric changed, the candidate-pool limitation is the same as always. The win-rate deltas themselves are real.
- **My Stats build-adherence only resolves for games on the current live recommend patch.** `on_wpa_build` needs the match's own patch to equal the recommend pipeline's currently-resolved patch (no historical-patch override exists in `lib/recommend.ts`) — a match played on an older patch shows no adherence chip at all, honestly, rather than a comparison against the wrong patch's build. This is a known, permanent limitation of the current design, not a bug to fix.
- **Patch-note curation (`lib/patchNotes/`) is a manual per-patch chore.** Someone (agent or user) has to web-verify and add a one-liner for each new patch; Patch Movers shows "—" for any patch without one rather than fabricating. No automation exists for this yet.
- **P2 — `scripts/ingest-player.mjs` has no transient-retry wrapper** — a mid-run network blip fails the whole invocation. Unchanged status.
- **Gap — `RunePage`-shaped components have no vitest coverage** (repo convention: pure-function-only tests, no JSX rendering harness configured) — not yet split into a testable pure-helper shape for every rune-page-adjacent component. Check case-by-case; several rune-page pure helpers (`runesPage.ts`, `perkSlots.ts`) already do have coverage.
- **Cross-project P1, still carried, still untriaged:** matchday should be audited for the same Neon-HTTP-driver + Next-patched-`fetch` caching landmine as coachbuild's own v0.15.1 P0 (`CLAUDE.md` Gotcha a). Nobody has done this audit yet; it belongs to matchday's own handoff really, noted here only because it originated from this app's incident.

**Dropped from the open-items list this pass (verified fixed, not just assumed):**
- ~~Cargo `CargoExport` >500-row tournament truncation~~ — `lib/prostage/cargo.ts` now supports `offset` pagination past the 500-row cap on both the api.php and CargoExport transports. Confirmed in code, not just changelog.
- ~~`mapBracketState`-style trust issues~~ — that's a matchday concept, not a coachbuild one; never import matchday's trust-scoring machinery here without a clear reason.

## Backfills — status

All backfills mentioned in earlier passes (team comps, per-player team builds, prostage `pro_id` disambiguator repair, pro-play item-build timelines, game stats — CHANGELOG 0.17.0-0.19.0) remain complete and unchanged. New this session: the one-time My Stats KDA backfill (`scripts/backfill-mystats-kda.mjs`, 110/110 rows, resumable via `WHERE kills IS NULL`) — already run to completion, script can be deleted or kept as a reference for any future similar gap.

## Verification gaps (known, not yet closed)

- No live on-device confirmation yet that today's redesigned Companion status hero card correctly reflects all 5 real states end-to-end on a genuine League client session (puppeteer smoke covered the web-only render states, not a live LCU round trip).
- The rank-bracket tier-label question (F3 above) fundamentally can't be closed without either an official coachless.gg UI reference or a large-enough real-data cross-check — flagged, not blocking anything.

## Reference: architecture map

Don't re-derive the codebase from scratch — `CLAUDE.md` is the current map (routes, data pipeline, companion bridge contract, hard rules, gotchas). Read it first. `FEATURES.md` is the user-facing feature description, also current as of this same v0.51.3 pass.

---

# Merged from HANDOFF-engy.md (2026-07-26T01:46:18Z)


## 2026-07-25 — AUDIT-2026-07-25.md pipeline fixes (P1-1 pipeline, P2-1, P1-2 pipeline)

Scope: pipeline + consensus files only. Did NOT touch app/api/pros/route.ts,
lib/prostage/liveIngest.ts, migrations/, or any build-engine/UI file owned by
engo (ChampionHero, hero-stats, ApplyRunesButton, LivePanel, itemSetBody.ts).

### P1-1 — 500-row Cargo truncation on the path that actually runs
- `lib/prostage/ingest.ts`: `paginate` now **defaults to `true`** (was
  `false`). The only caller that ever opted in was the deletable
  `scripts/ingest-prostage-seed.mjs` one-off; the real 3-hourly production
  path (`scripts/ingest-prostage.mjs --via-export`) never did, so any
  tournament over 500 rows silently lost its older (out-of-order-backfilled)
  rows forever. Flipped the default rather than patching every call site so
  future callers are safe by construction — pass `paginate: false` explicitly
  to opt out (kept working, tested).
- Added loud-failure detection: `fetchScoreboardRows` now returns
  `{ rows, possiblyTruncated }`. `possiblyTruncated` is true when (a) an
  explicit `paginate:false` call lands on exactly `PAGE_SIZE` (500) rows, or
  (b) the paginated walk exhausts `MAX_PAGES` (10) without ever seeing a
  short final page. Either case pushes a `result.errors` entry + `log(...)`,
  same convention as the `maxGames` cap fix (v0.55.0,
  `lib/prostage/liveIngest.ts`) — a cap hit can no longer look identical to
  "nothing new."
- `scripts/ingest-prostage.mjs`: added a comment at the `runProstageIngest`
  call site explaining why no `paginate` key is passed (inherits the new
  default) — this IS the file that was silently truncating in production.
- `scripts/ingest-prostage-seed.mjs`: untouched — already passed
  `paginate: true` explicitly, still correct.
- Tests (`lib/__tests__/prostage-ingest.test.ts`): rewrote the "paginate
  false is the default" test to prove the NEW default (no `paginate` key at
  all now walks 2 pages), added an explicit `paginate:false` opt-out test,
  added a cap-hit-loud-error test for both the single-call-500 case and the
  MAX_PAGES-backstop case (extended the existing MAX_PAGES test).

### P2-1 — getDdragonMaps memoized a REJECTED promise
- `lib/prostage/ddragon.ts`: added `.catch(() => { cachedMaps = null; throw
  err })` to `getDdragonMaps`, matching `getLeagues` (`lib/prostage/
  lolesports.ts`) and `getChampionKeyByInternalId` (`lib/prostage/
  tournaments.ts`), which already self-clear on failure for the same reason.
  Doubly important since `runLiveProstageIngest` calls this above its own
  try block.
- Test added in `lib/__tests__/prostage-ddragon.test.ts`: a rejected fetch
  no longer poisons a later call — second call gets a fresh attempt.

### P1-2 (pipeline) — Pro Consensus item percentages understated by itemless live rows
- `components/hextech/proConsensus.ts`: added `ProConsensusModel.
  itemsSampleSize` — counts games whose raw `finalItems` array is non-empty
  (mirrors `RuneSlotAccumulator.add`'s own gate). `items`/`boots`/`starters`
  share now all divide by `itemsSampleSize` instead of `gamesTotal`. Added a
  header-comment section documenting the fix (matches the file's existing
  "BUG THIS FIXES" convention) plus updated the three affected field doc
  comments.
- `components/hextech/ProConsensusCard.tsx`: `StartersStackTile`/
  `BootsStackTile`/`ItemTile` now get `denom={model.itemsSampleSize}` instead
  of `model.gamesTotal`. Also fixed the "From N pro games" footer line — it
  now appends an honest item-coverage caveat (`· items/boots/starting from N
  games with item data` or `· no item data in this sample yet`) whenever
  `itemsSampleSize !== gamesTotal`, so the footer never implies item coverage
  the card doesn't have. This touches a file outside the audit's literal file
  list (`proConsensus.ts`) but was necessary — the denominator/label live in
  the rendering component, not the model.
- Tests (`components/__tests__/proConsensus.test.ts`): updated the stale
  "against gamesTotal" test title/assertions (numerically unchanged there —
  every game in that fixture has item data) and added a dedicated dilution
  regression test (2 itemed + 2 itemless games -> itemsSampleSize=2,
  gamesTotal=4, items/boots/starters share 100% not 50%).

### Verification
- `npx tsc --noEmit`: clean, zero errors.
- `npx vitest run` (full suite, PATH-prefixed for node64 shadow): 1549/1550
  passed. The 1 failure (`components/__tests__/itemSetBody.test.ts`, a Tank
  block `.type` read on `undefined`) is in engo's owned file
  (`components/hextech/itemSetBody.ts`, mid-edit per `git status` at time of
  writing) — not touched by this pass, not caused by anything above.
- Scoped test runs (`prostage-ingest.test.ts`, `prostage-ingest-route.test.ts`,
  `prostage-ddragon.test.ts`, `proConsensus.test.ts`): all green in isolation
  too.

### Nothing deviated from the brief except
- Touched `ProConsensusCard.tsx` in addition to `proConsensus.ts` for P1-2,
  as noted above — required to actually thread the new denominator to the
  UI and fix the label, which the brief explicitly asked for.

---

## 2026-07-25 (round 2) — AUDIT-2026-07-25.md P1-A / P1-B / P1-C (item-set lines)

Scope: `components/hextech/itemSetBody.ts` + its two test files. No version bump, no
CHANGELOG edit, no deploy, no commit (per brief). Working tree carries exactly 3 modified files.

### Files touched

- `C:/Claude/AI/coachbuild/components/hextech/itemSetBody.ts` — all three fixes
- `C:/Claude/AI/coachbuild/components/__tests__/itemSetBody.test.ts` — updated expectations + 14 new tests
- `C:/Claude/AI/coachbuild/components/__tests__/itemSetsApply.test.ts` — 2 fixtures made non-degenerate

Nothing under `lib/prostage/**`, `app/api/pros/**`, `migrations/`, `public/companion.ps1`,
`public/sw.js` was opened for edit.

### TASK 1 (P1-A) — the ranking formula and why

**Invariant now enforced: no raw WPA value is compared against a raw share value, anywhere.**

`Candidate` was `{id, weight}`. It is now:

```ts
type WeightScale = "wpa" | "share" | "gold";
interface Candidate {
  id: number;
  score: number;                                // THE ranking axis — scale-free
  raw: { weight: number; scale: WeightScale };  // provenance, never an ordering key
}
```

Formula: each SCALE is ranked once, over the entire union of sources speaking that scale
(`buildScaleRanking`), and `score` is the **reciprocal rank position** `1 / (1 + rank)` inside
that scale's pool. Duplicate ids within one scale collapse to their MAX weight (legal — same
number line; that is the "credit an item its best evidence" rule the old `unionPool` applied
*across* scales, which is what made it a bug). Ties share a rank (competition ranking).

Two rankings exist per champion: `wpaRanking` (core picks + optimized path + situational) and
`shareRanking` (pro consensus). The gold-scale fill pools are scored by array POSITION
(`scoreByPosition`) because their declaration/sort order already *is* their ranking.

**Why reciprocal rank and not the brief's suggested `1 - idx/len`:** `1 - idx/len` is
pool-size sensitive — last place in a 3-item pool scores 0.0 while 10th of 20 scores 0.5, so a
short pool's tail is punished and a long pool's middle rewarded for reasons unconnected to the
data. That is the same class of incommensurability this change exists to remove. Reciprocal rank
depends only on position. Rationale is in the `buildScaleRanking` doc comment.

**Where a raw weight is still read:** exactly one function, `orderByMetric`, and it takes the
scale as an explicit parameter (`MetricLens`) so the comparison is provably within-scale. The
nesting under `raw` is deliberate — `c.raw.weight` is loud in review where the old bare
`c.weight` read like a neutral ranking number.

Every other comparison site was converted to `score`: `unionPool`, `buildLine`, `findBestBoots`,
`buildThemedLine`, `buildArchetypeLine`, via one `byScoreDesc` helper that tie-breaks on original
array index (deterministic without relying on the engine's sort being stable).

#### "Highest WPA" — kept the name, did not rename

The block now honours its title, so renaming would have been the weaker fix. `orderByMetric`
partitions the pool: items carrying a measured WPA rank first, ordered by it; items lacking one
(pro-consensus-only ids) are appended as FILL and can never interleave above a metric-bearing
item. The boots pick is likewise the highest-WPA boots.

Two things the title deliberately does NOT claim, both documented in code:
1. The boots SLOT position — boots is reinserted after the first 3 items by the same layout
   convention every line in the module uses. That is reading order, not a ranking statement.
2. Which WPA — an id can appear in several pools with different WPAs; the module uses the MAX
   within the WPA scale, i.e. "the best WPA this champion's data records for that item".

The metric is read from `wpaRanking`, not from the winning candidate's `raw`: an id that ranked
better on pro share carries `raw.scale === "share"` in the union even though the build data does
score it, and the title's claim is about the latter. That is a trap I hit while writing this and
it is called out at the `wpaMetric` definition.

### TASK 2 (P1-B) — cross-family de-dup

New `dedupeLineBlocks`, running over EVERY build-line block (`LineFamily` = core / buy / pro /
themed / archetype). Blocks are now COLLECTED into a `LineBlock[]` and emitted at the end;
emitting them inline is precisely why the old de-dup could only ever see the archetype lines.

- Duplicate test: identical item SET, **order-insensitive**.
- One carve-out: the Core build / Buy order pair is a duplicate only when the ORDER matches too.
- Keep-priority: `core(0) < buy(1) < pro(2) < themed(3) < archetype(4 + ARCHETYPE_PRIORITY)`,
  with the emission index as a final tiebreak. Survivors are re-sorted into emission order, so
  the layout never depends on the de-dup's traversal.
- The v0.48.0 `dedupeArchetypeLines` **stays**. The two are complementary: it is FUZZY (collapses
  near-misses differing by one padded slot, boots ignored — the Viktor AP/Mage-vs-AP-Burst case it
  was built for), this one is EXACT and spans families. The "de-dup is deterministic" test stays
  green and a whole-set determinism test was added alongside it.
- Ordering choice: cross-family de-dup runs BEFORE the `CATEGORY_MAX_EMIT` trim, so a budget slot
  freed by a dropped duplicate goes to an archetype that shows the user something new.
- The `CATEGORY_MAX_EMIT` trim is keyed on the emission INDEX, not the block title. Titles are
  unique today, but keying a drop-set on a display string means the day two ever collide, BOTH
  get dropped — silent content loss for no saving.

The brief was right that this is largely downstream of Task 1: with the scales separated, most
lines stopped converging on their own. Only 2 of 49 champions lost a block outright (Lee Sin,
Mordekaiser); the rest of the 13 duplicates dissolved because the rankings genuinely diverged.

### TASK 3 (P1-C) — third label

`ArchetypeEvidence = "measured" | "low-data" | "suggested"`, from `evidenceFor(realNonBoots)`:

| measured non-boots items | title |
|---|---|
| 0 | `<Archetype> (suggested)` |
| 1 .. MIN_CATEGORY_MEASURED-1 | `<Archetype> (low data)` |
| >= MIN_CATEGORY_MEASURED (5) | `<Archetype>` |

Applied identically to curated and data-first archetypes — `arch.curated` no longer touches the
label at all. It describes where the ITEMS came from; the label has to describe what the EVIDENCE
is. Vocabulary matches `SupportItemCard.tsx`'s existing
`"Suggested — <archetype> build, not measured"`.

**Consumers checked.** Grepped the repo for anything parsing/matching a block `type`: nothing
does. `public/companion.ps1`'s `Test-ItemSetsPayload` validates the SET title (`CoachBuild`
prefix) and never inspects `blocks[].type`; `Merge-ItemSets` matches on set title too.
`itemSetsApply.ts` passes blocks through untouched. Only the two test files matched on titles, and
both were updated (`presentArchetypes`, `ARCHETYPE_TITLE_RE`). Worst-case live set is 1710 B
against the 4096 B LCU ceiling — DOWN from 1842 B, because de-dup removes blocks.

Also fixed, same file, same audit (P3): the `ProConsensusItemsInput` doc claimed `items`/`boots`
are "ALLOWLIST-INCLUSIVE ... `isFullItem` re-filters". That has been false since the 2026-07-22
starter partition, and believing it is exactly why the P0-A reader thought `isFullItem` was the
live guard for lane starters. Corrected in place with the incident named.

### BEFORE / AFTER — live prod data, 49 champions

Driven through the REAL `buildItemSets` + `aggregateProConsensus` against live `/api/build`,
`/api/pros?limit=100`, and the real 16.13.1 ddragon-shaped catalog. Responses were cached to a
scratchpad dir so BEFORE and AFTER ran on byte-identical inputs. BEFORE = HEAD (v0.56.0), swapped
in via `git show HEAD:` — not a re-derivation.

Covers all 13 mandated champions (Ornn Top, Yuumi Support, Jinx Bot, Ashe Bot, Viktor Mid,
Lee Sin Jungle, Garen Top, Jarvan IV Jungle, Malphite Top, Talon Mid, Ahri Mid, Annie Mid,
Leona Support) plus 36 more across every lane and archetype.

| metric | BEFORE (v0.56.0) | AFTER |
|---|---|---|
| duplicate block pairs across families | **13** | **0** |
| blocks whose title claims a metric they are not ordered by | **19** | **0** |
| blocks 100% judgment fill yet unlabelled | **6** | **0** |
| blocks over 6 items | 0 | 0 |
| duplicate id within a block | 0 | 0 |
| non-Starting/non-Situational blocks without exactly 1 boots | 0 | 0 |
| starter item in a completed line | 0 | 0 |
| max set bytes (limit 4096) | 1842 | 1710 |

The audit's original counts (11 duplicates / 23 champions) were measured before v0.56.0's
`isFullItem` starter fix landed and on a different roster; 13/49 is today's baseline on the code
this fix sits on top of. Yuumi Support's Pro build (the v0.56.0 zero-boots P0) re-verified
specifically: carries Ionian Boots of Lucidity, exactly one boots, in AFTER.

Sample diffs: Ornn Top `Highest WPA == Tank` (byte-identical in BEFORE) is now two distinct
builds; Malphite / Talon / Ahri the same; Lee Sin's `Core == Buy order == Pro` collapses to Core +
Buy order; Malphite's `Tank Mage` and Leona's `Bruiser (AD)` / `Lethality/Assassin` now carry
`(suggested)`.

### Tests

`npx tsc --noEmit` clean. `npx vitest run`: **1565 passed / 111 files**, up from 1551.
`npx next lint`: only the pre-existing `<img>` warning in `SpellRow.tsx`.

14 tests added under three `AUDIT P1-*` describes. **8 of the 14 fail against HEAD's
`itemSetBody.ts`** (verified by swapping the old module back in and running `-t "AUDIT"`) — they
are regression pins, not restatements of current behaviour. The other 6 are
invariant/exhaustiveness guards that must hold in both (determinism, the order-sensitive Core/Buy
carve-out, "the middle `(low data)` state is not swallowed by the new one", the 4096 B budget).

Existing tests changed, and why:
- 8 "block presence" tests dropped `Highest WPA` from their expectations. `baseItems()` is exactly
  5 full items + boots, so the whole candidate pool IS the core build and every ordering of it
  lands on the same six ids. Dropping it is the fix working. Each test carries a comment saying so.
- The Viktor "all blocks in order" test lost `Highest WPA` and `AP/Mage` for the same reason, and
  gained a positive assertion that the survivors are all genuinely distinct builds.
- The Viktor de-dup test was widened from archetype-vs-archetype to every build-line block.
- Two `(suggested)` label assertions (Viktor Tank Mage, Irelia Bruiser) — both fixtures' own names
  already said "zero durable-AP" / "data leans lethality".
- The Ornn "measured tank" fixture gained one non-tank core item, because a champion whose entire
  pool is tank items produces one build under five names and the label becomes unobservable. One
  damage item is also what a real tank's build looks like.
- `itemSetsApply.test.ts`: the "adds a Pro build BLOCK" wiring test used `PRO_GAME(3031)`, an item
  already in the champ's core, so the Pro line padded out to the identical set and was (correctly)
  deduped — the test would then have been asserting a block's absence for a reason unrelated to
  wiring. Now uses a pro-only id plus a 5th core item so Core build does not reach into the pro
  pool to fill its last slot.

### What I deliberately did NOT do

- **Did not rename "Highest WPA".** It can now honestly claim its ordering, verified across all 49
  live champions. Renaming would have hidden the fix rather than made it.
- **Did not change the two slot caps.** `LINE_LEN=6` (item-set line, all lanes) and
  `lib/buildSlotCap.ts` (build-line progression, bot exception) remain separate constants sharing
  no symbol. Verified live: zero blocks over 6, zero without exactly one boots.
- **Did not weaken `isFullItem`'s starter partition.** Untouched; re-verified live at 0 starters in
  completed lines across 49 champions.
- **Did not touch `dedupeArchetypeLines`.** Replacing its fuzzy near-dup rule with the new exact
  one would have regressed the v0.48.0 Viktor complaint (AP/Mage vs AP Burst differ by one padded
  slot — an exact-set test does not catch that).
- **Did not fix the remaining audit P2/P3 items** — dead curated ids (`3001` is Evenshroud not
  Abyssal Mask, `6691` Duskblade, `3193` Gargoyle Stoneplate all dead in 16.13.1); the
  `itemSetBody.test.ts` fixture that fabricates `into:["999999"]` on allowlist ids; `isKeystoneOf`
  dead code; `poolLen` counting boots in the `CATEGORY_MAX_EMIT` trim; `collectBootsIds` not
  absorbing tag-only boots. All out of the briefed scope. The one exception is the stale
  `ProConsensusItemsInput` doc claim, fixed because it is the comment that misdirected the P0-A
  reader and it sits in the block I was already rewriting.
- **Did not revisit `resolveDamageFamily`.** Leona Support resolving to the AD family (so she gets
  `Bruiser (AD) (suggested)` / `Lethality/Assassin (suggested)`) is pre-existing v0.47.0 behaviour,
  unchanged here — but it is now VISIBLE, because those lines used to ship with bare titles. Worth
  a separate look: the labels are honest, the archetype SELECTION for tank-supports may not be.
- **Did not run `verify-fix.sh` / `next build`.** Ran its component gates individually
  (`tsc --noEmit`, `vitest run`, `next lint`) since no version bump or deploy is in scope and
  gotcha (i) makes a stray `next build` a `.next/trace` lock risk.
- **No probe script left in the repo.** The live harness lives entirely under the session
  scratchpad; `git status` shows exactly the three intended modified files and nothing untracked.


---

# Merged from HANDOFF-engo.md (2026-07-26T01:46:18Z)


## 2026-07-25 — AUDIT-2026-07-25.md P1-1 (engine)/P1-2 (engine)/P2-5 fixes (engo)

Scope: build-engine + UI files only, per dispatch brief. Did NOT touch lib/prostage/**, scripts/ingest-prostage*, components/hextech/proConsensus.ts, app/api/pros/route.ts, or migrations/ (engy's lane — saw their concurrent edits in `git status`, left them alone).

**P1-1 (engine) — hero-banner stats ignored the active elo pill.** `ChampionHero`'s WIN%/GAMES/CONFIDENCE always queried HIGH_ELO_TIERS regardless of which rank pill was active, while the build panel one row below correctly re-filtered on `&rank=`.
- `lib/heroStats.ts` — `getHeroStats(championId, lane, opts?: FilterOpts)`, threads `opts` into both `getKeystoneData`/`getGlobalItemStatistics` calls. Kept `opts` OPTIONAL and undefined-safe.
- `app/api/hero-stats/route.ts` — reads `rank`, resolves via `resolveRankBracket` (same 400-on-unknown-id posture as `/api/build`), passes `{ leagueTiers: bracket.apiValue }`. No-rank still resolves to the DEFAULT bracket (High Elo `[5,6,7]`) — byte-identical to pre-fix behavior. `isHealthy`/no-store-on-degraded Cache-Control logic (gotcha b) untouched.
- `components/hextech/heroContracts.ts` — client `getHeroStats(championId, lane, rankBracket?)` only appends `&rank=` when non-default (same convention as `BuildTabContent.load()`/`AutoExporter.fetchBuildFor`). `getMostPlayedLane` still calls with NO third argument — verified it still compiles and stays un-bracketed (widest sample for fair lane comparison), per the CRITICAL constraint in the brief.
- `components/hextech/ChampionHero.tsx` — effect deps now `[champ.id, lane, rankBracket]`, passes `rankBracket` through.
- Tests updated/added: `lib/__tests__/heroStats.test.ts` (updated the exact-args assertion for the new trailing param, added bracket-threading + un-bracketed-when-omitted tests), `lib/__tests__/hero-stats-route.test.ts` (new `describe` block for rank→leagueTiers threading + 400-on-invalid-rank), `components/__tests__/heroContracts.test.ts` (new `describe` block pinning the "&rank= only when non-default" contract on the client wrapper).

**P1-2 (engine) — TopBar's APPLY RUNES silently overwrote the bracket-correct page AutoExporter just wrote.** `components/hextech/GlobalNav/ApplyRunesButton.tsx` fetched `/api/build` with no rank (always High-Elo); `AutoExporter.fetchBuildFor` honors the persisted bracket. Both build the identical LCU page title, so the companion's exact-title PUT let this button clobber the correct page while still reporting "Applied in-client." Copied the two lines verbatim from `AutoExporter.fetchBuildFor` (`readStoredRankBracketId()` + the byte-identical-when-default `rankParam` construction). Did not touch `AutoExporter.tsx` itself (reference only, per brief).

**P2-5 — `LivePanel` fetched `/api/build` without the rank bracket.** Same class as P1-2, display-only (in-game situational item panel). Same two-line fix in `components/live/LivePanel.tsx`'s existing champ/lane-keyed effect — did not add `rankBracket` to that effect's deps (matches AutoExporter's own pattern of reading storage fresh at call time, not reactively; the fix scope per the audit was strictly "same two-line fix").

**Verification:**
- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` on the three touched test files — 26/26 pass.
- Full `npx vitest run` — 1547/1548 pass. The one failure (`lib/__tests__/prostage-ingest.test.ts`) is in engy's in-progress `lib/prostage/**` work (file shows modified in `git status` under engy's concurrent edits) — unrelated to anything in this dispatch, not touched by me.
- No version bump, no CHANGELOG edit, no deploy — per constraints.

Files touched: `lib/heroStats.ts`, `app/api/hero-stats/route.ts`, `components/hextech/heroContracts.ts`, `components/hextech/ChampionHero.tsx`, `components/hextech/GlobalNav/ApplyRunesButton.tsx`, `components/live/LivePanel.tsx`, `lib/__tests__/heroStats.test.ts`, `lib/__tests__/hero-stats-route.test.ts`, `components/__tests__/heroContracts.test.ts`.



---

## Latest dispatch -- 2026-07-26 12:44

### engo

<!-- merged into HANDOFF.md 2026-07-26T01:46:18Z; previous content preserved there. Append new rounds below. -->

## 2026-07-26 (engo) — STILL-OPEN items 1, 5, 6 (item-set archetype family + dead curated ids + fabricated test fixture)

Scope: `components/hextech/itemSetBody.ts` + `components/__tests__/itemSetBody.test.ts` only, per brief.
No version bump, no CHANGELOG edit, no deploy, no commit. Working tree carries exactly these two
files (verified `git status` before/after; engy's concurrent security-cluster edits under
`app/api/**`, `lib/prostage/**`, `lib/pro/**`, `public/companion.ps1`, `migrations/**` were never
opened).

### Files touched

- `C:/Claude/AI/coachbuild/components/hextech/itemSetBody.ts`
- `C:/Claude/AI/coachbuild/components/__tests__/itemSetBody.test.ts`

### Method note

All three items were investigated by driving the REAL `buildItemSets` against LIVE data — prod
`/api/champions` + `/api/build` + `/api/pros`, and the real 16.13.1 item catalog via
`getItemDetailMap` (same `cdn.coachless.gg` mirror `itemDetail.ts` uses in prod) — from a temporary
vitest test file under `components/__tests__/` (vitest's `@` alias + tsx are what make the real
module importable outside a build; a bare Node script can't resolve `@/lib/types`). Every probe file
was deleted before finishing; `git status` never shows one mid-session diff had it been checked.

### ITEM 1 — tank/enchanter supports resolving to the AD damage family

**Root cause found, and it was NOT what the brief's own hypothesis implied.** The brief said "look at
`resolveDamageFamily`/`selectArchetypes`" as if the selection logic itself was mis-wired for supports.
It isn't — `selectArchetypes` correctly emits the family it's told. The bug is one level up, in
`resolveDamageFamily`'s tie-break: `if (ap !== ad) return { family: ap > ad ? "AP" : "AD", confident:
true }`. Live probe on Leona: her REAL recommended-item pool (core + optimized + situational + pro,
i.e. `themedUnion`) tallies `ap=0, ad=1`. The ONE item responsible is id **2524 "Bandlepipes"** — a
generic support Artifact item any support can pick regardless of their own damage type, whose only
AD-signalling tag (`AttackSpeed`) is incidental to its kit (`Health, SpellBlock, Armor, AttackSpeed,
NonbootsMovement, AbilityHaste`). A single incidentally-tagged item was enough to satisfy `ap !== ad`
and claim `confident: true`, which skips the tag-based fallback entirely — the fallback would have
correctly read her real ddragon tags `["Tank","Support"]` → AP. Braum and Rell (also `["Tank",
"Support"]`) showed the identical `ap=0/ad=1` shape from the same item.

**Fix (`resolveDamageFamily`, ~15 lines incl. comment):** require a decisive margin, not a bare
inequality: `Math.abs(ap - ad) >= FAMILY_TALLY_MARGIN` (constant = 2) before trusting the item tally
over the champion's own class tags. Verified against **27 live champions** (the brief's exact 8
supports — Leona/Braum/Nautilus/Alistar/Yuumi/Lulu/Soraka/Milio — plus Rell/Rakan/Thresh/Pyke/Senna/
Karma/Sona and AD/AP control champs Draven/Vayne/Yasuo/Riven/Viktor/Ahri, plus a wider non-support tank
spot-check: Amumu/Sejuani/Malphite/Ornn/Shen):

- Every genuine AD/AP carry in the sample clears margin=2 with huge room (Draven ad=15, Ahri ap=14,
  Pyke ad=10/ap=0, Senna ad=10/ap=2) — completely unaffected.
- Every single-item false positive (Leona, Braum, Nautilus\*, Rell — margin=1) now falls through to
  the tag branch and resolves correctly. (\*Nautilus/Alistar were already correct by luck — their
  single item happened to be AP-tagged, e.g. Redemption's `SpellDamage` tag; unaffected either way.)
- A margin of exactly 2 (Shen: `ad=3/ap=1`, tags `["Tank"]` only) is left item-driven, unchanged from
  today — Shen is outside the brief's named scope and this was not demonstrated wrong, so I didn't
  chase it further. Documented in the code comment as the boundary case.

**Did NOT weaken the honesty labelling.** `evidenceFor`/`ArchetypeEvidence` (measured/low-data/
suggested) are untouched; the fixed archetypes still carry `(suggested)` where the fill is 100%
judgment, same as before — the fix changes WHICH archetype family is offered, never how honestly it's
labelled.

#### BEFORE / AFTER — live prod data (16.13.1)

| Champion | Tags | BEFORE | AFTER |
|---|---|---|---|
| Leona (Support) | Tank, Support | `Tank \| Bruiser (AD) (suggested) \| Lethality/Assassin (suggested) \| On-hit (low data)` | `Tank \| AP/Mage (suggested) \| Tank Mage (suggested)` |
| Braum (Support) | Tank, Support | `Tank \| Bruiser (AD) (suggested) \| Lethality/Assassin (suggested) \| On-hit (low data)` | `AP/Mage (suggested) \| Tank Mage (suggested)`* |
| Nautilus (Support) | Tank, Support | `Tank \| AP/Mage (low data) \| Tank Mage (suggested)` | unchanged (already correct) |
| Alistar (Support) | Tank, Support | `Tank \| AP/Mage (suggested) \| Tank Mage (suggested)` | unchanged (already correct) |
| Yuumi (Support) | Support, Mage | `AP/Mage \| AP Burst (low data) \| Tank Mage (low data)` | unchanged (already correct) |
| Lulu (Support) | Support, Mage | `AP/Mage \| Tank Mage (low data)` | unchanged |
| Soraka (Support) | Support, Mage | `Tank Mage (low data)` (AP/Mage deduped into Core this call) | unchanged |
| Milio (Support) | Support, Mage | `AP/Mage \| AP Burst \| Tank Mage (low data)` | unchanged |
| Draven (Bot) | Marksman | `Crit/Marksman \| On-hit (low data)` | unchanged (control) |
| Vayne (Bot) | Marksman, Assassin | `Lethality/Assassin (low data) \| Crit/Marksman \| On-hit` | unchanged (control) |
| Yasuo (Mid) | Fighter, Assassin | `Bruiser (AD) (low data) \| Lethality/Assassin (low data) \| On-hit` | unchanged (control) |
| Riven (Top) | Fighter, Assassin | `Bruiser (AD) (low data) \| Lethality/Assassin \| On-hit (low data)` | unchanged (control) |

\*Braum's "Tank" line is cross-family-deduped against Core build on the AFTER run's particular live
data (not a bug — same documented Ornn-style collision the P1-B de-dup already handles); the important
change is the archetype titles switching from Bruiser/Lethality to AP/Mage/Tank Mage.

### ITEM 5 — dead curated pool ids in patch 16.13.1

Verified all three against the real catalog myself (not trusted blind, per the brief): `getItemDetailMap("16.13.1")` against the live coachless CDN mirror.

- `3001` = **Evenshroud**, `purchasable: false`. Confirmed. The audit's framing ("3001 is Evenshroud,
  not Abyssal Mask") is right but the deeper issue is the id was ALWAYS wrong for what the comment
  said — real Abyssal Mask id is **8020** (confirmed `purchasable: true`).
- `6691` = **Duskblade of Draktharr**, `purchasable: false`. Confirmed dead. Also checked its 2026
  reworked successor **Opportunity (6701)** as a candidate replacement — also dead this patch.
- `3193` = **Gargoyle Stoneplate**, `purchasable: false`. Confirmed dead.

**isFullItem already had a `purchasable === false` check** (added by an earlier session), so these
three ids never actually surfaced garbage in a live build — the real symptom was exactly what the
audit described: a curated pool silently resolving to 6/8 or 7/8 real entries, invisible unless you
counted.

**Fix, two parts:**

1. **Corrected the three ids**, verified live: `TANK_MAGE.pool` and `TANK_PURE.pool` both had `3001`
   meaning "Abyssal Mask" in the comment — both now use `8020`. `TANK_PURE.pool`'s `3193` (Gargoyle
   Stoneplate) is replaced with `3083` (Warmog's Armor, confirmed `purchasable: true`, same "pure
   durability, not primarily a damage item" theme). `LETHALITY.pool`'s `6691` (Duskblade) is replaced
   with `6676` (The Collector, confirmed `purchasable: true`) — already in `CRIT_MARKSMAN`'s own pool,
   which is fine; nothing forbids an item belonging to two thematically-adjacent curated pools.
2. **Structural guard, not another enumeration** — per the audit's own recorded lesson ("an
   enumeration used as a safety guard rots"), I didn't just patch the three ids and stop.
   `curatedArchetypePool` now warns (`console.warn`, once per id per process via a module-level dedup
   `Set`, so a warm Vercel lambda doesn't spam) whenever a curated pool id resolves to a catalog entry
   that IS `purchasable: false`. This is generic — it fires for ANY future patch casualty in ANY of
   the 5 curated pools (`TANK_MAGE`, `BRUISER_AD`, `TANK_PURE`, plus any future one), not just today's
   three. The id list stays (belt-and-braces, as the brief asked), but it's no longer the only guard.

Regression tests prove the warn fires (content-checked: mentions the id and the archetype title),
fires exactly once across repeated calls in the same process, and that none of the three OLD dead ids
(3001/3193/6691) remain referenced by any curated pool (checked by planting them as
`purchasable:false` in a rich test catalog and confirming zero warns for those specific ids, plus
confirming the real replacements 8020/3083/6676 show up in the corresponding live blocks).

### ITEM 6 — the rule-1 test fabricated `into` metadata

Confirmed the audit's exact claim: `STARTING_ITEM_ALLOWLIST` has 11 real ids
(1054/1055/1056/1082/1083/1086/1120/2049/2050/3070/3865). Fetched the real 16.13.1 shape for all 11.
**9 of 11 have `into: []`** (genuine recipe-tree leaves — Doran's x4, Cull, Guardian's x2, World
Atlas) and are excluded ONLY by `isFullItem`'s structural Lane-starter rule (`from.length===0 &&
goldTotal<=500 && tags.includes("Lane")`). Only **2 of 11** (Dark Seal `into:["3041"]`, Tear of the
Goddess `into:["3003","3004","2526","3119"]`) have a real non-empty `into`.

The old fixture set `into: ["999999"]` on **every** allowlist id. That's not just "false for 9 of
11" — it means the test could **never** have exercised the Lane-starter structural rule at all: a
non-empty `into` makes `isFullItem` return `false` via the ordinary `into.length === 0` check on its
own, before the Lane-starter branch is even relevant. I proved this concretely rather than just
asserting it: disabled the Lane-starter branch in `isFullItem` (`if (false && from.length===0 && …)`)
and re-ran —
- **with the OLD fabricated fixture: still green.** The test could not have caught this regression.
- **with the NEW real fixture (`realStarterMeta()`): fails**, `AssertionError: expected [...] to not
  include '1054'` — the discriminating power the test always claimed to have.

**Verdict: the TEST was wrong, not the code.** The code's structural rule is correct against real
data (all 11 ids resolve to the right non-full-item verdict, for the right structural reason in each
case). Fixed by replacing the fabricated per-id fixture with `realStarterMeta()` — a pinned literal
slice of the real 16.13.1 catalog for exactly these 11 ids (name/goldTotal/into/from/tags,
hand-transcribed from a live `getItemDetailMap` fetch, not re-derived or guessed). Re-enabled the
Lane-starter rule and confirmed the full suite green again before finishing.

### Tests added (all in `components/__tests__/itemSetBody.test.ts`)

New describe blocks, placed after the existing `AUDIT P1-C` section:

**"AUDIT follow-up — resolveDamageFamily requires a decisive item margin"** (4 tests):
1. Tank support (Tank+Support, single incidental AD-tagged item) resolves AP, not AD.
2. Enchanter support (Support+Mage, same shape) resolves AP.
3. A REAL AD-carry support (Support+Assassin, decisive margin) still resolves AD — proves the fix
   doesn't blanket-flip every support, only the thin-evidence case.
4. Margin boundary: margin=1 falls to tags, margin=2 stays item-driven, same champ tags/shape
   otherwise.

**Fails against HEAD:** tests 1, 2, and 4 (3 of 4) — verified by swapping the pre-fix module back in
(`git show HEAD:...`) and re-running with `-t "AUDIT follow-up"`. Test 3 (decisive-margin AD support)
passes on both HEAD and the fix, by design — it's an invariant guard proving the item-driven path
still works for genuine evidence, not a restatement of the bug.

**"AUDIT follow-up — dead curated pool ids are loud, not silent"** (3 tests):
1. A curated id that resolves to `purchasable:false` in the catalog triggers a `console.warn` naming
   the id and archetype, and the warn dedupes to exactly one call across 3 repeated invocations in the
   same test (avoids depending on cross-test module-state ordering).
2. All old dead ids (3001/3193/6691) confirmed absent from every emitted block, and their live
   replacements (8020/3083/6676) confirmed present, using a rich meta map with the OLD ids planted as
   `purchasable:false` — if a pool still referenced them, isFullItem would silently drop them (as
   before) and the presence assertions would fail.

**Fails against HEAD:** both (verified the same way — pre-fix module produces 0 warn calls and the
old dead ids' replacements are absent since they were never in the old pools).

**Item 6:** no NEW test — the existing `VERIFY-NOT-ASSUME (2026-07-22)` test's fixture was replaced
with `realStarterMeta()`. Confirmed it still discriminates (see the disable/re-enable proof above),
so no separate regression pin was needed; it IS the regression pin now, on real data.

Two pre-existing tests updated for the id fix (item 5): the Viktor "Tank Mage curated" test
(`3001` → `8020` throughout, comment updated) and — no other pre-existing tests referenced the old
ids.

### Gate results

- `npx tsc --noEmit` — clean.
- `npx vitest run` (full suite) — **1593 passed / 112 files** (up from the 1565/111 baseline this
  session started from; the delta includes both my +25 new tests and engy's concurrent additions in
  other files).
- `npx next lint` — only pre-existing `<img>` warnings (ChampionPicker/ChampionHero/IconWithFallback/
  ItemPath/SpellRow), none in files I touched.
- Did NOT run `verify-fix.sh` or `next build`, per the brief's explicit instruction (stray build risks
  a `.next/trace` lock) — ran the three gates individually instead, as directed.

### What I deliberately did NOT do

- **Did not chase Shen/Sejuani/Ornn/Malphite/Amumu beyond a sanity spot-check.** These are real
  non-support tanks I probed for margin-threshold safety, not named in the brief. Shen (margin=2,
  stays AD) is a genuine boundary case I flagged in a code comment but didn't "fix" — no live evidence
  it's wrong, and pushing the margin higher to chase it risks under-margining the real signal for
  genuine AD carries elsewhere. Sejuani (margin=1, now falls to Tank-only rather than getting
  Bruiser/Lethality suggestions) changed as a side effect of the general fix — arguably an
  improvement, not validated against the brief's scope either way.
- **Did not touch `resolveDamageFamily`'s tag-fallback branch itself** (Mage/Support→AP,
  Marksman/Assassin/Fighter→AD) — untouched, still exactly the v0.47.0 logic. Only the GATE for
  trusting the item tally over that fallback changed.
- **Did not expand FAMILY_TALLY_MARGIN's use to any other threshold in the file** (e.g. `MIN_THEMED_POOL`,
  `CATEGORY_MAX_EMIT`) — out of scope, unrelated invariants.
- **Did not add a replacement for every possible future dead curated id preemptively** — only the
  three confirmed-dead ones. The new `console.warn` guard is what covers the future case generically;
  I didn't speculatively swap other pool ids that are currently alive.
- **Did not touch `categoryDefaultPool`** (the non-curated catalog-wide fallback) — it already scans
  the live `itemMeta` map directly and inherits `isFullItem`'s purchasable check for free; no dead-id
  risk exists there the way it does for a hardcoded `arch.pool` array.
- **No probe/harness scripts left in the repo.** Three temporary vitest files were used during
  investigation (`_tmp_liveprobe.test.ts`, `_tmp_itemcheck.test.ts`, `_tmp_starterfetch.test.ts`,
  `_tmp_finalcheck.test.ts`) — all deleted before finishing; `git status` shows exactly the two
  intended files.
- **Did not run `verify-fix.sh` / `next build`** — per brief's explicit instruction (gotcha i,
  `.next/trace` lock risk). Ran the three component gates individually instead.

### What my verification CANNOT see

- **Live pro-consensus data changes over time.** The BEFORE/AFTER table and the 27-champion margin
  sweep were run against whatever `/api/pros` returned at the moment I probed (2026-07-26, prod). A
  different pro-game sample on a different day could shift an individual champion's `ap`/`ad` tally
  by ±1-2, which is exactly the boundary my fix is calibrated around (margin=2). I verified the
  MECHANISM is sound (decisive real evidence always clears the threshold by a wide margin in every
  sample I pulled — smallest genuine-AD margin observed was Pyke's ad=10/ap=0), not that every
  champion's classification is permanently pinned — that was never true even before this fix, since
  `themedUnion` is itself live-data-driven.
- **I did not audit every one of the ~170 champions in the catalog** — the brief's named 8 supports +
  my own +19-champion spot-check is a sample, not exhaustive. A support I didn't check (e.g. Bard,
  Zilean, Renata Glasc) could theoretically have its own single-item false positive from a DIFFERENT
  generic item than Bandlepipes; the margin fix should generically cover it (same mechanism), but I
  did not individually verify each one.
- **The dead-curated-id catalog check is a snapshot of 16.13.1.** If the live patch has moved on by
  the time this ships, some of my "confirmed live" ids could themselves need re-verification — this
  is exactly the class of drift the new `console.warn` guard exists to catch going forward, but it
  doesn't retroactively validate today's ids against a FUTURE patch.
- **I did not verify the companion-side (`companion.ps1`) rendering of these changed blocks in an
  actual League client** — out of scope (I never opened that file, per the brief's ownership split),
  and item-set generation here is pure-function tested end-to-end at the `ItemSet[]` JSON level, not
  through a live LCU apply.

engo


### engy

<!-- merged into HANDOFF.md 2026-07-26T01:46:18Z; previous content preserved there. Append new rounds below. -->

## 2026-07-26 — Security cluster (audit "STILL OPEN" items 2-4; items 5-6 already fixed, see below)

Scope was `app/api/**`, `lib/prostage/**`, `lib/pro/**`, `public/companion.*`, `migrations/**`.
`components/**` was engo's concurrent workstream — untouched, confirmed via `git status` before and
after. One pre-existing test failure (`components/__tests__/itemSetBody.test.ts`, "Abyssal via curated
verbatim") is inside that scope and was already failing before I started (engo's in-progress P2 fix) —
not something I broke.

### 1. P1-3 security — `/api/prostage/timeline` unauthenticated cost amplifier — FIXED

**Files:** `migrations/0016_prostage_timeline_backoff.sql` (new), `app/api/prostage/timeline/route.ts`,
`lib/prostage/timelineBackoff.ts` (new), `scripts/backfill-prostage-timelines.mjs`,
`lib/__tests__/prostage-timeline-route.test.ts` (new).

Added two columns (`timeline_next_attempt_at`, `timeline_attempt_count`) that do ONE job with two
effects:
- **In-flight de-dup.** Before touching the network, the route atomically claims the game via
  `UPDATE ... SET timeline_next_attempt_at = now() + 45s WHERE game_id=$1 AND timeline_status IS NULL
  AND (timeline_next_attempt_at IS NULL OR timeline_next_attempt_at <= now()) RETURNING ...`. Postgres
  row-level locking makes this race-safe: a concurrent request's UPDATE blocks until the winner
  commits, then re-evaluates the WHERE clause against the now-advanced timestamp and returns 0 rows —
  no walk, no network call, just an immediate 429. This is what stops a BURST of simultaneous requests
  for the same never-resolved game from each independently launching their own ~750-request walk.
- **Cooldown after `transient`.** On a `transient` result the same column is pushed out with
  exponential backoff (`computeBackoffSeconds`: 60s, 120s, 240s, ... capped at 1h, keyed off a
  persisted `timeline_attempt_count`) — so the next identical request can no longer re-trigger the
  walk immediately. **`timeline_status` is never touched on a transient result — it stays exactly
  NULL, same as before the fix.** I did not touch the transient-vs-terminal taint discipline the audit
  flagged as "do not touch" (verified: `resolveGame.ts` / `timeline.ts` are otherwise unmodified except
  for the fetch-timeout wrapping in item 2 below).
- **Self-healing lease.** If the function dies mid-walk (crash / maxDuration kill), the 45s lease
  simply expires and the row becomes claimable again — no separate unlock step.

Route now returns 429 (with a `Retry-After` header) for "already computing" / "still cooling down",
distinct from the 500 "transient, just failed" and 503 "DB unavailable" it already had.

Also patched `scripts/backfill-prostage-timelines.mjs`'s cursor query to skip a game whose lease/backoff
is still active (`AND (timeline_next_attempt_at IS NULL OR timeline_next_attempt_at <= now())`) — this
script isn't in the named scope but writes the exact same columns/rows the route does, and without this
it could stomp an active claim and reopen the double-walk problem from a different caller. It does NOT
independently set backoff on its own transient results (left as pre-existing behavior: "leaves NULL for
retry") — acceptable since this is a human-run, deliberately-small-limit tool, not the unauthenticated
internet-facing surface the audit is about.

**Tests (7 new, all in the "cooldown / in-flight claim / backoff" describe block explicitly FAIL
against pre-fix HEAD — that code had no such column/claim/cooldown and fell straight through to
compute):** future-cooldown bounces 429 with zero DB writes beyond the read; losing the claim race
bounces 429; a transient result sets backoff=60s at attempt 1 and verifies the exact SQL values
(`backoffSec`, `attemptCount`, `gameId`) reaching the UPDATE; a repeated transient failure compounds
backoff to 480s from a persisted `timeline_attempt_count=3`; an `unavailable` result clears the backoff
columns alongside the terminal status; an `ok` result persists every claimed row and clears backoff.
Plus 3 pure unit tests for `computeBackoffSeconds` (doubling, 1h cap, non-positive input floors to
attempt 1) — pure/no DB. Existing "ok"/"unavailable"/400/503 contract tests were preserved unchanged
and still pass (they don't exercise the new column at all).

**Verification gap, stated plainly:** the atomic-claim race-safety relies on standard Postgres
row-level-lock semantics for `UPDATE ... WHERE ...`, which I did not independently verify against a
live Postgres instance this session (route tests mock `sql` — they prove the route ISSUES the right
query, not that Postgres's locking behaves as documented under real concurrent load). This is standard,
well-documented Postgres behavior, not a novel claim, but it's still untested-live.

### 2. P2 security — no timeouts on any hot outbound fetch path — FIXED

**New:** `lib/fetchTimeout.ts` — single `fetchWithTimeout(url, init?, timeoutMs?)` helper (default 8s,
`FAST_FETCH_TIMEOUT_MS`=4s for high-fanout paths). Layers an abort on top of any caller-supplied
`signal` rather than replacing it (matters for `lib/coachless.ts`'s `post()`, which already accepted an
optional signal from `staticData.ts`'s ~4s patch-candidate probe).

**Wired into every bare `fetch(url)` I could find under my owned directories, plus the two
cross-cutting choke points the audit named (`lib/coachless.ts`, `lib/staticData.ts`) that
`heroStats.ts`/`patchMovers.ts` funnel through without calling `fetch` themselves:**
`lib/pro/riot.ts`, `lib/pro/lolpros.ts`, `lib/prostage/timeline.ts` (all 3 call sites, at
`FAST_FETCH_TIMEOUT_MS`), `lib/prostage/resolveGame.ts` (`ddragonJson`), `lib/prostage/lolesports.ts`,
`lib/prostage/ddragon.ts`, `lib/prostage/cargo.ts` (both `cargoQuery` and the CargoExport transport),
`lib/prostage/liveIngest.ts` (`fetchWindowAt`, at `FAST_FETCH_TIMEOUT_MS`), `lib/coachless.ts` (`post` —
the shared choke point behind `/api/build`, `heroStats.ts`, `patchMovers.ts`, `draft/recommend.ts`),
`lib/staticData.ts` (`fetchJson`).

**Deliberately NOT touched:** `lib/pro/seedCrossregion.ts` (one-off backfill-script utility, not a
live/hot request path — see its own header); `lib/draft/**` and `lib/mystats/**` (outside my named
scope and outside the audit's security-cluster findings). `lib/prostage/cargo.ts` already has its own
rate-limit/pacer discipline (30s floor, sticky-limit backoff) — the timeout there is a hung-socket
guard on top of that, not a replacement for it; confirmed the 429/ratelimit detection path (`res.status
=== 429` / body-text sniffing) is untouched and still works off the real HTTP response, not the abort
path.

**Verification:** `npx tsc --noEmit` clean, full `npx vitest run` shows no regressions from this change
(1591/1592 pass; the 1 failure is the pre-existing engo-scope one above) — several existing tests
exercise these modules' injectable-`deps` seams rather than the raw `fetch`, so this is necessary but
not sufficient proof; I did not spin up a real slow/hanging endpoint to confirm the abort actually
fires in ~4s/8s wall-clock in this session (would need a live network double, out of scope for a unit
gate run).

### 3. P2 security — `/api/patch-movers` amplification — FIXED

**Files:** `app/api/patch-movers/route.ts`, `lib/patchMoversCache.ts` (new),
`lib/__tests__/patch-movers-route.test.ts`.

Two independent problems:
- **Cache-key bypass.** The route now reads `req: NextRequest` and 308-redirects ANY request carrying
  a query string (including the legacy accepted-but-ignored `?role=`) to the canonical bare path
  *before* touching the compute path — the redirect itself makes zero coachless calls, so junk-param
  spam can no longer buy a free pass around the CDN's 24h edge cache. A real client's plain
  `fetch('/api/patch-movers')` (the only way `app/movers/page.tsx` calls it) is never redirected.
- **Outage amplification.** `computePatchMoversBounded()` in the new `lib/patchMoversCache.ts` adds an
  instance-scoped module-level cache + single-flight guard, mirroring the existing pattern in
  `staticData.ts`'s patch-resolution cache: a healthy result is reused for 6h, a degraded
  (`unsupported`/empty-movers) result for only 2m so a real outage recovers fast, and concurrent
  requests on one warm instance collapse into ONE `computePatchMovers()` call via a shared in-flight
  promise. A rejected compute is explicitly NOT cached (next request retries immediately rather than
  looping on a poisoned entry).

I split the cache/bound logic out of the route file into `lib/patchMoversCache.ts` (same for
`lib/prostage/timelineBackoff.ts` in item 1) after `tsc --noEmit` caught that Next's generated
`.next/types/app/**/route.ts` checker rejects ANY export from a route file outside the small
GET/POST/config/runtime/dynamic/maxDuration whitelist — a test-only export like
`__resetPatchMoversCacheForTests` or `computeBackoffSeconds` fails that generated-type check. Both
route files now only export `GET` + the Next config constants; the testable logic lives in `lib/`.

**Tests (8 new, split across two describe blocks explicitly FAILING against pre-fix HEAD — that route
had no `req` param, no redirect, and called `computePatchMovers()` unconditionally on every request):**
a junk-query-param request redirects with zero calls to the engine; a legacy `?role=2` bookmark also
redirects; the bare canonical URL is NOT redirected; a burst of 3 concurrent requests during an outage
collapses to exactly 1 engine call; a degraded result is reused on an immediately-following request
(no re-compute); a successful result is likewise reused; a rejected compute is NOT cached and the next
request retries. The 4 pre-existing contract tests (unsupported/empty/real-movers/no-args) were updated
only to pass a `NextRequest` and to call `__resetPatchMoversCacheForTests()` in `beforeEach` (module-level
cache state persists across tests in the same file otherwise) — their assertions are unchanged.

**Verification gap, stated plainly:** the amplification bound is scoped to a single warm serverless
instance and resets on cold start — it does NOT coordinate across many concurrently-cold Vercel
instances during a real outage spike. This is the same limitation `staticData.ts`'s existing
patch-resolution cache already has in this codebase (I followed that precedent rather than introducing
a new cross-instance mechanism like Redis, which would be new infra for this app). The CDN's own 24h
cache remains the cross-instance defense for the healthy case; this bound only helps the
degraded/bypassed case, and only per-instance.

### 4. P2 security — TLS validation disabled process-wide rather than loopback-scoped — FIXED (with a stated verification gap)

**File:** `public/companion.ps1`, `Initialize-TlsShim`.

Replaced the `AlwaysTrue` compiled delegate with `ValidateLoopbackOnly`: it inspects the TLS callback's
`sender` (cast to `HttpWebRequest` first, then `ServicePoint` — PS 5.1's `Invoke-WebRequest`/
`Invoke-RestMethod` on .NET Framework can hand back either shape depending on the call path) to
determine the target host, and only bypasses certificate validation when that host `IsLoopback`. Every
other target — concretely, the one non-loopback HTTPS call this script ever makes,
`Test-AutoUpdate`'s `companion.version` check against `coachbuild.vercel.app` — now gets REAL
certificate validation (`sslPolicyErrors == None`). Any unrecognized `sender` shape (cast fails on both
attempts, or any exception) falls through to strict validation rather than widening trust — a
type-inspection miss can only make the shim STRICTER than before, never introduce a new hole. Stayed a
COMPILED `Add-Type` delegate (not a scriptblock) to preserve the v1.2.2 runspace-affinity fix the file's
header documents — the TLS handshake callback runs on a threadpool thread with no PowerShell runspace,
and a scriptblock would throw there.

Confirmed the audit's other two findings about this shim are unaffected and don't need touching: the
`irm|iex` install/update chain still isn't MITM-able via this shim (every such call spawns a FRESH
`powershell.exe` where the shim hasn't run — I didn't change the install/update code path at all), and
`Test-AutoUpdate` still only feeds the fetched version string into a balloon-tip string, never
downloads/executes anything.

**Ran `powershell -File public/companion.ps1 -SelfTest`** after the edit — `SELFTEST PASSED`. This
confirms the script still parses/compiles cleanly (the C# `Add-Type` block is syntactically valid) and
every non-TLS-dependent bridge/gameflow/rune/item-set assertion still holds.

**Verification gap, stated plainly: I could NOT exercise the actual loopback-vs-non-loopback branching
logic against a real self-signed certificate in this session.** `-SelfTest`'s mock LCU (per the file's
own header) is a plain `HttpListener` over HTTP, not HTTPS — it never triggers
`ServerCertificateValidationCallback` at all, so SelfTest passing does NOT prove `ValidateLoopbackOnly`
correctly (a) accepts the LCU's real self-signed loopback cert or (b) correctly rejects/validates a
real non-loopback cert. There is no League client / real LCU available in this environment to test
against. This is a real gap — the change is reasoned from documented .NET behavior (the `sender`
parameter shapes for `HttpWebRequest`-backed calls) and a safe fail-toward-strict-validation design, not
live-verified. Flag for whoever ships this to smoke-test on a machine with a real League client before
calling it done: open the companion, enter champ select, confirm the rune/item-set apply still works
(proves the loopback branch still accepts the LCU), and check the update-nag balloon still behaves
sanely (proves the non-loopback branch didn't break the version check).

**Ship note:** this is a "COMPANION CHANGE" per this repo's existing convention (see CLAUDE.md's
companion-bump checklist / CHANGELOG's "(COMPANION CHANGE → x.y.z — re-install required)" tag) — I did
NOT bump `$script:Config.Version` (currently `'1.6.4'`) per the "no version bump" constraint, but
whoever ships this needs to bump it before running `prebuild` (`sync-companion-version.mjs` derives
`companion.version` from that literal), and users need the re-install nudge since the fix only takes
effect in a freshly-launched companion process.

### 5 & 6. P1-1 (`/apply-runes` body.name guard) and P1-2 (`companion.version` frozen) — ALREADY FIXED, no action taken

My brief listed these as items 5-6 to fix, but they are **not** in `AUDIT-2026-07-25.md`'s own "STILL
OPEN — next session" list at the top of the file, and I verified why before touching anything:

- **`Test-RunePayload`** (public/companion.ps1, ~line 786) already exists, is already wired into
  `Invoke-ApplyRunes` STEP 2 (`if (-not (Test-RunePayload -Body $Body)) { return @{ ok=$false;
  reason='invalid-page' } }`), and already enforces the `CoachBuild`-prefix gate mirroring
  `Test-ItemSetsPayload`. The audit's own FIX PROGRESS table confirms this shipped in v0.56.0.
- **`public/companion.version`** already reads `{"version":"1.6.4"}`, matching
  `$script:Config.Version`, and `scripts/sync-companion-version.mjs` (which runs as a `prebuild` step,
  wired in `package.json`) now derives it structurally from the `companion.ps1` literal so it can't
  drift again — also already shipped per the FIX PROGRESS table.

I did not modify either file for these two items. Flagging this so the brief can be corrected for next
time — the "STILL OPEN" list should have been the authoritative source I was pointed at, and it was
right; my dispatch brief just hadn't been refreshed against it.

### Gate results

- `PATH="/c/Program Files/nodejs:$PATH" npx tsc --noEmit` — clean, 0 errors.
- `PATH="/c/Program Files/nodejs:$PATH" npx vitest run` — 1591/1592 pass. The 1 failure
  (`components/__tests__/itemSetBody.test.ts`, Abyssal-via-3001) is pre-existing, inside engo's
  concurrent `components/**` scope, and unrelated to any file I touched (confirmed via `git status`
  before starting — that file and `components/hextech/itemSetBody.ts` were already modified, plus an
  untracked `components/__tests__/_tmp_itemcheck.test.ts` scratch file, all engo's).
- `PATH="/c/Program Files/nodejs:$PATH" npx next lint` — clean, only pre-existing `<img>`
  perf-suggestion warnings in `components/**` files I never touched.
- Did NOT run `next build` (per constraint) and did NOT run `node scripts/db-migrate.mjs` against the
  live DB (migration 0016 is written but not applied — ship-time task, consistent with "I handle the
  ship").

### Files touched (mine)

New: `lib/fetchTimeout.ts`, `lib/patchMoversCache.ts`, `lib/prostage/timelineBackoff.ts`,
`migrations/0016_prostage_timeline_backoff.sql`, `lib/__tests__/prostage-timeline-route.test.ts`.
Edited: `app/api/prostage/timeline/route.ts`, `app/api/patch-movers/route.ts`, `lib/coachless.ts`,
`lib/staticData.ts`, `lib/pro/riot.ts`, `lib/pro/lolpros.ts`, `lib/prostage/timeline.ts`,
`lib/prostage/resolveGame.ts`, `lib/prostage/lolesports.ts`, `lib/prostage/ddragon.ts`,
`lib/prostage/cargo.ts`, `lib/prostage/liveIngest.ts`, `scripts/backfill-prostage-timelines.mjs`,
`public/companion.ps1`, `lib/__tests__/patch-movers-route.test.ts`.



---

## 2026-07-26 (afternoon) — v0.61.2 shipped; next up is the pro-consensus support-item dedupe

State: **v0.61.2 live, gates green, prod-verified, working tree clean.** Full detail in
`C:/Claude/AI/urgot/data/SESSION-HANDOFF.md`.

Shipped since v0.58.0: companion 1.7.0 closed-browser fix (v0.59.0), two honesty fixes to Draft and
the core-order label (v0.59.1), the `/compact` mini view (v0.60.0), WPA defined + the Electron shell
removed (v0.60.1), the UI/UX audit list (v0.61.0), the support-quest-item slot cap (v0.61.1), and
three second-pass UI fixes (v0.61.2).

**Next, in order:**
1. **Pro consensus counts two support items** (Zaz'Zak's 80% AND Solstice Sleigh 20% — a player owns
   one). Ids are in `components/hextech/supportItem.ts` (`SUPPORT_FINAL_ITEMS`). The aggregation
   producer is NOT yet traced — `ProConsensusCard.tsx` takes `items: Map<number,string>` from
   upstream; check `BuildTabContent.tsx` and `/api/pros`. Collapse the family to one slot and offer
   the runners-up as alternatives. Put the logic in a pure tested `lib/` helper.
2. **Builds is ~3,000px of single scroll on mobile** — needs a user decision (BUILD | PRO segmented
   control vs collapsing the pro block), not a unilateral patch.
3. Desktop polish: the runes card ends ~150px short of the item column at 1440x900.

**Do not:** add champion suggestions to the empty Builds landing (standing directive in
`ChampionPickPrompt.tsx`), treat `/history`'s empty search state as a bug (deliberate, v0.51.2), or
resurrect the desktop shell (cancelled and removed in v0.60.1).
