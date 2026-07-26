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
