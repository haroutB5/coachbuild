"use client";

import { useRef } from "react";
import { resolveTabKeydown, isTabNavigationKey } from "./tabKeyboard";

// Kept for back-compat: page.tsx's FIXED_TAB and homeSearch.ts's WireMainView
// contract still import this TYPE (not the component below) for the retired
// "/" BUILD/PRO BUILDS mode toggle (v0.51.0, D1) — see app/page.tsx's own
// comment. Untouched by the generalization below.
export type HextechTab = "build" | "proBuilds";

// v0.62.x (mobile BUILD|PRO segmented control, BuildTabContent.tsx): this
// component itself had ZERO render call sites left after D1 retired it (grep-
// verified — only the `HextechTab` type above was still imported anywhere).
// Generalized from a hardcoded build/proBuilds pair to a generic options list
// so BuildTabContent can reuse the SAME role=tablist/tab/aria-selected + gold-
// underline visual language for its own distinct BUILD/PRO pair, instead of
// hand-rolling a second tab primitive. No existing caller broke — there were
// none rendering the old default export, only the type import above.
//
// ── 2026-07-29: KEYBOARD NAVIGATION, because this is no longer touch-only ───
// This control used to be rendered inside a `lg:hidden` wrapper, i.e. it was
// removed from the accessibility tree entirely at exactly the widths where a
// keyboard is most likely to be the input device. It is now the Builds page's
// navigation at EVERY width, so "it has role=tablist" stopped being enough —
// the ARIA Tabs pattern's keyboard contract has to actually be implemented:
//
//   * ROVING TABINDEX. Only the selected tab is in the page tab order
//     (`tabIndex 0`); the others are `-1`. The tablist is therefore ONE stop on
//     the way to the panel, not three. Without this, a keyboard user tabbing
//     down the page walks through every tab before reaching any content — the
//     precise thing the pattern exists to prevent — and it gets worse with each
//     tab added.
//   * ARROWS MOVE, Home/End jump to the ends, both wrapping. Decision logic is
//     in tabKeyboard.ts (pure, unit-tested) because this repo has no JSX render
//     harness; this file only does the DOM half — focus and preventDefault.
//   * SELECTION FOLLOWS FOCUS (automatic activation). Permitted by the pattern
//     when revealing a panel is instantaneous, which it is here: BuildTabContent
//     keeps all panels mounted and toggles `display` only, so arrowing across
//     the tablist cannot fire a fetch or reset a card.
//
// `preventDefault` is called only for keys tabKeyboard says it owns (Left,
// Right, Home, End) — Tab, Enter, Space and the vertical arrows are left to the
// browser, so the control never eats page scrolling.
export interface HextechTabOption<T extends string> {
  value: T;
  label: string;
}

interface HextechTabsProps<T extends string> {
  options: readonly HextechTabOption<T>[];
  value: T;
  onChange: (tab: T) => void;
  ariaLabel: string;
  /** Extra classes on the tablist itself — lets a caller set the strip's own
   *  spacing without this component guessing at its context. */
  className?: string;
}

export default function HextechTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: HextechTabsProps<T>) {
  // One ref per rendered tab button, so a keyboard move can put focus on its
  // destination. Indexed by position, cleared on unmount by React's own ref
  // callback contract.
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!isTabNavigationKey(e.key)) return;
    const next = resolveTabKeydown(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    // Focus first, then select. Both orders work, but focusing first means the
    // destination is already the active element when the panel swap happens,
    // which is what keeps a screen reader announcing the newly selected tab
    // rather than the one being left.
    buttonRefs.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={`flex gap-6 border-b border-line px-1 ${className}`}>
      {options.map((tab, index) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`hextech-tab-${tab.value}`}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            aria-selected={active}
            aria-controls={`hextech-tabpanel-${tab.value}`}
            // Roving tab stop — see the header. The selected tab is the only
            // one reachable with Tab; the rest are reached with the arrows.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            // min-h-[44px] (v0.61.0 touch-target convention, see
            // ApplyRunesButton.tsx) — the original underline-tab padding
            // (py-3 + text-[13px]) landed under 44px tall on its own.
            className={`relative flex items-center min-h-[44px] px-1 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
              active ? "text-txt" : "text-mut hover:text-txt/80"
            }`}
          >
            {tab.label}
            {active && (
              <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-teal rounded-full" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}
