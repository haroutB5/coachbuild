"use client";

import { useEffect, useState } from "react";
import DetailPopover from "./DetailPopover";
import { itemIconUrl } from "./proAssets";
import { getItemDetail, type ItemDetail } from "./itemDetail";
import { IconWithFallback } from "./IconWithFallback";

interface ItemDetailPopoverProps {
  itemId: number;
  ver: string;
  open: boolean;
  onClose: () => void;
}

/** Item's icon, name, total gold cost, and sanitized passive/stat
 *  description — the chrome (centering, transitions, focus, close button)
 *  lives in the shared DetailPopover shell; this component only owns the
 *  item-data fetch + item-specific header/body layout. */
export default function ItemDetailPopover({ itemId, ver, open, onClose }: ItemDetailPopoverProps) {
  // undefined = loading, null = fetch failed / unknown item, else resolved.
  const [detail, setDetail] = useState<ItemDetail | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDetail(undefined);
    getItemDetail(itemId, ver).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open, itemId, ver]);

  const name = detail?.name ?? `Item #${itemId}`;

  return (
    <DetailPopover
      open={open}
      onClose={onClose}
      ariaLabel={`Item details — ${name}`}
      header={
        <>
          <div className="w-12 h-12 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
            <IconWithFallback
              src={itemIconUrl(itemId, ver)}
              alt={name}
              fallbackGlyph={name}
              className="w-full h-full object-contain"
              size={48}
            />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h3 className="text-[14px] font-bold text-txt leading-tight">{name}</h3>
            {detail && detail.goldTotal > 0 && (
              <p className="text-[11px] text-gold tabular-nums mt-1">{detail.goldTotal.toLocaleString()} gold</p>
            )}
          </div>
        </>
      }
    >
      {detail === undefined ? (
        <p className="text-[11.5px] text-mut italic">Loading…</p>
      ) : detail === null ? (
        <p className="text-[11.5px] text-mut italic">Details unavailable.</p>
      ) : detail.descriptionText ? (
        <p className="text-[12px] text-txt/85 leading-relaxed whitespace-pre-line">{detail.descriptionText}</p>
      ) : (
        <p className="text-[11.5px] text-mut italic">No description available.</p>
      )}
    </DetailPopover>
  );
}
