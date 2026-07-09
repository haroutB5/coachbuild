"use client";

import { useEffect, useState } from "react";
import type { ProGame } from "./proGames.types";
import {
  versionFromPatch,
  itemIconUrl,
  spellIconUrl,
  spellName,
  treeIconUrl,
  treeName,
  shardIconUrl,
  shardName,
  resolveRuneDisplay,
  CONSUMABLE_ITEM_IDS,
  type ResolvedRuneDisplay,
} from "./proAssets";

function ImgWithFallback({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  if (!src) return <div className={className} aria-hidden="true" />;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

/** Compute a client-only relative-time string. This section only ever
 *  renders after a client fetch resolves (never during SSR), so there is no
 *  server-rendered timestamp to mismatch against. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatGameLength(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatMinuteStamp(sec: number): string {
  return `${Math.floor(sec / 60)}'`;
}

/** Resolves a rune perk's name + icon asynchronously (shared module-level
 *  cache in proAssets.ts). Degrades to a plain circle with no crash if the
 *  rune bundle fetch fails. */
function RunePerkIcon({
  runeId,
  ver,
  size,
}: {
  runeId: number;
  ver: string;
  size: "lg" | "sm";
}) {
  const [rune, setRune] = useState<ResolvedRuneDisplay | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveRuneDisplay(runeId, ver).then((r) => {
      if (!cancelled) setRune(r);
    });
    return () => {
      cancelled = true;
    };
  }, [runeId, ver]);

  const dim = size === "lg" ? "w-11 h-11" : "w-6 h-6";
  const ring = size === "lg" ? "border-2 border-teal shadow-[0_0_10px_rgba(45,212,191,0.3)]" : "border border-line";

  return (
    <div
      className={`${dim} ${ring} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0`}
      title={rune ? rune.name : `Rune #${runeId}`}
    >
      <ImgWithFallback
        src={rune?.icon ?? ""}
        alt={rune?.name ?? `Rune #${runeId}`}
        className="w-full h-full object-contain"
      />
    </div>
  );
}

function WinLossPill({ win }: { win: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-bold uppercase tracking-[0.5px] ${
        win ? "bg-good/15 text-good border border-good/30" : "bg-bad/15 text-bad border border-bad/30"
      }`}
    >
      {win ? "Win" : "Loss"}
    </span>
  );
}

interface ProGameCardProps {
  game: ProGame;
  /** Absolute champion icon URL, resolved by the parent (proAssets'
   *  getChampionIconMap() in player mode, or the already-selected
   *  ChampionRef.icon in champion mode). Optional — the champion name
   *  always renders regardless, so the card never loses champion identity
   *  even if icon resolution is skipped/fails. */
  championIcon?: string;
  /** Proper display name ("Wukong") — game.championName is Riot's INTERNAL
   *  id name from match-v5 ("MonkeyKing", "FiddleSticks"), which is wrong to
   *  show users. Falls back to the internal name when unresolved. */
  championDisplayName?: string;
}

// Lane the game was actually played in — matters on the "auto" (all-lanes)
// view where the section can mix lanes for the same champion.
const GAME_LANE_LABEL: Record<number, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
};

export default function ProGameCard({ game, championIcon, championDisplayName }: ProGameCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [hideConsumables, setHideConsumables] = useState(true);
  const ver = versionFromPatch(game.patch);
  const detailId = `pro-game-detail-${game.id}`;
  const isProstage = game.source === "prostage";
  // Prostage never ships purchase/skill data, so there's nothing to expand —
  // guard `expanded` itself (not just the toggle button) so a stale true
  // value can never render the panel for this source.
  const showExpandToggle = !isProstage;
  const showDetailPanel = expanded && !isProstage;

  const timeline = hideConsumables
    ? game.purchaseOrder.filter((p) => !CONSUMABLE_ITEM_IDS.has(p.itemId))
    : game.purchaseOrder;

  return (
    <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl overflow-hidden shadow-[0_6px_24px_rgba(0,0,0,0.3)]">
      {/* Header row */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-txt leading-tight">
            {championIcon && (
              <span
                className="w-5 h-5 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                title={championDisplayName ?? game.championName}
              >
                <ImgWithFallback
                  src={championIcon}
                  alt={championDisplayName ?? game.championName}
                  className="w-full h-full object-cover"
                />
              </span>
            )}
            <span className="truncate">{championDisplayName ?? game.championName}</span>
            <span className="text-mut font-normal">·</span>
            <span className="truncate">{game.player.name}</span>
            {game.player.team && (
              <span className="text-mut font-normal text-[11.5px] truncate">{game.player.team}</span>
            )}
          </div>
          <div className="text-[10.5px] text-mut flex items-center gap-1.5 mt-0.5 flex-wrap">
            {isProstage && (
              <span className="inline-flex items-center px-1.5 py-[1px] rounded text-[9px] font-bold uppercase tracking-[0.5px] bg-gold/15 text-gold border border-gold/30">
                Pro Play
              </span>
            )}
            <span className="uppercase tracking-[0.5px]">
              {isProstage ? game.tournament : game.account.region}
            </span>
            {GAME_LANE_LABEL[game.role] && (
              <>
                <span>·</span>
                <span>{GAME_LANE_LABEL[game.role]}</span>
              </>
            )}
            {game.patch && (
              <>
                <span>·</span>
                <span className="tabular-nums">{game.patch}</span>
              </>
            )}
            <span>·</span>
            <span className="tabular-nums">{relativeTime(game.gameCreation)}</span>
            {game.account.riotId && (
              <>
                <span>·</span>
                <span className="truncate max-w-[160px] opacity-75" title={game.account.riotId}>
                  {game.account.riotId}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <WinLossPill win={game.win} />
          <span className="text-[12.5px] font-semibold text-txt tabular-nums">
            {game.kills}/{game.deaths}/{game.assists}
          </span>
          {game.gameDurationSec > 0 && (
            <span className="text-[11px] text-mut tabular-nums">{formatGameLength(game.gameDurationSec)}</span>
          )}
        </div>
      </div>

      {/* Runes + Spells row — hidden entirely when the source carries neither
          (possible on pro-stage rows where Leaguepedia omits rune/spell data),
          so data-less cards don't show a strip of empty rings. */}
      {(game.runes.keystone > 0 || game.spells.some(Boolean)) && (
      <div className="flex items-center gap-4 px-4 py-3 border-b border-dashed border-line flex-wrap">
        {/* Runes */}
        {game.runes.keystone > 0 && (
        <div className="flex items-center gap-1.5">
          <RunePerkIcon runeId={game.runes.keystone} ver={ver} size="lg" />
          <div className="flex items-center gap-1">
            {game.runes.primary.map((id, i) => (
              <RunePerkIcon key={`p-${id}-${i}`} runeId={id} ver={ver} size="sm" />
            ))}
          </div>
          <span className="text-mut mx-0.5">/</span>
          <div
            className="w-6 h-6 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
            title={treeName(game.runes.secondaryTree)}
          >
            <ImgWithFallback
              src={treeIconUrl(game.runes.secondaryTree)}
              alt={treeName(game.runes.secondaryTree)}
              className="w-full h-full object-contain"
            />
          </div>
          <div className="flex items-center gap-1">
            {game.runes.secondary.map((id, i) => (
              <RunePerkIcon key={`s-${id}-${i}`} runeId={id} ver={ver} size="sm" />
            ))}
          </div>
          <div className="flex items-center gap-0.5 ml-1">
            {game.runes.shards.map((id, i) => (
              <div
                key={`shard-${id}-${i}`}
                className="w-4 h-4 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                title={shardName(id)}
              >
                <ImgWithFallback src={shardIconUrl(id)} alt={shardName(id)} className="w-full h-full object-contain" />
              </div>
            ))}
          </div>
        </div>
        )}

        {/* Spells */}
        {game.spells.some(Boolean) && (
        <div className="flex items-center gap-1 ml-auto">
          {game.spells.map((id, i) => (
            <div
              key={`spell-${id}-${i}`}
              className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
              title={spellName(id)}
            >
              <ImgWithFallback src={spellIconUrl(id, ver)} alt={spellName(id)} className="w-full h-full object-contain" />
            </div>
          ))}
        </div>
        )}
      </div>
      )}

      {/* Items row */}
      <div className="flex items-center gap-1.5 px-4 py-3 flex-wrap">
        {game.finalItems.map((id, i) => (
          <div
            key={`item-${id}-${i}`}
            className="w-9 h-9 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
            title={`Item #${id}`}
          >
            <ImgWithFallback src={itemIconUrl(id, ver)} alt={`Item #${id}`} className="w-full h-full object-contain" />
          </div>
        ))}
        {game.trinket && (
          <>
            <span className="w-px h-6 bg-line mx-1" aria-hidden="true" />
            <div
              className="w-9 h-9 rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0"
              title={`Trinket #${game.trinket}`}
            >
              <ImgWithFallback src={itemIconUrl(game.trinket, ver)} alt="Trinket" className="w-full h-full object-contain" />
            </div>
          </>
        )}

        {showExpandToggle && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={detailId}
            className="ml-auto flex items-center gap-1 text-[11px] text-mut hover:text-teal transition-colors px-2 py-1 rounded-md active:scale-95"
          >
            {expanded ? "Hide timeline" : "Show timeline"}
            <span
              className={`inline-block transition-transform duration-200 ease-out motion-reduce:transition-none ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            >
              ▾
            </span>
          </button>
        )}
      </div>

      {/* Expandable detail: purchase order + skill order — no-op for prostage
          (no purchase/skill data exists to show). */}
      {showDetailPanel && (
        <div id={detailId} className="px-4 pb-4 pt-1 border-t border-line/60 bg-black/10">
          <div className="flex items-center justify-between mb-2 mt-2">
            <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold">Purchase Order</p>
            <label className="flex items-center gap-1.5 text-[10.5px] text-mut cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideConsumables}
                onChange={(e) => setHideConsumables(e.target.checked)}
                className="accent-teal w-3 h-3"
              />
              Hide consumables
            </label>
          </div>
          <div className="flex items-end gap-1.5 overflow-x-auto pb-1.5">
            {timeline.length === 0 && (
              <p className="text-[11px] text-mut py-2">No items to show.</p>
            )}
            {timeline.map((p, i) => (
              <div key={`${p.itemId}-${p.ts}-${i}`} className="flex flex-col items-center flex-shrink-0">
                <div
                  className="w-8 h-8 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center"
                  title={`Item #${p.itemId} — ${formatMinuteStamp(p.ts)}`}
                >
                  <ImgWithFallback src={itemIconUrl(p.itemId, ver)} alt={`Item #${p.itemId}`} className="w-full h-full object-contain" />
                </div>
                <span className="text-[9px] text-mut mt-0.5 tabular-nums">{formatMinuteStamp(p.ts)}</span>
              </div>
            ))}
          </div>

          <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold mt-3 mb-2">Skill Order</p>
          <div className="flex items-center gap-1 flex-wrap">
            {game.skillOrder.map((skill, i) => (
              <span
                key={`${skill}-${i}`}
                className={`w-6 h-6 flex items-center justify-center rounded-md text-[10.5px] font-bold tabular-nums ${
                  skill === "R"
                    ? "bg-teal text-[#06231f]"
                    : "bg-panel2 border border-line text-mut"
                }`}
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
