"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { itemIconUrl, spellIconUrl, spellName, treeIconUrl, treeName, resolveRuneDisplay, shardIconUrl, shardName } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import { aggregateProConsensus, formatSharePct, type ProConsensusModel, type RuneSlotBreakdown } from "./proConsensus";

// Sample size below which the fraction shown is more noise than signal — the
// card still renders (a real user request, "Rocketbelt shows up a lot," can
// be true off 1-2 games) but with an explicit caution line rather than
// implying the same confidence a 20-game sample would carry.
const LOW_SAMPLE_THRESHOLD = 3;
// Fetched sample size for the aggregation — deliberately larger than PRO
// BUILDS' own list limit (20): this card never renders individual rows, only
// counts, so a bigger sample (backend caps at 100) sharpens the fractions
// without any extra per-row render cost.
const AGGREGATION_LIMIT = 100;

interface ProConsensusCardProps {
  champ: ChampionRef;
  lane: LaneId;
  /** Same icon/data version BuildTabContent already resolved from the BUILD
   *  response's own patch (`versionFromPatch(build.patch)`) — reused here so
   *  this card's icons come from the SAME CDN version as the rest of the tab
   *  instead of triggering a second, possibly-different version resolution. */
  ver: string;
  onOpenDetail: (kind: "item" | EntityKind, id: number) => void;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; model: ProConsensusModel; itemMeta: Map<number, ItemDetail> }
  | { status: "hidden" } // N=0 by design (e.g. Viktor Support) — genuinely nothing to show
  | { status: "error"; reason: string }; // fetch failed — distinct from N=0 (v0.27.2); reason
// surfaces IN the line (v0.27.4) because a live iOS-only persistent failure
// could not be diagnosed from screenshots that all read the same generic text.

interface RuneDisplay {
  name: string;
  icon: string;
}

interface DisplayNames {
  items: Map<number, string>;
  keystone: RuneDisplay | null;
  primaryMinors: Map<number, RuneDisplay>;
  secondaryPicks: Map<number, RuneDisplay>;
}

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">{children}</p>
  );
}

function ConsensusSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse">
      <div className="h-2.5 w-32 bg-panel2 rounded mb-4" />
      <div className="flex gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="w-11 h-11 rounded-lg bg-panel2 flex-shrink-0" />
        ))}
      </div>
    </div>
  );
}

/** Fraction + percentage — "35/39 · 90%", percentage primary (bold/teal),
 *  fraction muted. Shared by every stat row on this card (requirement #1:
 *  every fraction — items, keystone, secondary tree, spells, additional
 *  runes — gets the same treatment). */
function FractionPct({ count, denom, className = "" }: { count: number; denom: number; className?: string }) {
  const pct = denom > 0 ? formatSharePct(count / denom) : "0%";
  return (
    <span className={`tabular-nums ${className}`}>
      <span className="font-bold text-teal">{pct}</span>
      <span className="text-mut/70"> · {count}/{denom}</span>
    </span>
  );
}

function ItemTile({
  itemId,
  count,
  denom,
  name,
  icon,
  onClick,
}: {
  itemId: number;
  count: number;
  denom: number;
  name: string;
  icon: string;
  onClick: () => void;
}) {
  const pct = formatSharePct(denom > 0 ? count / denom : 0);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${name} — built in ${count} of ${denom} pro games (${pct})`}
      className="flex flex-col items-center text-center w-[72px] flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
      </span>
      <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
      <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
      <span className="text-[9.5px] text-mut/70 tabular-nums">{count}/{denom}</span>
    </button>
  );
}

/** Small icon+name+fraction row for a minor rune / secondary pick / shard —
 *  the "additional runes" block (requirement #2). Deliberately smaller than
 *  the keystone row (keystone stays visually prominent per the brief). */
function RuneMiniRow({
  runeId,
  count,
  denom,
  name,
  icon,
  onClick,
}: {
  runeId: number;
  count: number;
  denom: number;
  name: string;
  icon: string;
  onClick: () => void;
}) {
  const pct = formatSharePct(denom > 0 ? count / denom : 0);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${name} — picked in ${count} of ${denom} games (${pct})`}
      className="flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-6 h-6 rounded-full bg-black/25 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={24} />
      </span>
      <span className="text-left">
        <span className="block text-[10.5px] text-txt leading-tight">{name}</span>
        <span className="block text-[9.5px] leading-tight tabular-nums">
          <span className="font-semibold text-teal">{pct}</span>
          <span className="text-mut/60"> · {count}/{denom}</span>
        </span>
      </span>
    </button>
  );
}

/** Honest sub-sample caption for a rune-slot breakdown — "from N games", or
 *  "from N solo-queue games" when the sample is entirely soloq-sourced
 *  (structurally true for shards today, see proConsensus.ts's header), or a
 *  mixed-source split when both are present. Never asserts a source split
 *  the data doesn't actually show. */
function slotSampleNote(breakdown: RuneSlotBreakdown): string {
  const { sampleSize, soloqCount, prostageCount } = breakdown;
  if (sampleSize === 0) return "";
  if (prostageCount === 0 && soloqCount > 0) return `from ${soloqCount} solo-queue game${soloqCount === 1 ? "" : "s"}`;
  if (soloqCount === 0 && prostageCount > 0) return `from ${prostageCount} pro-play game${prostageCount === 1 ? "" : "s"}`;
  return `from ${sampleSize} games (${soloqCount} solo queue, ${prostageCount} pro play)`;
}

export default function ProConsensusCard({ champ, lane, ver, onOpenDetail }: ProConsensusCardProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // v0.27.3 (live user report: the v0.27.2 error line showed up on-device and
  // then STUCK — the fetch only ever re-fired on champion/lane change, so one
  // transient blip parked the error until a full navigation): bumping this
  // token re-runs the fetch effect. Bumped by the tappable retry in the error
  // branch below; the effect itself also auto-retries before ever surfacing
  // the error state.
  const [retryToken, setRetryToken] = useState(0);
  const [names, setNames] = useState<DisplayNames>({
    items: new Map(),
    keystone: null,
    primaryMinors: new Map(),
    secondaryPicks: new Map(),
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    // v0.27.0 (user request, "pro players seem to build Rocketbelt on
    // Viktor"): a separate, independent fetch from ProBuildsTab's own list —
    // ALWAYS source=all (maximum sample for the frequency count) regardless
    // of whatever All/Solo Queue/Pro Play filter the user has picked for the
    // PRO BUILDS list below; the two are deliberately decoupled.
    //
    // v0.27.1: fetched in parallel with the full item-metadata map
    // (into/from/tags/purchasable) — aggregateProConsensus now needs it to
    // filter out mid-build components (Needlessly Large Rod etc.) DURING
    // aggregation, not as a display-only afterthought. getItemDetailMap
    // never throws (degrades to an empty map on failure), so a failed item
    // fetch can't reject this Promise.all — it just means every item gets
    // excluded that round (see isBuildItem's "unknown item -> exclude"
    // default), never that an unverified item slips through.
    const attempt = (attemptsLeft: number) => {
      // v0.27.4: cache-busting param on retries only (first attempt stays the
      // clean URL so normal loads keep any legitimate intermediary caching) —
      // defeats a poisoned SW/edge cache entry along a specific device's path.
      const bust = attemptsLeft < 2 ? `&r=${Date.now()}` : "";
      Promise.all([
        fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=${AGGREGATION_LIMIT}&source=all${bust}`).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: ProGamesApiResponse = await res.json();
          return Array.isArray(data?.games) ? data.games : [];
        }),
        // Belt-and-braces despite getItemDetailMap's own internal catch: the
        // item map must NEVER be able to sink the whole card.
        getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
      ])
        .then(([games, itemMeta]: [ProGame[], Map<number, ItemDetail>]) => {
          if (cancelled) return;
          if (games.length === 0) {
            setState({ status: "hidden" });
            return;
          }
          setState({ status: "ok", model: aggregateProConsensus(games, itemMeta), itemMeta });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // v0.27.3 (live user report): a SINGLE transient failure (network
          // blip, cold /api/pros invocation, the SW's empty-cache fallback
          // right after a deploy) used to park the error line until the next
          // champion change. Auto-retry with backoff first — most blips
          // self-heal within seconds — and only surface the error state once
          // the retries are exhausted. The error line is also tappable now
          // (bumps retryToken) so the user is never told to hard-refresh.
          if (attemptsLeft > 0) {
            window.setTimeout(() => {
              if (!cancelled) attempt(attemptsLeft - 1);
            }, attemptsLeft === 2 ? 1200 : 3500);
            return;
          }
          // v0.27.2: distinct from "hidden" (genuine N=0) — a real, visible,
          // muted signal instead of silent nothing. v0.27.4: carry the reason
          // into the line — "HTTP 500" means the server, "Load failed" /
          // "Failed to fetch" means the device's network/SW layer.
          const reason = err instanceof Error ? err.message : String(err);
          setState({ status: "error", reason: reason.slice(0, 60) });
        });
    };
    attempt(2);
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, ver, retryToken]);

  useEffect(() => {
    if (state.status !== "ok") return;
    let cancelled = false;
    const { model, itemMeta } = state;
    (async () => {
      // Item names are already in itemMeta (same fetch that filtered the
      // items in the first place) — no second item fetch needed. Rune perk
      // names/icons (keystone + the new primary-minor/secondary-pick rows)
      // still need proAssets' CDN rune-map resolution.
      const runeIds = new Set<number>();
      if (model.keystone) runeIds.add(model.keystone.keystoneId);
      model.primaryMinors.entries.forEach((e) => runeIds.add(e.runeId));
      model.secondaryPicks.entries.forEach((e) => runeIds.add(e.runeId));

      const resolved = await Promise.all(Array.from(runeIds).map((id) => resolveRuneDisplay(id, ver)));
      if (cancelled) return;

      const runeDisplay = new Map<number, RuneDisplay>();
      resolved.forEach((r) => runeDisplay.set(r.id, { name: r.name, icon: r.icon }));

      const itemNames = new Map<number, string>();
      itemMeta.forEach((detail, id) => itemNames.set(id, detail.name));

      setNames({
        items: itemNames,
        keystone: model.keystone ? (runeDisplay.get(model.keystone.keystoneId) ?? null) : null,
        primaryMinors: new Map(
          model.primaryMinors.entries.map((e) => [e.runeId, runeDisplay.get(e.runeId) ?? { name: `Rune #${e.runeId}`, icon: "" }])
        ),
        secondaryPicks: new Map(
          model.secondaryPicks.entries.map((e) => [e.runeId, runeDisplay.get(e.runeId) ?? { name: `Rune #${e.runeId}`, icon: "" }])
        ),
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` narrowed above; model identity changes every fetch resolution, which is exactly when a re-resolve is wanted
  }, [state, ver]);

  if (state.status === "loading") return <ConsensusSkeleton />;
  if (state.status === "hidden") return null;
  if (state.status === "error") {
    return (
      <p className="text-[10.5px] text-mut/50 px-0.5" role="status">
        Pro consensus data couldn&apos;t load ({state.reason}).{" "}
        <button
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setRetryToken((t) => t + 1);
          }}
          className="underline decoration-dotted underline-offset-2 text-mut/80 hover:text-teal-dim transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal rounded-sm"
        >
          Retry
        </button>
      </p>
    );
  }

  const { model } = state;
  const lowSample = model.gamesTotal < LOW_SAMPLE_THRESHOLD;

  const sourceNote =
    model.tournaments.soloqCount > 0 && model.tournaments.prostageCount > 0
      ? `${model.tournaments.prostageCount} pro play, ${model.tournaments.soloqCount} solo queue`
      : model.tournaments.prostageCount > 0
        ? "pro play"
        : "solo queue";
  const tournamentNote =
    model.tournaments.names.length > 0
      ? model.tournaments.names.length <= 3
        ? model.tournaments.names.join(", ")
        : `${model.tournaments.names.slice(0, 3).join(", ")} +${model.tournaments.names.length - 3} more`
      : null;
  const sampleLine = `From ${model.gamesTotal} pro game${model.gamesTotal === 1 ? "" : "s"} (${sourceNote}) · fresh window${
    tournamentNote ? ` · ${tournamentNote}` : ""
  }`;

  const hasAdditionalRunes = model.primaryMinors.entries.length > 0 || model.secondaryPicks.entries.length > 0 || model.shards.entries.length > 0;

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <CardHeader>Pro Consensus</CardHeader>
      </div>

      {lowSample && (
        <p className="text-[10.5px] text-gold/70 -mt-2 mb-3.5 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Low sample size — treat these fractions with caution.
        </p>
      )}

      {model.items.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">Items</p>
          {/* flex-wrap, not overflow-x-auto — matches CoreBuildOrderCard/
              SituationalCard's own item-row convention on this tab (no
              horizontal scroll strips anywhere on BUILD), so 6 tiles reflow
              to a second row instead of hiding behind a scrollbar at 390px. */}
          <div className="flex flex-wrap gap-2.5">
            {model.items.map((entry) => (
              <ItemTile
                key={entry.itemId}
                itemId={entry.itemId}
                count={entry.count}
                denom={model.gamesTotal}
                name={names.items.get(entry.itemId) ?? `Item #${entry.itemId}`}
                icon={itemIconUrl(entry.itemId, ver)}
                onClick={() => onOpenDetail("item", entry.itemId)}
              />
            ))}
          </div>
        </div>
      )}

      {(() => {
        // Local consts (not `model.keystone` inline) so TS's null-narrowing
        // survives into the nested onClick closures below — narrowing a
        // property access does NOT persist across a function boundary, only
        // a local const does.
        const keystone = model.keystone;
        const secondaryTree = model.secondaryTree;
        const spellPair = model.spellPair;
        if (!keystone && !secondaryTree && !spellPair) return null;
        return (
        <div className="flex flex-wrap gap-x-6 gap-y-3 mb-1">
          {keystone && (
            <button
              type="button"
              onClick={() => onOpenDetail("rune", keystone.keystoneId)}
              aria-label={`View details for keystone ${names.keystone?.name ?? `rune #${keystone.keystoneId}`} — picked in ${keystone.count} of ${model.runesSampleSize} games with known runes (${formatSharePct(keystone.share)})`}
              className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
            >
              <span className="w-9 h-9 rounded-full bg-black/30 border border-line-gold overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback
                  src={names.keystone?.icon ?? ""}
                  alt={names.keystone?.name ?? "Keystone"}
                  fallbackGlyph={names.keystone?.name}
                  className="w-full h-full object-contain"
                  size={36}
                />
              </span>
              <span className="text-left">
                <span className="block text-[11.5px] text-txt font-medium leading-tight">
                  {names.keystone?.name ?? `Rune #${keystone.keystoneId}`}
                </span>
                <span className="block text-[10px] leading-tight mt-0.5">
                  <FractionPct count={keystone.count} denom={model.runesSampleSize} />
                  <span className="text-mut/60"> keystone</span>
                </span>
              </span>
            </button>
          )}

          {secondaryTree && (
            <div className="flex items-center gap-2">
              <span className="w-9 h-9 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback
                  src={treeIconUrl(secondaryTree.treeId)}
                  alt={treeName(secondaryTree.treeId)}
                  fallbackGlyph={treeName(secondaryTree.treeId)}
                  className="w-full h-full object-contain"
                  size={36}
                />
              </span>
              <span>
                <span className="block text-[11.5px] text-txt font-medium leading-tight">
                  {treeName(secondaryTree.treeId)}
                </span>
                <span className="block text-[10px] leading-tight mt-0.5">
                  <FractionPct count={secondaryTree.count} denom={model.secondaryTreeSampleSize} />
                  <span className="text-mut/60"> secondary</span>
                </span>
              </span>
            </div>
          )}

          {spellPair && (
            <div className="flex items-center gap-2">
              <div className="flex -space-x-1">
                {spellPair.spells.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onOpenDetail("spell", id)}
                    aria-label={`View details for summoner spell ${spellName(id)}`}
                    className="w-8 h-8 rounded-[8px] bg-black/30 border border-line ring-2 ring-panel overflow-hidden flex items-center justify-center flex-shrink-0 focus-visible:outline-none focus-visible:ring-teal active:scale-95 transition-transform"
                  >
                    <IconWithFallback
                      src={spellIconUrl(id, ver)}
                      alt={spellName(id)}
                      fallbackGlyph={spellName(id)}
                      className="w-full h-full object-contain"
                      size={32}
                    />
                  </button>
                ))}
              </div>
              <span>
                <span className="block text-[11.5px] text-txt font-medium leading-tight">
                  {spellPair.spells.map((id) => spellName(id)).join(" + ")}
                </span>
                <span className="block text-[10px] leading-tight mt-0.5">
                  <FractionPct count={spellPair.count} denom={model.spellSampleSize} />
                  <span className="text-mut/60"> spells</span>
                </span>
              </span>
            </div>
          )}
        </div>
        );
      })()}

      {hasAdditionalRunes && (
        <div className="mt-4 pt-3.5 border-t border-line">
          <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2.5">Additional Runes</p>
          <div className="flex flex-col gap-3">
            {model.primaryMinors.entries.length > 0 && (
              <div>
                <p className="text-[9.5px] text-mut/60 mb-1.5">
                  Primary tree minors <span className="text-mut/40">— {slotSampleNote(model.primaryMinors)}</span>
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {model.primaryMinors.entries.map((e) => (
                    <RuneMiniRow
                      key={e.runeId}
                      runeId={e.runeId}
                      count={e.count}
                      denom={model.primaryMinors.sampleSize}
                      name={names.primaryMinors.get(e.runeId)?.name ?? `Rune #${e.runeId}`}
                      icon={names.primaryMinors.get(e.runeId)?.icon ?? ""}
                      onClick={() => onOpenDetail("rune", e.runeId)}
                    />
                  ))}
                </div>
              </div>
            )}

            {model.secondaryPicks.entries.length > 0 && (
              <div>
                <p className="text-[9.5px] text-mut/60 mb-1.5">
                  Secondary picks <span className="text-mut/40">— {slotSampleNote(model.secondaryPicks)}</span>
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {model.secondaryPicks.entries.map((e) => (
                    <RuneMiniRow
                      key={e.runeId}
                      runeId={e.runeId}
                      count={e.count}
                      denom={model.secondaryPicks.sampleSize}
                      name={names.secondaryPicks.get(e.runeId)?.name ?? `Rune #${e.runeId}`}
                      icon={names.secondaryPicks.get(e.runeId)?.icon ?? ""}
                      onClick={() => onOpenDetail("rune", e.runeId)}
                    />
                  ))}
                </div>
              </div>
            )}

            {model.shards.entries.length > 0 && (
              <div>
                <p className="text-[9.5px] text-mut/60 mb-1.5">
                  Shards <span className="text-mut/40">— {slotSampleNote(model.shards)}</span>
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {model.shards.entries.map((e) => (
                    <RuneMiniRow
                      key={e.runeId}
                      runeId={e.runeId}
                      count={e.count}
                      denom={model.shards.sampleSize}
                      name={shardName(e.runeId)}
                      icon={shardIconUrl(e.runeId)}
                      onClick={() => onOpenDetail("shard", e.runeId)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line">{sampleLine}</p>
    </div>
  );
}
