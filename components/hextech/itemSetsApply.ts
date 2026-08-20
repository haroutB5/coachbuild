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
import {
  applyItemSets,
  type ApplyItemSetsResult,
  getStatus,
  recordCompanionError,
  type CompanionPort,
} from "@/components/live/companionClient";
import { shouldAutoExport, type AutoApplyGateInput } from "./autoExportShared";

export { type AutoApplyGateInput };

// MUST stay in step with ProConsensusCard's own AGGREGATION_LIMIT/
// PRO_PLAY_FLOOR. This module performs an INDEPENDENT second aggregation for
// the LCU export (see the header), and that independence is exactly how it
// missed the v0.70.0 pro-play starvation fix: the card was corrected to
// limit=200&proMin=100 while this path silently kept limit=100 with no floor,
// so the "Pro build" line the user got IN THEIR SHOP was still ~96% solo
// queue after the card beside it had been fixed. Two copies of one query is
// the defect; until they share a helper, changing one means changing both.
const PRO_CONSENSUS_LIMIT = 200;
const PRO_PLAY_FLOOR = 100;
const OTP_CONSENSUS_LIMIT = 200;

// ── "no data" vs "the query failed" ─────────────────────────────────────────
//
// THE BUG THIS EXISTS TO KILL. Both resolvers below used to end in
// `catch { return null }`, and `buildItemSets` reads `pro: null` / `otp: null`
// as "this champion has no data, omit the block". Those are two completely
// different facts collapsed into one value, and on 2026-08-20 the difference
// was a nine-hour outage nobody noticed: the shared Neon compute quota was
// exhausted, `/api/pros` and `/api/otp` returned 500 (Neon itself answering
// 402 behind them), every export silently dropped its Pro and OTP blocks, and
// the ONLY signal anywhere in the system was the user eventually noticing two
// missing blocks in their shop panel. A database outage is not supposed to be
// indistinguishable from an unpopulated champion.
//
// So resolution is now a two-field answer, and the pair is the whole point:
//
//   { data: <input>, failure: null }  the champion HAS consensus data
//   { data: null,    failure: null }  the champion genuinely has none (the
//                                     sample came back empty, or aggregated
//                                     to nothing) -- a normal, quiet outcome
//   { data: null,    failure: {...} }  WE DO NOT KNOW. The query failed.
//
// User-facing behaviour is deliberately UNCHANGED in all three cases: `data`
// is what the caller feeds `buildItemSets`, a failure still yields a graceful
// export missing one optional block, and nothing here can throw or fail an
// apply. What changes is that the third case now says so out loud -- see
// reportConsensusFailure below.
export type ConsensusSource = "pro" | "otp";

export interface ConsensusFailure {
  /** Which of the two aggregations could not be resolved. */
  source: ConsensusSource;
  /**
   * `http` — a real round trip to our own API came back non-2xx. This is the
   * outage shape: a Neon 402/500 surfaces here as `status: 500` from
   * `/api/pros`, because the route catches the driver error and answers
   * `{error:"Internal server error"}`.
   *
   * `network` — fetch itself threw, or a 2xx body could not be read. The
   * user is offline, or something in front of the API is broken.
   */
  kind: "http" | "network";
  /** Present when `kind === "http"`. The status our own API returned. */
  status?: number;
  /** One line, already safe to write to a log verbatim. */
  message: string;
}

export interface ConsensusResolution {
  data: ProConsensusItemsInput | null;
  failure: ConsensusFailure | null;
}

/** Marker thrown across the `fetch(...).then(...)` boundary purely so the
 *  single catch below can tell a non-2xx status apart from a thrown fetch.
 *  Deliberately not exported: the classification the rest of the app consumes
 *  is `ConsensusFailure`, not this. */
class ConsensusHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const CONSENSUS_ENDPOINT: Record<ConsensusSource, string> = { pro: "/api/pros", otp: "/api/otp" };
const CONSENSUS_LABEL: Record<ConsensusSource, string> = { pro: "Pro build", otp: "OTP build" };

/** Turns a failure into the sentence that goes in a log or a diagnostics
 *  line. It names the block the user LOST, not just the endpoint, because the
 *  whole point is to connect "there is no Pro build block in my shop" to
 *  "/api/pros answered 500" without a human having to know they are the same
 *  event. */
export function consensusFailureLine(failure: ConsensusFailure): string {
  return (
    `${CONSENSUS_LABEL[failure.source]} block OMITTED because the query FAILED, ` +
    `not because this champion has no data: ${failure.message}`
  );
}

/** Two channels, because the two audiences are different and neither one was
 *  getting anything before:
 *
 *    - `console.warn` — the browser console / any headless driver.
 *    - `recordCompanionError` — the v0.43.0 localStorage ring buffer that
 *      /live-setup renders as recent failure history. This is the channel the
 *      USER can reach from the machine they are actually playing on, with no
 *      PowerShell and no log files, which is exactly the constraint that made
 *      the last companion outage so hard to diagnose.
 *
 *  Best-effort and unconditionally swallowed: reporting a failure must never
 *  become a second failure. `recordCompanionError` already guarantees this
 *  internally; the try here also covers a console that has been stubbed away. */
export function reportConsensusFailure(failure: ConsensusFailure): void {
  const line = consensusFailureLine(failure);
  try {
    console.warn(`[itemSetsApply] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    recordCompanionError(
      failure.kind === "http" ? `${failure.source}-consensus-http-${failure.status}` : `${failure.source}-consensus-network`,
      line
    );
  } catch {
    /* ignore */
  }
}

/** The ONE implementation behind both resolvers. Pro and OTP differ only in
 *  which endpoint they read and which query params they send — the frequency
 *  maths, the starter/boots partition and the support-final carve-out are the
 *  same `aggregateProConsensus` in both cases, which is the property that
 *  keeps the exported blocks agreeing with the cards the user just read.
 *  Keeping them as two copies of one body is how the v0.70.0 pro-play
 *  starvation fix landed on one path and not the other (see the
 *  PRO_CONSENSUS_LIMIT comment above); one body, two call sites, no drift.
 *
 *  Never throws. Every exit is a `ConsensusResolution`. */
async function resolveConsensus(
  source: ConsensusSource,
  champ: ChampionRef,
  lane: LaneId,
  patch: string
): Promise<ConsensusResolution> {
  const role = LANE_TO_ROLE_ID[lane];
  const ver = versionFromPatch(patch);
  const url =
    source === "pro"
      ? `${CONSENSUS_ENDPOINT.pro}?championId=${champ.id}&role=${role}&limit=${PRO_CONSENSUS_LIMIT}&proMin=${PRO_PLAY_FLOOR}&source=all`
      : `${CONSENSUS_ENDPOINT.otp}?championId=${champ.id}&role=${role}&limit=${OTP_CONSENSUS_LIMIT}`;

  try {
    const [games, itemMeta] = await Promise.all([
      fetch(url).then(async (res) => {
        if (!res.ok) throw new ConsensusHttpError(res.status);
        const data: ProGamesApiResponse = await res.json();
        return Array.isArray(data?.games) ? data.games : [];
      }),
      // Item metadata degrades to an empty Map rather than failing the whole
      // resolution — it is Data Dragon, not our database, so its absence says
      // nothing about whether consensus data exists.
      getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
    ]);

    const games2 = games as ProGame[];
    // Genuinely empty, NOT a failure. This is the case the old
    // `catch { return null }` was drowning out.
    if (games2.length === 0) return { data: null, failure: null };

    const model = aggregateProConsensus(games2, itemMeta);
    if (model.items.length === 0 && model.boots.length === 0 && model.supportFinals === null) {
      return { data: null, failure: null };
    }

    // The support-final fold-in, identical on both paths and for the same
    // reason: only `top` is added back, because the alternatives are by
    // definition items the player cannot also own, and a 6-item shop line
    // carrying two of them is the exact duplication bug that partition exists
    // to prevent. Merged then re-sorted with this input's documented
    // share-desc / itemId-asc order rather than appended, so the invariant the
    // shape's doc comment states still holds.
    const items = [...model.items, ...(model.supportFinals ? [model.supportFinals.top] : [])].sort((a, b) =>
      b.share !== a.share ? b.share - a.share : a.itemId - b.itemId
    );
    return {
      data: {
        items: items.map((e) => ({ itemId: e.itemId, share: e.share })),
        boots: model.boots.map((e) => ({ itemId: e.itemId, share: e.share })),
      },
      failure: null,
    };
  } catch (err) {
    const failure: ConsensusFailure =
      err instanceof ConsensusHttpError
        ? {
            source,
            kind: "http",
            status: err.status,
            message: `${CONSENSUS_ENDPOINT[source]} returned HTTP ${err.status} for championId=${champ.id} role=${role}`,
          }
        : {
            source,
            kind: "network",
            message:
              `${CONSENSUS_ENDPOINT[source]} was unreachable or sent an unreadable body for ` +
              `championId=${champ.id} role=${role}: ${err instanceof Error ? err.message : String(err)}`,
          };
    reportConsensusFailure(failure);
    return { data: null, failure };
  }
}

/** Failure-aware Pro resolution. Prefer this over
 *  `resolveProConsensusForSets` in any new caller — the thin wrapper below
 *  exists for back-compat and throws the diagnosis away. */
export function resolveProConsensus(champ: ChampionRef, lane: LaneId, patch: string): Promise<ConsensusResolution> {
  return resolveConsensus("pro", champ, lane, patch);
}

/** Failure-aware OTP resolution. See `resolveProConsensus`. */
export function resolveOtpConsensus(champ: ChampionRef, lane: LaneId, patch: string): Promise<ConsensusResolution> {
  return resolveConsensus("otp", champ, lane, patch);
}

/** Back-compat wrapper: Pro consensus reduced to `data | null`, throwing the
 *  failure diagnosis away. Kept because several existing call sites and tests
 *  take this shape, and because a caller that genuinely does not care about
 *  the difference should not be forced to destructure.
 *
 *  New code should call `resolveProConsensus` instead. Anything that decides
 *  whether to WARN, retry, or tell the user something is wrong MUST — a null
 *  from here still cannot distinguish "this champion has no pro data" from
 *  "the database is down", which is the exact collapse that hid the
 *  2026-08-20 outage. The failure is still reported to the console and the
 *  /live-setup ring buffer either way (see reportConsensusFailure), so using
 *  this wrapper loses the branch, not the signal. */
export async function resolveProConsensusForSets(
  champ: ChampionRef,
  lane: LaneId,
  patch: string
): Promise<ProConsensusItemsInput | null> {
  return (await resolveProConsensus(champ, lane, patch)).data;
}

/** The OTP twin of resolveProConsensusForSets (2026-07-28), same back-compat
 *  contract, same caveat: prefer `resolveOtpConsensus`. */
export async function resolveOtpConsensusForSets(
  champ: ChampionRef,
  lane: LaneId,
  patch: string
): Promise<ProConsensusItemsInput | null> {
  return (await resolveOtpConsensus(champ, lane, patch)).data;
}

/** v0.36.0 — item metadata (tags/into/from/purchasable) for
 *  itemSetBody.ts's full-items-only build-line filter AND its themed-line
 *  (Highest WPA/Tanky/Burst) tag classification. Resolved INDEPENDENTLY of
 *  pro-consensus (not just piggybacked on resolveConsensus' internal fetch)
 *  because it's needed even when pro-consensus comes back
 *  null/empty — Core/Buy order/themed lines all depend on it too, not just
 *  Pro. getItemDetailMap is already module-level memoized (itemDetail.ts),
 *  so this and resolveConsensus' own internal call end up
 *  sharing the SAME cached/in-flight promise for the same version — no
 *  duplicate network cost. Degrades to an empty Map on any failure (never
 *  throws) — itemSetBody.ts's isFullItem treats an unknown id as "exclude
 *  from build lines," a deliberate, documented tradeoff (see that
 *  function's own doc comment), never a crash.
 *
 *  Deliberately NOT given the failure-aware treatment the consensus resolvers
 *  got: this reads Data Dragon, not our database, so a miss says nothing about
 *  whether an outage is in progress and would only add noise to the signal
 *  reportConsensusFailure now carries. */
export async function resolveItemMetaForSets(patch: string): Promise<Map<number, ItemDetail>> {
  try {
    return await getItemDetailMap(versionFromPatch(patch));
  } catch {
    return new Map<number, ItemDetail>();
  }
}

/** The ONE call both the manual button and the auto-export effect make:
 *  resolve pro-consensus data + item metadata (both best-effort, in
 *  parallel), build the champ+role set (WPA/Pro/OTP/Hidden gem/Situational as
 *  BLOCKS inside it — see itemSetBody.ts's v0.34.1 header for the
 *  3-sets-to-1-set restructure), POST it.
 *
 *  `buildItemSets` returns EXACTLY ONE set, in `.sets`. For 32 minutes on
 *  2026-08-19 it returned two (the main one plus a standalone `CoachBuild
 *  <champ> <role> Situational`); the user saw both in the shop's set dropdown
 *  and asked for one, so the Situational picks are a block inside the single
 *  set again.
 *
 *  0.114.0 — it also returns `.situational`, the optional per-item WPA deltas
 *  the DESKTOP OVERLAY draws on top of the situational item icons. Purely
 *  decorative: it is passed straight through to the POST body and nothing on
 *  this path branches on it, so an older bridge that ignores the field applies
 *  exactly the same sets. The 0.113.x alternative — one titled block per
 *  situational item, `Situational +4.27` — put the numbers in the shop's own
 *  chrome and took a 5-block set to eleven; the user rejected that shape
 *  ("doesnt look great"), so the row is one block again and the numbers travel
 *  beside it instead of inside it.
 *
 *  `sets` is still passed through WHOLE and must stay that way: the bridge's
 *  merge keeps only the sets in this call and prunes every other
 *  CoachBuild-titled set, so a caller that posted a subset would delete the
 *  rest — and that same prune is what silently removes the orphaned
 *  `... Situational` set left on disk by 0.112.0. Never throws —
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
  /** Optional already-aggregated OTP line from the card being applied. */
  otp?: ProConsensusItemsInput | null;
}): Promise<ApplyItemSetsResult> {
  const [proRes, itemMeta, otpRes] = await Promise.all([
    resolveProConsensus(params.champ, params.lane, params.build.patch),
    resolveItemMetaForSets(params.build.patch),
    // In the SAME Promise.all, not sequentially after it: this runs on a
    // user click and on the champ-select auto-export, where champ select is
    // a 30-second window. Both consensus fetches are independent and both
    // fail soft, so serialising them would only add latency.
    //
    // A caller-supplied `otp` is already-resolved data, so it carries no
    // failure by construction — the card that fetched it did its own error
    // handling before handing it over.
    params.otp === undefined
      ? resolveOtpConsensus(params.champ, params.lane, params.build.patch)
      : Promise.resolve<ConsensusResolution>({ data: params.otp, failure: null }),
  ]);
  const pro = proRes.data;
  const otp = otpRes.data;

  // The third channel for the same signal, and the one that reaches the
  // machine the game is on: a missing block is now ACCOMPANIED ACROSS THE WIRE
  // by the reason it is missing, so `companion.log` can say "no Pro block
  // because /api/pros returned 500" instead of leaving a reader to guess
  // between an outage and a champion nobody has ingested.
  //
  // Same three properties as `situational` above and for the same reasons:
  // OPTIONAL, INERT, and absent-when-empty. It is one more top-level key on a
  // body that is JSON.stringify'd whole, so a bridge that has never heard of
  // it skips it (companion.ps1 reads `.sets`/`.replacePrefix` by name; the
  // desktop deserializes with JsonOptions.Wire, which leaves
  // UnmappedMemberHandling at its default of Skip). There is deliberately NO
  // version gate: a diagnostic that can fail an apply is worse than no
  // diagnostic.
  const diagnostics = [proRes.failure, otpRes.failure]
    .filter((f): f is ConsensusFailure => f !== null)
    .map(consensusFailureLine);

  const { sets, situational } = buildItemSets(params.champ, params.roleLabel, params.build, pro, itemMeta, otp);
  return applyItemSets(params.port, params.session, {
    championId: params.champ.id,
    sets,
    replacePrefix: champScopedReplacePrefix(params.champ),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    // Spread, not assigned: a champion with no situational picks must POST a
    // body with NO `situational` key at all, not `situational: undefined`
    // (which JSON.stringify drops anyway) and never `[]`. Keeping the absence
    // structural here means the one place that decides it is buildItemSets.
    ...(situational ? { situational } : {}),
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
