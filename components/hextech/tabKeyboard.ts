// Keyboard navigation for a horizontal `role="tablist"`, as a pure resolver.
//
// Extracted from HextechTabs.tsx so the rule is unit-testable: this repo has no
// JSX render harness (see CLAUDE.md's test conventions), so a keydown handler
// written inline in the component is testable only through a browser. The
// component keeps the DOM work (focus, event.preventDefault); this owns the
// decision.
//
// WHY IT EXISTS AT ALL (2026-07-29). Until now the Build/Pro/OTP tablist was
// `lg:hidden` — a touch-only control, removed from the a11y tree entirely at
// desktop widths, where a keyboard user was most likely to meet it. Making it
// the navigation at EVERY width means it has to behave like a real tablist:
// WAI-ARIA's Tabs pattern specifies Left/Right to move between tabs and
// Home/End to jump to the ends, with the tab stop roving so the tablist is ONE
// stop in the page's tab order rather than one per tab.
//
// Selection follows focus (automatic activation), which the pattern recommends
// when showing a panel is instantaneous. It is here: all three panels stay
// mounted and only their `display` toggles, so arrowing across the tablist
// cannot fire a fetch or drop a card's state.

/** Keys this resolver acts on. Deliberately NOT ArrowUp/ArrowDown: the tablist
 *  is horizontal, and swallowing vertical arrows would break scrolling for the
 *  keyboard user this whole module is for. */
const HANDLED = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * The index that should become focused+selected, or null to let the key through
 * untouched.
 *
 * Wraps at both ends (Right from the last tab lands on the first), matching the
 * ARIA pattern's recommended behaviour for a tablist without a "tabs are also
 * a sequence" semantic.
 */
export function resolveTabKeydown(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (!HANDLED.has(key)) return null;
  // A caller that hands us an out-of-range index (a stale ref, a list that
  // shrank mid-render) still gets a valid destination rather than NaN.
  const safe = index >= 0 && index < count ? index : 0;
  switch (key) {
    case "ArrowRight":
      return (safe + 1) % count;
    case "ArrowLeft":
      return (safe - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Whether `resolveTabKeydown` will act on this key — for the component's
 *  `preventDefault` decision, so the two can never disagree about which keys
 *  the tablist owns. */
export function isTabNavigationKey(key: string): boolean {
  return HANDLED.has(key);
}
