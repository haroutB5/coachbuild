"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { itemIconUrl, spellIconUrl, spellName, treeIconUrl, treeName, resolveRuneDisplay } from "@/components/proAssets";
import { getItemNameMap } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import { aggregateProConsensus, type ProConsensusModel } from "./proConsensus";

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
  | { status: "ok"; model: ProConsensusModel }
  | { status: "hidden" }; // N=0 or fetch failed — this card is supplementary, never shows an error box

interface DisplayNames {
  items: Map<number, string>;
  keystone: { name: string; icon: string } | null;
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${name} — built in ${count} of ${denom} pro games`}
      className="flex flex-col items-center text-center w-[72px] flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
      </span>
      <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
      <span className="text-[10.5px] font-bold tabular-nums text-teal">
        {count}/{denom}
      </span>
    </button>
  );
}

export default function ProConsensusCard({ champ, lane, ver, onOpenDetail }: ProConsensusCardProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [names, setNames] = useState<DisplayNames>({ items: new Map(), keystone: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    // v0.27.0 (user request, "pro players seem to build Rocketbelt on
    // Viktor"): a separate, independent fetch from ProBuildsTab's own list —
    // ALWAYS source=all (maximum sample for the frequency count) regardless
    // of whatever All/Solo Queue/Pro Play filter the user has picked for the
    // PRO BUILDS list below; the two are deliberately decoupled.
    fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=${AGGREGATION_LIMIT}&source=all`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`pros fetch ${res.status}`);
        const data: ProGamesApiResponse = await res.json();
        if (cancelled) return;
        const games: ProGame[] = Array.isArray(data?.games) ? data.games : [];
        if (games.length === 0) {
          setState({ status: "hidden" });
          return;
        }
        setState({ status: "ok", model: aggregateProConsensus(games) });
      })
      .catch(() => {
        // Supplementary card — a failed fetch degrades to "not shown" rather
        // than an error box competing with the BUILD tab's real content.
        if (!cancelled) setState({ status: "hidden" });
      });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane]);

  useEffect(() => {
    if (state.status !== "ok") return;
    let cancelled = false;
    const { model } = state;
    (async () => {
      const [itemNames, keystoneDisplay] = await Promise.all([
        getItemNameMap(ver),
        model.keystone ? resolveRuneDisplay(model.keystone.keystoneId, ver) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setNames({
        items: itemNames,
        keystone: keystoneDisplay ? { name: keystoneDisplay.name, icon: keystoneDisplay.icon } : null,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` narrowed above; model identity changes every fetch resolution, which is exactly when a re-resolve is wanted
  }, [state, ver]);

  if (state.status === "loading") return <ConsensusSkeleton />;
  if (state.status === "hidden") return null;

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
              aria-label={`View details for keystone ${names.keystone?.name ?? `rune #${keystone.keystoneId}`} — picked in ${keystone.count} of ${model.runesSampleSize} games with known runes`}
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
                <span className="block text-[10px] text-mut tabular-nums leading-tight">
                  {keystone.count}/{model.runesSampleSize} keystone
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
                <span className="block text-[10px] text-mut tabular-nums leading-tight">
                  {secondaryTree.count}/{model.secondaryTreeSampleSize} secondary
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
                <span className="block text-[10px] text-mut tabular-nums leading-tight">
                  {spellPair.count}/{model.spellSampleSize} spells
                </span>
              </span>
            </div>
          )}
        </div>
        );
      })()}

      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line">{sampleLine}</p>
    </div>
  );
}
