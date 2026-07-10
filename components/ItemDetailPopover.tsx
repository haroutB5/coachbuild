"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { itemIconUrl } from "./proAssets";
import { getItemDetail, type ItemDetail } from "./itemDetail";
import { ImgWithFallback } from "./ProGameCard";

// z-index NOTE: this component does its own createPortal call to
// document.body, so it is a DOM *sibling* of GameDetailSheet's portaled
// panel (z-[100]), not a descendant — a wrapper div's z-index around
// <ItemDetailPopover/> would do nothing. This component's OWN z-index below
// is what has to clear GameDetailSheet's.
const Z = "z-[110]";
const EXIT_MS = 150;

interface ItemDetailPopoverProps {
  itemId: number;
  ver: string;
  open: boolean;
  onClose: () => void;
}

/** Centered overlay dialog (mobile AND desktop — matchday-style, not a
 *  bottom sheet) showing an item's icon, name, total gold cost, and
 *  sanitized passive/stat description. Opens INSIDE GameDetailSheet but
 *  portals independently — see the Z-index note above. */
export default function ItemDetailPopover({ itemId, ver, open, onClose }: ItemDetailPopoverProps) {
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  // undefined = loading, null = fetch failed / unknown item, else resolved.
  const [detail, setDetail] = useState<ItemDetail | null | undefined>(undefined);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  if (!rendered || typeof document === "undefined") return null;

  const name = detail?.name ?? `Item #${itemId}`;

  return createPortal(
    <div className={`fixed inset-0 ${Z}`} role="presentation">
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/60 transition-opacity motion-reduce:transition-none ${
          visible
            ? "opacity-100 duration-150 ease-[cubic-bezier(0.2,0,0,1)]"
            : "opacity-0 duration-100 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
        }`}
      />
      {/* Centering layer: pointer-events-none so its padding "gutter" lets
          clicks fall through to the backdrop above for tap-outside-closes;
          the card re-enables pointer-events on itself. */}
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Item details — ${name}`}
          className={`w-full max-w-sm max-h-[75vh] flex flex-col rounded-2xl bg-panel border border-line shadow-[0_20px_60px_rgba(0,0,0,0.6)] pointer-events-auto transition-[opacity,transform] motion-reduce:transition-none ${
            visible
              ? "opacity-100 scale-100 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
              : "opacity-0 scale-[0.96] duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
          }`}
        >
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 flex-shrink-0">
            <div className="w-12 h-12 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <ImgWithFallback src={itemIconUrl(itemId, ver)} alt={name} className="w-full h-full object-contain" />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="text-[14px] font-bold text-txt leading-tight">{name}</h3>
              {detail && detail.goldTotal > 0 && (
                <p className="text-[11px] text-gold tabular-nums mt-1">{detail.goldTotal.toLocaleString()} gold</p>
              )}
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close item details"
              className="flex items-center justify-center w-9 h-9 -mr-1.5 -mt-1 rounded-md text-mut hover:text-txt hover:bg-panel2 transition-colors active:scale-95 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ×
              </span>
            </button>
          </div>
          <div className="px-5 pb-5 overflow-y-auto">
            {detail === undefined ? (
              <p className="text-[11.5px] text-mut italic">Loading…</p>
            ) : detail === null ? (
              <p className="text-[11.5px] text-mut italic">Details unavailable.</p>
            ) : detail.descriptionText ? (
              <p className="text-[12px] text-txt/85 leading-relaxed whitespace-pre-line">{detail.descriptionText}</p>
            ) : (
              <p className="text-[11.5px] text-mut italic">No description available.</p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
