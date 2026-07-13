"use client";

import { useEffect } from "react";

/**
 * Locks body scroll (iOS-safe: `position:fixed` pinned at the current scroll
 * offset, not plain `overflow:hidden`, which does not stop Safari's
 * rubber-band scroll from bleeding the page behind through underneath an
 * overlay — verified on device) while `active` is true, restoring the prior
 * inline styles AND scroll position on cleanup.
 *
 * Extracted from GameDetailSheet.tsx's inline version of this exact effect
 * so a popover with no enclosing sheet (e.g. the BUILD tab's rune/item
 * detail popovers, which sit directly over normal page scroll rather than
 * over an already-locked sheet) can get the same protection without
 * duplicating the recipe. GameDetailSheet's own inline copy is left as-is
 * (out of scope here, and already battle-tested) — a future consolidation
 * can point it at this hook.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      body.style.paddingRight = prev.paddingRight;
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
