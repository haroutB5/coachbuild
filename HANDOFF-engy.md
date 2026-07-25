<!-- merged into HANDOFF.md 2026-07-24 17:07:57Z; previous content preserved there. Append new rounds below. -->

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

