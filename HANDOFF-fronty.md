<!-- merged into HANDOFF.md 2026-07-22 07:52:34Z; previous content preserved there. Append new rounds below. -->

## 2026-07-22 — v0.45.1: Pro Consensus card can push its own page/build (manual)

**Scope:** solo fronty, pure-FE + logic, no backend change. Waited on engy's v0.45.0 (companion.ts follow-kind round) to land before running verify-fix/bump/deploy per the shared-file freeze on `components/live/companionClient.ts` (import-only dependency, no edits) — commit `29c1011` landed ~30min in; `applyRunes(port, session, body, mode, deps)` signature was untouched by that round, so no rework needed.

**Files:**
- `components/hextech/proConsensus.ts` — new pure exports: `missingRunePageReason(model)` (single source of truth for "is this page complete enough to push"), `proConsensusRuneApplyInput(model, fallbackShards)` (translates `ProConsensusModel` → the exact `RunesBlock` shape `runeApplyBody.ts`'s `buildRuneApplyBody()` consumes). Both documented at length in-file re: the "never fabricate a slot" honesty rule.
- `components/hextech/ProConsensusCard.tsx` — two new header buttons (`ApplyProRunesButton`, `AddProItemBuildButton`), new optional `build?: BuildResponse` prop. `CardHeader`'s own `mb-3.5` moved to the row wrapper (single call site, verified via grep) to match RunesSummonersCard's exact header-row spacing convention now that the row holds buttons too.
- `components/hextech/BuildTabContent.tsx` — one-line: passes the already-fetched `build` through to `ProConsensusCard` (no new fetch).
- `components/__tests__/proConsensus.test.ts` — 10 new cases (`missingRunePageReason` x5, `proConsensusRuneApplyInput` x5 incl. a deterministic tie-order regression that reads the model's own count-desc/id-asc sort rather than re-deciding order).

**Key design decision (re-verify if `proConsensus.ts`'s shard model ever changes):** `proConsensusRuneApplyInput` NEVER derives shards from `model.shards` — that breakdown is a flat top-3-by-frequency count with no offense/flex/defense slot label, and real ids (5008 Adaptive Force) are valid in more than one slot, so assigning a bare id to a slot from that data would be inventing structure. It always uses the caller-supplied `fallbackShards` (current WPA build's `ShardSet`) and flags `shardsFromFallback: true`; the button's tooltip says so. If `proConsensus.ts` is ever extended to slot-label shards for soloq-only rows (structurally possible — `lib/pro/extract.ts` writes `[offense, flex, defense]` in order, prostage is always `[]`), this decision should be revisited.

**Verify:** `bash scripts/verify-fix.sh` — tsc/lint/1400 tests/build/SW/manifest all PASS at v0.45.1. Did NOT run a live browser/companion smoke test (no live League client + companion tray app in this environment) — the apply-runes/item-sets click paths are exercised only through the existing pure-logic test suite + the same `companionClient.applyRunes`/`applyItemSetsForBuild` functions RunesSummonersCard already ships with in prod. Flagging this gap explicitly rather than claiming end-to-end verification I didn't do.

