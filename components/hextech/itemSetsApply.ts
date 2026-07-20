// ─────────────────────────────────────────────────────────────────────────────
// itemSetsApply.ts — the ONE shared code path between the manual "Add item
// builds" button (RunesSummonersCard.tsx) and the champ-select-deep-link
// auto-export effect (BuildTabContent.tsx). Both call `applyItemSetsForBuild`
// so there is exactly one implementation of "resolve pro-consensus data,
// build the sets, POST them" — never two copies that could drift.
//
// Pro-consensus resolution lives here (not in the pure components/hextech/
// itemSetBody.ts) because it's genuinely async I/O: pro-consensus items are
// NOT part of the /api/build BuildResponse contract at all — they're a
// separate aggregation over /api/pros (see components/hextech/proConsensus.ts
// + ProConsensusCard.tsx, which performs the exact same fetch independently
// for its own card). Resolving it again here (rather than prop-threading
// ProConsensusCard's already-fetched model down through two different call
// sites with different lifecycles) keeps this module self-contained; the
// cost is one extra /api/pros + item-metadata fetch when the user clicks
// "Add item builds" or a deep-link auto-fires — acceptable for a
// user-triggered or once-per-navigation action, not a hot path.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef, BuildResponse } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { versionFromPatch } from "@/components/proAssets";
import { aggregateProConsensus } from "./proConsensus";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import { buildItemSets, champScopedReplacePrefix, type ProConsensusItemsInput } from "./itemSetBody";
import { applyItemSets, type ApplyItemSetsResult, getStatus, type CompanionPort } from "@/components/live/companionClient";
import { shouldAutoExport, isAutoExportEligibleBuild, type AutoApplyGateInput } from "./autoExportShared";

/** NOTE (v0.35.0 fold-in investigation): isAutoExportEligibleBuild is kept
 *  exported (and its regression tests kept passing) for historical/pinned
 *  documentation of the P1 wrong-champion race it originally fixed
 *  (2026-07-20 audit) — but it is NOT part of the live auto-export decision
 *  chain as of the v1.3.0 rewrite. That race is now closed structurally by
 *  champSelectFollowState.ts's isCompanionDrivenChampion (BuildTabContent's
 *  effect gates on it directly), which needs no `parsed`/URL argument at
 *  all — comparing against `window.location.search` the way this function
 *  does would in fact be WRONG for the v1.3.0 attached-tab live-follow path
 *  (the URL is only ever set once, at the deep-link mount; a later
 *  live-follow-driven champion change never touches it, so a stale
 *  `championId` would silently block every followed champion's export
 *  forever). Confirmed via a repo-wide search: this function has no call
 *  site in components/hextech/BuildTabContent.tsx today. */
export { isAutoExportEligibleBuild, type AutoApplyGateInput };

const PRO_CONSENSUS_LIMIT = 100;

/** Same aggregation ProConsensusCard.tsx performs (GET /api/pros + item
 *  metadata -> aggregateProConsensus), reduced to just the `items`/`boots`
 *  frequency arrays buildItemSets' Pro variant needs. Returns null on ANY
 *  failure (fetch error, empty sample) — the caller then simply omits the
 *  Pro set (buildItemSets already treats `pro: null` as "no Pro variant
 *  this time"), never a thrown error surfacing to the user for what is, at
 *  most, one of three optional variants. */
export async function resolveProConsensusForSets(
  champ: ChampionRef,
  lane: LaneId,
  patch: string
): Promise<ProConsensusItemsInput | null> {
  try {
    const role = LANE_TO_ROLE_ID[lane];
    const ver = versionFromPatch(patch);
    const [games, itemMeta] = await Promise.all([
      fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=${PRO_CONSENSUS_LIMIT}&source=all`).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ProGamesApiResponse = await res.json();
        return Array.isArray(data?.games) ? data.games : [];
      }),
      getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
    ]);
    const games2 = games as ProGame[];
    if (games2.length === 0) return null;
    const model = aggregateProConsensus(games2, itemMeta);
    if (model.items.length === 0 && model.boots.length === 0) return null;
    return {
      items: model.items.map((e) => ({ itemId: e.itemId, share: e.share })),
      boots: model.boots.map((e) => ({ itemId: e.itemId, share: e.share })),
    };
  } catch {
    return null;
  }
}

/** v0.36.0 — item metadata (tags/into/from/purchasable) for
 *  itemSetBody.ts's full-items-only build-line filter AND its themed-line
 *  (Highest WPA/Tanky/Burst) tag classification. Resolved INDEPENDENTLY of
 *  pro-consensus (not just piggybacked on resolveProConsensusForSets'
 *  internal fetch) because it's needed even when pro-consensus comes back
 *  null/empty — Core/Buy order/themed lines all depend on it too, not just
 *  Pro. getItemDetailMap is already module-level memoized (itemDetail.ts),
 *  so this and resolveProConsensusForSets's own internal call end up
 *  sharing the SAME cached/in-flight promise for the same version — no
 *  duplicate network cost. Degrades to an empty Map on any failure (never
 *  throws) — itemSetBody.ts's isFullItem treats an unknown id as "exclude
 *  from build lines," a deliberate, documented tradeoff (see that
 *  function's own doc comment), never a crash. */
export async function resolveItemMetaForSets(patch: string): Promise<Map<number, ItemDetail>> {
  try {
    return await getItemDetailMap(versionFromPatch(patch));
  } catch {
    return new Map<number, ItemDetail>();
  }
}

/** The ONE call both the manual button and the auto-export effect make:
 *  resolve pro-consensus data + item metadata (both best-effort, in
 *  parallel), build the one champ+role set (Core/Buy order/Pro/themed/
 *  Situational as BLOCKS inside it — see itemSetBody.ts's v0.34.1 header
 *  for the 3-sets-to-1-set restructure), POST it. Never throws —
 *  applyItemSets itself is already fail-soft, a failed pro-consensus fetch
 *  just means no Pro build block this round, and a failed item-metadata
 *  fetch degrades the 6-item build lines per isFullItem's own doc comment. */
export async function applyItemSetsForBuild(params: {
  champ: ChampionRef;
  lane: LaneId;
  roleLabel: string;
  build: BuildResponse;
  port: CompanionPort;
  session: string;
}): Promise<ApplyItemSetsResult> {
  const [pro, itemMeta] = await Promise.all([
    resolveProConsensusForSets(params.champ, params.lane, params.build.patch),
    resolveItemMetaForSets(params.build.patch),
  ]);
  const sets = buildItemSets(params.champ, params.roleLabel, params.build, pro, itemMeta);
  return applyItemSets(params.port, params.session, {
    championId: params.champ.id,
    sets,
    replacePrefix: champScopedReplacePrefix(params.champ),
  });
}

// ── Auto-export gate (BuildTabContent's deep-link/live-follow effect) ──────
// Thin wrapper kept for backward compat with existing call sites/tests —
// the real logic now lives in autoExportShared.ts, shared with runes too.
export function shouldAutoApplyItemSets(input: AutoApplyGateInput): boolean {
  return shouldAutoExport(input);
}

export type AutoApplyOutcome =
  | { attempted: false }
  | { attempted: true; result: ApplyItemSetsResult };

/** Full auto-export attempt: gate check -> companion probe (getStatus) ->
 *  applyItemSetsForBuild. The probe is a SEPARATE step from the gate above
 *  (network I/O, can't be a sync pure decision) — "the companion probe
 *  succeeds" per the product ask means a live /status is reachable before
 *  we even try to build/POST sets; a probe failure quietly no-ops (no
 *  toast) rather than surfacing a failure for something the user never
 *  clicked. */
export async function autoApplyItemSetsIfEligible(
  gate: AutoApplyGateInput,
  build: () => Promise<{ champ: ChampionRef; lane: LaneId; roleLabel: string; build: BuildResponse }>,
  deps: { getStatusImpl?: typeof getStatus; applyFn?: typeof applyItemSetsForBuild } = {}
): Promise<AutoApplyOutcome> {
  if (!shouldAutoApplyItemSets(gate)) return { attempted: false };
  const getStatusFn = deps.getStatusImpl ?? getStatus;
  const applyFn = deps.applyFn ?? applyItemSetsForBuild;

  const port = gate.port as CompanionPort;
  const session = gate.session as string;
  const status = await getStatusFn(port, session);
  if (!status) return { attempted: false }; // companion probe failed -- quietly skip, no toast

  const params = await build();
  const result = await applyFn({ ...params, port, session });
  return { attempted: true, result };
}
