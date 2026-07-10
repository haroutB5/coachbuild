// ─────────────────────────────────────────────────────────────────────────────
// focusTrap.ts — shared Tab-key focus trap for GameDetailSheet's own dialog AND
// DetailPopover's dialog. Both are `role="dialog" aria-modal="true"` but
// neither previously stopped Shift+Tab from the first focusable element (or
// Tab from the last) escaping to the page/sheet behind — a real WCAG dialog
// violation flagged by audit, verified live on both.
// ─────────────────────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Call from a `keydown` listener with the dialog's container element. Wraps
 * Tab at the last focusable element back to the first, and Shift+Tab at the
 * first back to the last — a standard modal focus trap. No-op for any key
 * other than Tab, or a container with nothing focusable in it.
 */
export function trapTabKey(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null // skip display:none / hidden elements
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
