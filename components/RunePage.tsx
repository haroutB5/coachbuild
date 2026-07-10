"use client";

import type { RunesBlock, Pick as PickType } from "@/lib/types";
import { wpaText, fmtSample, isNegativeHeadlineWpa } from "./StatBadge";
import AnimatedWpa from "./AnimatedWpa";
import { IconWithFallback } from "./IconWithFallback";

// Quiet, dim caution glyph for a low-sample pick — a hint to hover, not an alarm.
function LowSampleFlag({ className = "" }: { className?: string }) {
  return (
    <span
      title="Low sample size — treat this pick with caution"
      aria-label="low sample size"
      className={`text-gold/70 ${className}`}
    >
      ⚠
    </span>
  );
}

function ImgWithFallback({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return <IconWithFallback src={src} alt={alt} className={className} />;
}

interface RuneTileProps {
  pick: PickType;
  isKeystone?: boolean;
  isSmall?: boolean;
}

function RuneTile({ pick, isKeystone, isSmall }: RuneTileProps) {
  const circleBase = isKeystone
    ? "w-16 h-16 border-2 border-teal shadow-[0_0_16px_rgba(130,219,247,0.35)]"
    : isSmall
    ? "w-10 h-10 border border-line"
    : "w-13 h-13 border border-line";

  const tileWidth = isKeystone ? "w-20" : isSmall ? "w-16" : "w-20";
  // Headline keystone with a negative WPA (e.g. Jhin's Fleet Footwork, -0.10 /
  // 295K games) is still the correct adoption-weighted pick — the label just
  // tells the reader why the red number isn't a mistake. Ranking is untouched.
  const showMostPlayed = isKeystone && isNegativeHeadlineWpa(pick.wpa);

  return (
    <div
      className={`${tileWidth} flex flex-col items-center text-center group cursor-default`}
      title={`${pick.name} | WPA: ${wpaText(pick.wpa)} | ${fmtSample(pick.occurrence)} picks`}
    >
      <div
        className={`${circleBase} rounded-full bg-black/30 overflow-hidden flex items-center justify-center relative transition-transform group-hover:scale-105`}
      >
        <ImgWithFallback
          src={pick.icon}
          alt={pick.name}
          className={`object-contain ${isKeystone ? "w-[108%] h-[108%]" : "w-full h-full"}`}
        />
      </div>
      <div className="text-[10.5px] text-txt mt-1.5 leading-tight min-h-[28px] flex items-center justify-center">
        {pick.name}
      </div>
      {showMostPlayed && (
        <div
          className="text-[8px] uppercase tracking-[0.5px] text-mut/80 leading-none mb-0.5"
          title="Most-adopted pick — the popular choice trends slightly negative in this data."
        >
          Most played
        </div>
      )}
      <AnimatedWpa wpa={pick.wpa} className="font-extrabold text-[12px]" />
      <div className="text-[9.5px] text-mut tabular-nums flex items-center justify-center gap-0.5">
        {fmtSample(pick.occurrence)}
        {pick.lowSample && <LowSampleFlag />}
      </div>
    </div>
  );
}

interface ShardTileProps {
  label: string;
  pick: PickType;
}

function ShardTile({ label, pick }: ShardTileProps) {
  return (
    <div
      className="flex flex-col items-center text-center w-16 cursor-default group"
      title={`${pick.name} | WPA: ${wpaText(pick.wpa)} | ${fmtSample(pick.occurrence)} picks`}
    >
      <div className="w-10 h-10 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center transition-transform group-hover:scale-105">
        <ImgWithFallback src={pick.icon} alt={pick.name} className="w-full h-full object-contain" />
      </div>
      <div className="text-[10px] text-mut mt-1 leading-tight">{label}</div>
      <AnimatedWpa wpa={pick.wpa} className="font-extrabold text-[11.5px]" />
    </div>
  );
}

interface TreeHeadProps {
  icon: string;
  name: string;
  label: string;
}

function TreeHead({ icon, name, label }: TreeHeadProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <ImgWithFallback src={icon} alt={name} className="w-6 h-6 flex-shrink-0" />
      <span className="font-bold text-sm text-txt">{name}</span>
      <span className="text-[11.5px] text-mut">{label}</span>
    </div>
  );
}

export default function RunePage({ runes }: { runes: RunesBlock }) {
  const { primaryTree, secondaryTree, keystone, primary, secondary, shards } = runes;

  return (
    <div>
      <p className="text-[11px] tracking-[1.5px] uppercase text-teal font-bold mb-4">Runes</p>
      <div className="flex gap-8 flex-wrap">
        {/* Primary tree */}
        <div className="flex-1 min-w-[260px]">
          <TreeHead icon={primaryTree.icon} name={primaryTree.name} label="primary" />
          <div className="flex flex-wrap gap-2.5 items-end">
            <RuneTile pick={keystone} isKeystone />
            {primary.map((p) => (
              <RuneTile key={p.id} pick={p} />
            ))}
          </div>
        </div>

        {/* Secondary tree + shards */}
        <div className="flex-1 min-w-[200px]">
          <TreeHead icon={secondaryTree.icon} name={secondaryTree.name} label="secondary" />
          <div className="flex flex-wrap gap-2.5 mb-5">
            {secondary.map((p) => (
              <RuneTile key={p.id} pick={p} />
            ))}
          </div>

          {/* Stat shards */}
          <div className="flex items-center gap-1.5 mb-2.5">
            <span className="text-[11px] font-bold text-txt">Stat Shards</span>
          </div>
          <div className="flex gap-2">
            <ShardTile label="Offense" pick={shards.offense} />
            <ShardTile label="Flex" pick={shards.flex} />
            <ShardTile label="Defense" pick={shards.defense} />
          </div>
        </div>
      </div>
    </div>
  );
}
