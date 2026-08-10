"use client";

// Mobile bottom tab bar.
//
// ── 2026-08-10: THREE PAGES HAD NO ENTRANCE ON A PHONE ──────────────────────
// This bar was the ONLY navigation in the DOM below `lg`, and it carried four
// destinations. /draft, /mystats?intent=game-detail and /live-setup were
// therefore unreachable at 390px by any on-screen control — no drawer, no
// hamburger, no overflow. They rendered fine when reached by URL; they simply
// had no door. /live-setup is the companion pairing page and its only entrance
// was the DESKTOP rail's companion card, so a phone user could not pair at all.
//
// The shape chosen is a fifth bar cell, "More", opening a sheet with the three
// remaining destinations. Reasons, in order:
//   · Seven cells in a 390px bar is ~55px each — under the 44px touch target
//     once the label is legible, and the labels ("Post-Game", "Patch Movers")
//     truncate to noise.
//   · The four existing destinations DO NOT MOVE. They are the common path;
//     relocating them to buy room for the rare ones is a bad trade.
//   · A sheet, not a menu: these are page navigations, so they must be real
//     <Link>s that middle-click, long-press and open-in-new-tab like links.
//     `role="menu"` would demand menuitem semantics and steal those.
//
// ACCESSIBILITY CONTRACT — all four of these are load-bearing, do not drop one:
//   · The trigger is a real <button> with the accessible name "More", plus
//     aria-expanded and aria-controls pointing at the sheet.
//   · Focus moves INTO the sheet on open (first link) and RETURNS to the
//     trigger on close, including the Escape and backdrop-tap paths.
//   · Escape closes.
//   · THE BACKDROP IS A SIBLING OF THE SHEET, NEVER AN ANCESTOR. An
//     aria-hidden ancestor removes the whole dialog subtree from the
//     accessibility tree; this codebase has shipped that exact P1 once already
//     (see wiki/gotchas.md, DetailPopover). Both sit as siblings under the
//     <nav>, and the backdrop carries the aria-hidden, not a wrapper.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MOBILE_NAV_ITEMS, MOBILE_OVERFLOW_NAV_ITEMS } from "./navItems";
import { isActiveNav } from "./activeNav";
import NavIcon from "./NavIcon";

const SHEET_ID = "mobile-nav-more-sheet";

const CELL_CLASS =
  "flex min-h-[56px] flex-col items-center justify-center gap-1 text-[10px] font-medium uppercase tracking-[0.03em] transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]";

export default function MobileTabBar() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // One close path for every dismissal (Escape, backdrop, link tap, route
  // change) so focus restoration cannot be forgotten on one of them.
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
    // `setOpen` is listed because React Compiler infers it and refuses to
    // preserve the memoization otherwise (lint error, not a preference).
  }, [setOpen]);

  // Any navigation closes the sheet. The tapped link has already taken focus
  // to the new page, so this path must NOT yank focus back to the trigger.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- route changes are an external event; the sheet must not survive one.
    setOpen(false);
  }, [pathname, search]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
        return;
      }
      // The sheet declares aria-modal, so Tab must not walk out of it — an
      // unenforced aria-modal tells a screen-reader user the rest of the page
      // is inert while the keyboard says otherwise. Cycle within the sheet's
      // own links instead.
      if (event.key !== "Tab") return;
      const links = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
      if (links.length === 0) return;
      const first = links[0];
      const last = links[links.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !sheetRef.current?.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !sheetRef.current?.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Focus the first destination once the sheet is in the tree. Without this a
  // keyboard user activating More is left with focus on a trigger whose panel
  // they cannot reach by Tab in the reading order they expect.
  useEffect(() => {
    if (!open) return;
    sheetRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
  }, [open]);

  const overflowActive = MOBILE_OVERFLOW_NAV_ITEMS.some((item) => isActiveNav(pathname, item.href, search));

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* SIBLING of the sheet below, never its parent — see the header. */}
      {open && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => close(true)}
          className="fixed inset-0 z-0 h-full w-full cursor-default bg-black/60"
        />
      )}

      {open && (
        <div
          ref={sheetRef}
          id={SHEET_ID}
          role="dialog"
          aria-modal="true"
          aria-label="More destinations"
          className="relative z-10 border-t border-[rgba(233,233,237,0.08)] bg-sidebar px-3 pb-2 pt-3"
        >
          <p className="mb-1 px-1 text-[9px] font-medium uppercase tracking-[0.16em] text-txt/[0.38]">More</p>
          <ul className="flex flex-col">
            {MOBILE_OVERFLOW_NAV_ITEMS.map((item) => {
              const active = isActiveNav(pathname, item.href, search);
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => close(false)}
                    className={`flex min-h-[48px] items-center gap-3 rounded-[7px] px-2.5 text-[13px] font-medium transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] ${
                      active ? "bg-teal/[0.14] text-txt" : "text-txt/80 hover:bg-txt/[0.05] hover:text-txt"
                    }`}
                  >
                    <NavIcon iconKey={item.iconKey} className="h-[17px] w-[17px] flex-shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="relative z-10 grid grid-cols-5 border-t border-[rgba(233,233,237,0.08)] bg-sidebar">
        {MOBILE_NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item.href, search);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`${CELL_CLASS} ${active ? "text-accent-400" : "text-txt/50"}`}
            >
              <NavIcon iconKey={item.iconKey} className="w-[18px] h-[18px]" />
              {/* `shortLabel` where the full one does not fit a fifth of a
                  phone — see navItems.ts for the measurements and for why this
                  is not an aria-label override. The desktop rail is unaffected
                  and still reads "Pro Players" / "Patch Movers". */}
              {item.shortLabel ?? item.label}
            </Link>
          );
        })}
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={SHEET_ID}
          aria-haspopup="dialog"
          onClick={() => (open ? close(true) : setOpen(true))}
          // `overflowActive` keeps the bar honest while one of the sheet's own
          // destinations is the current page — otherwise /draft on a phone
          // shows five nav cells and none of them lit.
          className={`${CELL_CLASS} ${open || overflowActive ? "text-accent-400" : "text-txt/50"}`}
        >
          <NavIcon iconKey="more" className="w-[18px] h-[18px]" />
          More
        </button>
      </div>
    </nav>
  );
}
