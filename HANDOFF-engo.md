<!-- merged into HANDOFF.md 2026-07-13 10:52:35Z; previous content preserved there. Append new rounds below. -->

## 2026-07-20 — engo: item-set restructure (3 sets → 1 set, blocks), v0.34.1 (web-only)

**User feedback driving this round** (item sets confirmed working in-game): merge Core/Optimized/Pro into ONE LCU set per champ+role as BLOCKS; every build line must be exactly 6 items with exactly 1 boots (live bugs: a line with 2 boots; an Optimized line with only 3 items); situational scenarios as another line in the same set.

### Files touched
- `components/hextech/itemSetBody.ts` — full rewrite. `buildItemSets` now returns a single-element array: ONE `ItemSet` (`uid: coachbuild-<champ>-<role>`, `title: CoachBuild <champ> <role>`, no variant suffix). New shared algorithm `buildLine(primary, fallbackPools, bootsIds)` enforces the 6-item/1-boots invariant for every line (dedupe → resolve boots count → pad from priority pools → trim to 6, never invents).
- `components/__tests__/itemSetBody.test.ts` — full rewrite for the new shape, 30 tests, incl. regression fixtures pinning both live bugs (2-boots-in-a-line via `alts.boots`/`fourthPlus`, 2-boots-in-pro-consensus via `pro.boots`, and a 3-item `optimizedPath` padded to 6) plus the companion.ps1 stale-set prefix-match test (item 3 of the brief).
- `components/__tests__/itemSetsApply.test.ts` — updated the two `applyItemSetsForBuild` tests that hardcoded the old suffixed titles / multi-set shape.
- `components/hextech/itemSetsApply.ts` — doc-comment only (no logic change; still calls `buildItemSets`/`applyItemSets` exactly as before — the array-of-1 return type is source-compatible).
- `components/hextech/RunesSummonersCard.tsx` — toast copy: "Item build added — check your shop in game." (was pluralized off `result.count`, which is now always 1).
- `components/hextech/BuildTabContent.tsx` — toast copy: "Item build added for `<champ>`…" (was "Item builds added…").
- `package.json` — `0.34.0` → `0.34.1`.
- `CHANGELOG.md` — new `[0.34.1]` entry.
- **`public/companion.ps1` — NOT touched**, per the brief and confirmed by reading `Merge-ItemSets`: it computes the stale-set prefix from `newArr[0].title` stripped from an em-dash onward. The new no-suffix title has no em dash, so the prefix is the full title (`CoachBuild <champ> <role>`) — old suffixed titles (`... — Core/Optimized/Pro`) all still start with it and get cleaned up automatically on next export. `companion.version` stays `1.3.0`.

### Block structure as shipped (in order)
1. **Starting** — `[items.starter]`, 1 item, exempt from the 6-rule.
2. **Core build** — always present. Primary = `[first, second, third, boots, ...fourthPlus]`. Padding cascade when short: optimized → situational → pro consensus.
3. **Optimized order** — only when `resolveOptimizedPathView` returns `kind: "path"` (same "genuinely differs from core" rule as before). Padding: **core remainder only** (deliberately not situational/pro, so it reads as "this build, refined order," not a grab-bag).
4. **Pro build** — only when pro-consensus data resolves non-empty. Primary = `pro.boots` + `pro.items` combined, sorted by share desc (boots dedup happens inside `buildLine` same as any other line). Padding cascade: optimized → situational → pro leftover.
5. **Situational swaps** — only when `items.alts` produces anything. `flattenSituational(items)` capped at 6, **exempt from the one-boots rule** (swap suggestions, not a worn loadout — several boots alternatives side by side is intended).

### Boots identification (read this before touching `buildLine`)
`Pick` (the shape this pure builder sees) has no `tags` field, so the tags-based `isBootsTag`/`isBootsFinal` check in `proConsensus.ts` (which needs `ItemDetail` metadata from an async `getItemDetailMap` fetch) is NOT reachable here. `collectBootsIds(items, pro)` builds one id set structurally instead: `items.boots.id` (the dedicated boots slot) + every id in `items.alts?.boots` (the dedicated alternate-boots pool — the same structural convention `ItemPath.tsx`'s own `isBoots` badge already uses, no tags involved there either) + every id in `pro.boots` (already tag-partitioned upstream by `proConsensus.ts`'s `isBootsTag` before this module ever sees it). If a future data source ever puts a boots item somewhere NOT covered by these three (e.g. a raw `fourthPlus` boots pick that never shows up in `alts.boots`), it will NOT be detected — flagged in the code comment, not a silent gap. Root-caused both live bugs against this design before writing it: the old Pro-set builder combined `[...pro.boots(≤2), ...pro.items]` sorted by share with no cap → 2 boots could both land in the top slice; the old Optimized-set builder shipped `optimizedPath` (2-3 items) completely unpadded.

### Test count
- `itemSetBody.test.ts`: 30 tests (was ~19 pre-rewrite).
- `itemSetsApply.test.ts`: unchanged count, 2 tests updated for the new shape.
- Full suite: **834 tests passed** (baseline was 822; net +12 from the richer fixture set, all new/updated tests are in the two files above).
- `bash scripts/verify-fix.sh` (tsc, lint, tests, build, sw, manifest) — ALL PASS, run twice (pre- and post-version-bump).

### Deploy
- Committed as `harout_b5@live.com` (see commit for hash).
- `npx vercel --prod --archive=tgz` — see terminal output in this round; prod URL verified to serve the new build (`__APP_VERSION__` sourced from `package.json`, no separate version file to hand-bump).

### Pending / out of scope
- Nothing outstanding from this brief. `HANDOFF.md`/`HANDOFF-engy.md` had pre-existing uncommitted changes in this worktree when I started (not mine, not touched) — left as-is; Urgot's merge hook owns reconciling those.
