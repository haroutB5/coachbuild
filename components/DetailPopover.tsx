"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trapTabKey } from "./focusTrap";

// z-index NOTE: this component does its own createPortal call to
// document.body, so it is a DOM *sibling* of GameDetailSheet's portaled
// panel (z-[100]), not a descendant — a wrapper div's z-index around a
// popover using this shell would do nothing. This component's OWN z-index
// below is what has to clear GameDetailSheet's.
const Z = "z-[110]";
const EXIT_MS = 150;

export interface DetailPopoverProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Icon + name (+ optional meta line) row — entity-specific, so the caller
   *  renders it; this shell only owns the chrome (backdrop, centering,
   *  transitions, focus, close button) shared by every tap-to-detail card. */
  header: ReactNode;
  /** Body content — loading / description / "unavailable" states, all
   *  caller-decided so this shell stays entity-agnostic. */
  children: ReactNode;
}

/** Centered overlay dialog (mobile AND desktop — matchday-style, not a
 *  bottom sheet) shared by every "tap an icon for details" card in
 *  GameDetailSheet: items (ItemDetailPopover), runes/shards/summoner spells
 *  (EntityDetailPopover). Extracted from the original ItemDetailPopover so
 *  the mount/exit-transition/focus-management logic exists exactly once. */
export default function DetailPopover({ open, onClose, ariaLabel, header, children }: DetailPopoverProps) {
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when this popover opened (the rune/item/shard/spell
  // tap target in the sheet behind it) — restored once the exit transition
  // finishes. Mirrors GameDetailSheet's own triggerFocusRef pattern exactly.
  const triggerFocusRef = useRef<Element | null>(null);

  // Mount/unmount is decoupled from `open` so the exit transition can
  // actually play before the popover leaves the DOM.
  useEffect(() => {
    if (open) {
      triggerFocusRef.current = document.activeElement;
      setRendered(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => closeButtonRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    if (!rendered && triggerFocusRef.current instanceof HTMLElement) {
      triggerFocusRef.current.focus();
    }
  }, [open, rendered]);

  // Tab trap — Shift+Tab from the close button (the first focusable element
  // here) previously escaped to the sheet behind this popover; Tab past the
  // last focusable element did the same in reverse.
  useEffect(() => {
    if (!rendered) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Tab" && panelRef.current) trapTabKey(panelRef.current, e);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rendered]);

  if (!rendered || typeof document === "undefined") return null;

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
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className={`w-full max-w-sm max-h-[75vh] flex flex-col rounded-2xl bg-panel border border-line shadow-[0_20px_60px_rgba(0,0,0,0.6)] pointer-events-auto transition-[opacity,transform] motion-reduce:transition-none ${
            visible
              ? "opacity-100 scale-100 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
              : "opacity-0 scale-[0.96] duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
          }`}
        >
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 flex-shrink-0">
            {header}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close details"
              className="flex items-center justify-center w-9 h-9 -mr-1.5 -mt-1 rounded-md text-mut hover:text-txt hover:bg-panel2 transition-colors active:scale-95 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ×
              </span>
            </button>
          </div>
          <div className="px-5 pb-5 overflow-y-auto">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
