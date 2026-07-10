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

/** Bottom-anchored mini-sheet (per dispatch brief: prefer this over a
 *  hovering popover at 390px) showing an item's icon, name, total gold cost,
 *  and sanitized passive/stat description. Opens INSIDE GameDetailSheet but
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
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Item details — ${name}`}
        className={`absolute inset-x-0 bottom-0 sm:inset-x-auto sm:left-1/2 sm:bottom-10 sm:-translate-x-1/2 sm:w-[380px] max-h-[70vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-panel border-t sm:border border-line shadow-[0_-10px_40px_rgba(0,0,0,0.5)] sm:shadow-[0_20px_60px_rgba(0,0,0,0.6)] transition-[opacity,transform] motion-reduce:transition-none ${
          visible
            ? "opacity-100 translate-y-0 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
            : "opacity-0 translate-y-3 duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
        }`}
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 flex-shrink-0">
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
        <div className="px-4 pb-5 overflow-y-auto">
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
    </div>,
    document.body
  );
}
