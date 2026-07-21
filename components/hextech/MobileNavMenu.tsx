"use client";

// v0.44.0 (Builds responsive plan §2b) — the collapsed Sidebar's old dotted
// "Pro players · Patch movers · Companion · Draft · My Stats" row (5
// equal-weight cross-route links, sub-44px tap targets) was cramped at
// 390px. This menu moves those links behind a "More" disclosure trigger in
// the mobile top-bar's first row instead of a second cramped row.
//
// Deliberately LOCAL state only — no useSheetBackNav, no window.history
// pushState. A popover disclosure isn't a navigation step (same "popovers
// aren't a nav step" policy BuildTabContent's tap-for-detail popovers follow
// — CLAUDE.md gotcha (p)): wiring this into the back-stack would let an
// innocent open-then-back on this menu consume a back-press meant for the
// page's real navigation history (champion/player/lane trail), corrupting
// it. Outside-click (mousedown on containerRef) + Escape mirror
// SidebarChampionSearch's own field-dropdown pattern exactly (same
// component family, same interaction vocabulary). No useBodyScrollLock —
// this is a small anchored dropdown, not a full-screen sheet.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NAV_LINKS } from "./navLinks";

interface MobileNavMenuProps {
  patch: string | null;
}

export default function MobileNavMenu({ patch }: MobileNavMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More links"
        className="flex items-center gap-1 h-11 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-mut hover:text-txt rounded-lg transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar"
      >
        More
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
        >
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="More links"
          className="absolute z-50 top-full mt-1.5 right-0 w-[200px] bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden"
        >
          <ul className="divide-y divide-line/40">
            {NAV_LINKS.map((link) => (
              <li key={link.href} role="none">
                <Link
                  href={link.href}
                  role="menuitem"
                  onClick={close}
                  className="flex items-center min-h-[44px] px-3.5 py-2.5 text-[12.5px] text-txt hover:bg-panel2/60 transition-colors"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="px-3.5 py-2 border-t border-line text-[10.5px] text-mut tabular-nums">
            Patch {patch ?? "—"}
          </div>
        </div>
      )}
    </div>
  );
}
