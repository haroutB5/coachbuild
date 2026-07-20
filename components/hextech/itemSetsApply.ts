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
import { buildItemSets, type ProConsensusItemsInput } from "./itemSetBody";
import { applyItemSets, type ApplyItemSetsResult, getStatus, type CompanionPort } from "@/components/live/companionClient";

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

/** The ONE call both the manual button and the auto-export effect make:
 *  resolve pro-consensus data (best-effort), build up to 3 sets, POST them.
 *  Never throws — applyItemSets itself is already fail-soft, and a failed
 *  pro-consensus fetch just means no Pro variant this round. */
export async function applyItemSetsForBuild(params: {
  champ: ChampionRef;
  lane: LaneId;
  roleLabel: string;
  build: BuildResponse;
  port: CompanionPort;
  session: string;
}): Promise<ApplyItemSetsResult> {
  const pro = await resolveProConsensusForSets(params.champ, params.lane, params.build.patch);
  const sets = buildItemSets(params.champ, params.roleLabel, params.build, pro);
  return applyItemSets(params.port, params.session, { championId: params.champ.id, sets });
}

// ── Auto-export gate (BuildTabContent's deep-link effect) ──────────────────

export interface AutoApplyGateInput {
  /** True iff parseLiveDeepLink(window.location.search) returned non-null
   *  for THIS page load — role-less deep links (custom/blind-pick/ARAM)
   *  count too; only championId's presence matters here, not role. */
  isDeepLink: boolean;
  autoEnabled: boolean;
  session: string | null;
  port: number | null;
  /** One-shot guard (a ref in the calling component) — a fresh deep-link
   *  navigation is a genuine new page load (Start-Process opens a new tab),
   *  which remounts the component and resets this to false again; this gate
   *  itself only needs to refuse a SECOND fire within the same mount. */
  alreadyFired: boolean;
}

/** Pure decision of whether the auto-export effect should even ATTEMPT a
 *  companion probe + apply. Kept separate from the async probe/apply
 *  itself so "no session -> never", "toggle off -> never", "not a deep
 *  link -> never", and "already fired this mount -> never" are each
 *  independently unit-testable without mounting React or mocking fetch. */
export function shouldAutoApplyItemSets(input: AutoApplyGateInput): boolean {
  if (input.alreadyFired) return false;
  if (!input.isDeepLink) return false;
  if (!input.autoEnabled) return false;
  if (!input.session || !input.port) return false;
  return true;
}

/** Guards against the wrong-champion race (P1, Fable audit 2026-07-20): a
 *  deep-link tab can render its FIRST successful `build` for a FALLBACK
 *  champion (BuildTabContent's own default, e.g. Viktor) before
 *  app/page.tsx's own /api/champions lookup resolves and swaps in the
 *  actual deep-linked champion. If the caller consumes its one-shot
 *  "already exported this mount" ref against that fallback build, the
 *  real deep-linked champion's export is silently and permanently skipped
 *  for the rest of that tab's life (BuildTabContent re-renders on the
 *  later champion swap, it never remounts — no `key` forces a fresh
 *  instance). Returns false ("not yet eligible — wait for the matching
 *  build, do not consume the ref") only when the URL names a SPECIFIC
 *  championId that doesn't match the build in hand; true when there's no
 *  deep link at all (nothing to race against) or the champion already
 *  matches. */
export function isAutoExportEligibleBuild(parsed: { championId: number } | null, buildChampionId: number): boolean {
  if (!parsed) return true;
  return parsed.championId === buildChampionId;
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
