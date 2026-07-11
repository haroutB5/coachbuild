"use client";

import { useEffect, useState } from "react";
import DetailPopover from "./DetailPopover";
import { IconWithFallback } from "./IconWithFallback";
import { resolveRuneDisplay, spellIconUrl, spellName, shardIconUrl, shardName } from "./proAssets";
import { getRuneDetail } from "./runeDetail";
import { getSpellDetail } from "./summonerDetail";
import { SHARD_DETAIL } from "./shardDetail";

export type EntityKind = "rune" | "shard" | "spell";

interface EntityDetailPopoverProps {
  kind: EntityKind;
  id: number;
  ver: string;
  open: boolean;
  onClose: () => void;
}

interface ResolvedEntity {
  name: string;
  icon: string;
  meta?: string; // e.g. "180s cooldown"
  description: string | null; // null = unavailable
}

const KIND_LABEL: Record<EntityKind, string> = {
  rune: "Rune",
  shard: "Stat shard",
  spell: "Summoner spell",
};

/** Rune / stat-shard / summoner-spell tap-to-detail card. Shares
 *  ItemDetailPopover's DetailPopover shell but resolves its data from three
 *  different sources depending on `kind`: runes fetch runesReforged.json
 *  (runeDetail.ts) for description text + proAssets.resolveRuneDisplay for
 *  icon/name (already patched for the coachless bundle's stale icon
 *  entries); shards read the small hardcoded SHARD_DETAIL map (ddragon has
 *  no shard data at all); spells fetch summoner.json (summonerDetail.ts).
 *  Never throws — an unknown id or failed fetch on any path degrades to
 *  "details unavailable", matching ItemDetailPopover's contract. */
export default function EntityDetailPopover({ kind, id, ver, open, onClose }: EntityDetailPopoverProps) {
  // undefined = loading, null = resolved but nothing further to show.
  const [resolved, setResolved] = useState<ResolvedEntity | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResolved(undefined);

    (async () => {
      if (kind === "shard") {
        const d = SHARD_DETAIL[id];
        if (cancelled) return;
        setResolved({
          name: d?.name ?? shardName(id),
          icon: shardIconUrl(id),
          description: d?.statText ?? null,
        });
        return;
      }
      if (kind === "spell") {
        const detail = await getSpellDetail(id, ver);
        if (cancelled) return;
        setResolved({
          name: detail?.name ?? spellName(id),
          icon: spellIconUrl(id, ver),
          meta: detail?.cooldownSec ? `${detail.cooldownSec}s cooldown` : undefined,
          description: detail?.descriptionText || null,
        });
        return;
      }
      // rune
      const [display, detail] = await Promise.all([resolveRuneDisplay(id, ver), getRuneDetail(id, ver)]);
      if (cancelled) return;
      setResolved({
        name: detail?.name ?? display.name,
        icon: display.icon,
        description: detail?.descriptionText || null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [open, kind, id, ver]);

  const fallbackName = kind === "shard" ? shardName(id) : kind === "spell" ? spellName(id) : `Rune #${id}`;
  const name = resolved?.name ?? fallbackName;
  const icon = resolved?.icon ?? "";
  const iconShape = kind === "spell" ? "rounded-[10px]" : "rounded-full";

  return (
    <DetailPopover
      open={open}
      onClose={onClose}
      ariaLabel={`${KIND_LABEL[kind]} details — ${name}`}
      header={
        <>
          <div
            className={`w-12 h-12 ${iconShape} bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0`}
          >
            <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={48} />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h3 className="text-[14px] font-bold text-txt leading-tight">{name}</h3>
            {resolved?.meta && <p className="text-[11px] text-mut tabular-nums mt-1">{resolved.meta}</p>}
          </div>
        </>
      }
    >
      {resolved === undefined ? (
        <p className="text-[11.5px] text-mut italic">Loading…</p>
      ) : resolved.description ? (
        <p className="text-[12px] text-txt/85 leading-relaxed whitespace-pre-line">{resolved.description}</p>
      ) : (
        <p className="text-[11.5px] text-mut italic">Details unavailable.</p>
      )}
    </DetailPopover>
  );
}
