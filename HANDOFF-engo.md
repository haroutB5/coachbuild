<!-- merged into HANDOFF.md 2026-07-20 21:39:56Z; previous content preserved there. Append new rounds below. -->

## 2026-07-20 (round 3) — engo: lane-flip runes root cause + full-item rule + Buy order rename + themed lines, v0.36.0 (web-only)

**User-approved Round A, 4 items, on-device evidence from v0.35.0/companion 1.3.1.** Good news acknowledged: items now auto-export in game (last round's `.catch()` hardening / flow fix landed it).

### 1. Lane flip did not re-export RUNES — ROOT CAUSE FOUND (not what I expected)

I initially suspected the bug was in `champSelectFollowState.ts`'s new per-kind dedup (last round's own code) or in `runeAutoApply.ts` carrying a stale dedup of its own. Neither was true — verified by reading both fully: `runeAutoApply.ts` has NO dedup of its own (thin wrapper only, defers entirely to the shared gate), and the items/runes blocks in `BuildTabContent.tsx`'s effect are byte-for-byte structurally identical (same `shouldAutoExportForLane`/`tryClaimAutoExportLock`/`markAutoExported` calls, differing only in `kind`). If the dedup logic itself were broken, it would break BOTH kinds identically — but the coordinator's own framing ("items path unclear-but-working, runes definitively did not") was the tell that this was actually a TIMING bug likely affecting both, just more visibly reported for runes (a stale rune page name is glaringly visible in the client; a missing/stale item set for one lane is easy to not specifically check).

**Actual root cause: a React stale-closure race between BuildTabContent's two effects.** `lane` is a prop that updates the INSTANT the user flips lanes (`Sidebar.onLaneChange` → `setActiveLane`, synchronous). `state` (the fetched build) only catches up once the new lane's `/api/build` fetch resolves. React runs every changed-deps effect for a given commit using THAT render's own closure, in declaration order, without waiting for a state update an EARLIER effect in the same commit just scheduled. So on the very first re-render after a lane flip: the fetch effect (declared first) kicks off `load()` (which calls `setState({status:'loading'})` — queued for a LATER render); the auto-export effect (declared right after it) runs in the SAME commit and still sees `state.build` = the PREVIOUS lane's resolved build, paired with the ALREADY-updated `lane` prop. Exporting against that mismatched pair silently "used up" the new lane's dedup slot (`shouldAutoExportForLane`/`markAutoExported`) with the OLD lane's data — permanently blocking the real export once the correct build resolved moments later (its own render finds the dedup already thinks that (champion, lane) pair was handled).

**Fix:** new pure guard `heroContracts.ts`'s `isBuildForLane(buildRole, lane)` — the auto-export effect now returns early whenever `state.build.role` doesn't match `LANE_TO_ROLE_ID[lane]`, so it can only ever act once they're genuinely in sync. Symmetric fix for both kinds (this was never a runes-specific bug in the code, even though it was reported as one).

**Files:** `components/hextech/heroContracts.ts` (new `isBuildForLane` export), `components/hextech/BuildTabContent.tsx` (guard added as the effect's first line). Tests: `components/__tests__/heroContracts.test.ts` (pure `isBuildForLane` unit tests) + `components/__tests__/champSelectFollowState.test.ts` (a new describe block replaying the EXACT BuildTabContent sequence — stale render is a no-op for BOTH kinds, the real render still fires for both — this is the "lane flip fires both kinds" pin the brief asked for).

### 2. Full-items-only build lines (Dark Seal regression)

Root cause: `proConsensus.ts`'s `aggregateProConsensus` deliberately allowlists Dark Seal/Cull/Tear of the Goddess/Doran's items/support starters as "counts as a build choice" (`STARTING_ITEM_ALLOWLIST`) — correct for the Pro Consensus CARD's own display, but that same allowlist-inclusive `pro.items` data also fed `itemSetBody.ts`'s Pro build line.

Fixed with a narrower `isFullItem(itemId, meta)` in `itemSetBody.ts` that does NOT consult that allowlist: full = genuine recipe-tree leaf (`into` empty) or a legitimate finished boots (mirrors `proConsensus.ts`'s tier-2-boots special case exactly). No metadata at all → EXCLUDE (never assume finished) — deliberate, documented tradeoff (a totally failed metadata fetch degrades build lines toward empty rather than showing a possibly-wrong item; Starting/Situational are unaffected either way).

Real tag vocabulary confirmed via a live `item.json` pull against the coachless CDN mirror (16.13.1) before writing any of this — not invented. Full vocabulary observed: `AbilityHaste, Active, Armor, ArmorPenetration, AttackSpeed, Aura, Bilgewater, Boots, Consumable, CooldownReduction, CriticalStrike, Damage, GoldPer, Health, HealthRegen, Jungle, Lane, LifeSteal, MagicPenetration, MagicResist, Mana, ManaRegen, NonbootsMovement, OnHit, Slow, SpellBlock, SpellDamage, SpellVamp, Stealth, Tenacity, Trinket, Vision`. Confirmed Dark Seal (1082) has `into: ["3041"]` (Mejai's) — non-empty, correctly excluded.

`itemSetsApply.ts`'s `applyItemSetsForBuild` now resolves item metadata (`resolveItemMetaForSets`, new — reuses `itemDetail.ts`'s already-memoized `getItemDetailMap`, no extra network cost) in parallel with pro-consensus, threading it into `buildItemSets`'s new optional 5th param.

**Edge case found and closed while wiring this up:** a "Buy order"/"Pro build" block could ship with ZERO items if every candidate failed the new full-item filter (the data-availability gate was independent of content-emptiness). Both blocks now only push when their resulting line is non-empty.

### 3. "Optimized order" → "Buy order"

User: "that doesn't make sense." Block-`type` string rename only; `optimizedPath.ts`'s underlying logic (shared with `CoreBuildOrderCard`'s UI) untouched — out of scope.

### 4. Three themed lines: Highest WPA, Tanky, Burst

No new upstream fetch — derived from the SAME pools already built (core/buy-order/situational/pro-consensus), unioned by highest-weight-wins dedup. `TANKY_TAGS = {Health, Armor, SpellBlock}`, `BURST_TAGS = {SpellDamage, Damage, ArmorPenetration, MagicPenetration}` — there is no "Lethality" tag in ddragon (it's a stat, not a tag); real Lethality-class items are tagged `ArmorPenetration`, confirmed the closest real substitute rather than inventing a tag. "Highest WPA" has no tag filter (top-6 by weight across the whole pool). Each line: full-items-only, exactly one boots (themed-boots preferred, falls back to the overall best boots), omitted entirely (not padded with off-theme items) below a 4-qualifying-item threshold.

Block order: Starting, Core build, Buy order (if it differs), Pro build, Highest WPA, Tanky, Burst, Situational swaps.

### Files touched
- `components/hextech/heroContracts.ts` — new `isBuildForLane` export.
- `components/hextech/BuildTabContent.tsx` — the `isBuildForLane` guard added.
- `components/hextech/itemSetBody.ts` — `isFullItem`/`fullItemsOnly`/`hasAnyTag`/`unionPool`/`buildThemedLine` added; "Optimized order" → "Buy order"; empty-block guard on Buy order/Pro build; `buildItemSets` gains an optional 5th `itemMeta` param.
- `components/hextech/itemSetsApply.ts` — new `resolveItemMetaForSets`; `applyItemSetsForBuild` resolves it in parallel with pro-consensus and threads it through.
- Tests: `heroContracts.test.ts` (new `isBuildForLane` coverage), `champSelectFollowState.test.ts` (new lane-flip-sequence describe block), `itemSetBody.test.ts` (full rewrite with real `ItemDetail` fixtures throughout — the full-items rule needs them — Dark Seal regressions across Core/Pro/Situational/themed contexts, themed-line construction/omission/boots-preference), `itemSetsApply.test.ts` (item-metadata wiring incl. a total-fetch-failure degradation case).
- `package.json` `0.35.0` → `0.36.0`; `CHANGELOG.md` new entry.
- **`public/companion.ps1`/`companion.version` NOT touched** — confirmed this round is entirely web-side (the runes bug was a web-side React race, not a companion protocol issue; the item-set rules are pure builder logic). Companion stays at 1.3.1 — no user action needed this round.

### Verification
- `bash scripts/verify-fix.sh` (tsc, lint, tests, build, sw, manifest) → ALL PASS, run 3x across the round (once mid-work, once after a TS2802 Map-iterator-spread fix, once after the version bump). **867 tests passing** (baseline 851; net +16 across the 4 touched/new test files).
- One real bug caught by tsc during this round (not by me manually): `tsc -b` failed on `[...map.values()]` (Map iterator spread needs `--downlevelIteration`/ES2015+ target this project doesn't set) — vitest's own transpiler didn't catch it, only the strict build did. Fixed by switching to `Array.from(map.values())` throughout (itemSetBody.ts's `unionPool` + every test fixture spread). Worth remembering: an all-green `vitest run` is NOT proof `tsc -b`/the Next build will also pass — always run the full `verify-fix.sh`, not just the test runner, before calling something done.

### Ship
- Committed as `harout_b5@live.com`.
- `npx vercel --prod --archive=tgz` — prod URL verified to serve `v0.36.0` (footer).
- No companion re-install needed this round (still 1.3.1, unchanged).

### Pending — Round B (full optimization sweep) NOT started per explicit instruction
- Coordinator said a Round B follow-up is coming after this round; told explicitly not to start it. Stopping here and reporting back.
- `HANDOFF.md`/`HANDOFF-engy.md` again show pre-existing uncommitted changes in this worktree that are not mine — left untouched, not staged.
