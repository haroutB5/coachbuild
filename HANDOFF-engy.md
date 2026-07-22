<!-- merged into HANDOFF.md 2026-07-22 13:27:21Z; previous content preserved there. Append new rounds below. -->

## 2026-07-22 — v0.48.0: item-set de-dup + curated variants + 6-item category lines (WEB-ONLY)

**Task:** two user-reported bugs from Viktor's in-client sets — (1) "AP/Mage" and "AP Burst" identical 4 items (de-dup, generally, not a Viktor special-case); (2) Tank Mage "isn't a good build and it's not 6 items". All in `components/hextech/itemSetBody.ts`; no companion change → no re-install.

**Probe first (root cause VERIFIED, brief's hypothesis partly wrong):** ran `buildItemSets` on a realistic Viktor before touching anything. Actual v0.47.1 output:
```
AP/Mage: 6655, 4645, 3089, 3020      <- identical
AP Burst: 6655, 4645, 3089, 3020     <- identical  (both data-first, his items are pure burst)
Tank Mage (low data): 3157, 3020     <- only 2 items (his 1 real durable + boots)
```
- Bug 1 confirmed: AP/Mage == AP Burst because both are DATA-FIRST and Viktor's real items are pure burst → same picks.
- Bug 2 mechanism CORRECTED: Tank Mage did NOT "pull his burst items" (the brief's guess) — its `match` already excluded them. It was STARVED (only his 1-2 real durable items) and capped at 4. The fix is a curated pool + 6 items, not a burst-exclusion.

**Fix — three changes:**
1. **`CATEGORY_LINE_LEN` 4 → 6.** Category lines are full builds now. Item count no longer bounds byte size — `CATEGORY_MAX_EMIT` (=4) caps the NUMBER of category blocks. `buildArchetypeLine` pads every data-first line to a full build.
2. **General de-dup** (`dedupeArchetypeLines`, pure + unit-tested). After all archetype lines are built, near-duplicate lines collapse to one, keeping the higher-priority name.
   - **`nearDuplicateLines`** (non-boots sets): collapse iff (a) `|A|-|B| <= 1` (similar length), (b) `inter >= min-1` (differ by ≤1 within the smaller), (c) `inter >= 1` (must actually share — this last clause is load-bearing: without it a size-1 line trivially satisfies `inter >= 0` and every thin line falsely collapses, the Jinx Lethality-vs-Crit false positive I hit).
   - **De-dup never compares across curated-ness** — a curated variant is doubly protected from being dropped by a standard line even when their fills accidentally overlap.
   - **`ARCHETYPE_PRIORITY`** (keep-order, higher wins): Tank > AP/Mage > Crit/Marksman > Lethality/Assassin > AP Burst > On-hit > Tank Mage > Bruiser (AD). Standard names outrank variants. For Viktor, AP/Mage wins over AP Burst.
3. **Variant archetypes are CURATED-POOL-DRIVEN** (`Archetype.curated`). `curated: true` for **Tank Mage** and **Bruiser (AD)**; `false` for AP/Mage, AP Burst, Crit/Marksman, Lethality, On-hit, pure Tank. A curated line leads with the champ's OWN on-archetype items (durable ones a mage genuinely builds), then the hand-ranked curated pool — never the champ's off-archetype (burst) items (they fail `match`). Labelled plainly (never "(low data)") — a deliberate judgment build.
   - **Tank Mage curated pool** (durable core → defense → damage cap): `[6657 Rod of Ages, 4633 Riftmaker, 3116 Rylai's, 4629 Cosmic Drive, 6653 Liandry's, 3157 Zhonya's, 3001 Abyssal, 3089 Rabadon's]`. Abyssal (pure MR, no SpellDamage) is trusted verbatim — `curatedArchetypePool` does NOT re-filter through `match`.
   - **Bruiser (AD) curated pool:** `[6631 Stridebreaker, 3071 Black Cleaver, 6610 Sundered Sky, 6333 Death's Dance, 3053 Sterak's, 3748 Titanic, 3078 Trinity, 3181 Hullbreaker]`.
   - **AP/Mage pool** trimmed burst/standard-leaning `[6655, 6653, 4645, 3089, 3135, 3157]` (removed Rylai's/Riftmaker) so it stays visibly distinct from Tank Mage.

**Also fixed (latent 2-boots bug, found via a failing invariant test):** a boots-tagged catalog item (e.g. Mercury's Treads — carries a durability tag, matched the pure-Tank archetype) could pad into a NON-boots slot because `collectBootsIds` only knows the champ's recommended boots. Fill pools (`categoryDefaultPool`, `curatedArchetypePool`) now exclude ALL boots-tagged items — the one-boots machinery resolves boots separately from the champ's own pool.

**Exact new Viktor output (verified via probe with full catalog meta):**
```
Core build: 6655, 4645, 3089, 3020, 3135, 3157
AP/Mage:    6655, 4645, 3089, 3020, 3135, 3157   <- ONE standard AP build (AP Burst de-duped away)
Tank Mage:  3157, 6657, 4633, 3020, 3116, 4629   <- 6-item durable build (Zhonya's + Rod of Ages + Riftmaker + Rylai's + Cosmic Drive + Sorc Shoes)
```
AP/Mage and Tank Mage share only Zhonya's (3157) → genuinely distinct.

**Byte budget (VERIFIED):** maximally-full set = 4 six-item category blocks (Tank, Bruiser, Lethality, On-hit) + Core/Buy order/Pro/Highest WPA/Starting/Situational = **10 blocks, 1852 bytes** — far under the 4096 B LCU per-object ceiling. (Item count freed by v0.46.0's stale-set prune; the block-count cap, not the item cap, bounds the size.)

**Tests (`components/__tests__/itemSetBody.test.ts`, +4 net; `itemSetsApply.test.ts` 1 updated):** Viktor → one AP build + distinct 6-item Tank Mage (AP Burst de-duped), no two archetype lines share an identical non-boots set, Tank Mage != AP build; Tank Mage curated durable-AP (contains Rylai's/Riftmaker/Abyssal-class) even with zero durable in his data; a bruiser's Bruiser (AD) curated build distinct from its Lethality/On-hit data builds; de-dup keep-priority (AP/Mage over AP Burst) + determinism (byte-identical across runs); byte-budget assertion for the maximal 6-item set; archetype-invariant test raised 4→6 items. Full suite: **1412 passed** (was 1408). `verify-fix.sh`: ALL CHECKS PASSED (tsc/lint/tests/build/sw/manifest).

**Acceptance results:** Viktor = 1 AP build + distinct 6-item Tank Mage ✓; bruiser = curated Bruiser (AD) distinct from crit/lethality ✓; actual tank = pure Tank, no hollow damage lines ✓.

**Not done / notes:** verified at UNIT/LOCAL level only (did not hammer prod). The Jinx integration fixture collapses Lethality into Crit/Marksman because that thin fixture's Damage items (Lord Dominik's/Bloodthirster) sit in the crit curated pool AND match lethality → 2/3 overlap; in prod (full catalog) the two diverge and both show. This is correct behaviour for a thin fixture, documented in the test.
