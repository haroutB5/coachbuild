"use client";

import { useEffect, useRef, useState } from "react";

// ease-out-quint — the "Linear feel" entrance curve used across the app's
// motion language.
function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

/** Animates a number from 0 to `value` on mount/value-change using
 *  requestAnimationFrame (transform/opacity-equivalent — no layout writes
 *  per frame, just a number driving text content). One-shot: does not loop.
 *  Mount itself animates 0 -> value (not just subsequent value changes) —
 *  this hook is only ever used in a client-only, fetch-gated subtree, so
 *  there is no server-rendered value for a from-0 mount animation to
 *  mismatch against.
 *
 *  Respects prefers-reduced-motion — returns the final value immediately
 *  with no animation frames scheduled. Used for the WPA headline numbers
 *  (the app's core stat), per the standing "one tasteful motion touch" rule. */
export function useCountUp(value: number, durationMs = 400): number {
  const [display, setDisplay] = useState(0);
  const prevValue = useRef(0);
  const reduceMotionRef = useRef(false);

  useEffect(() => {
    reduceMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }, []);

  useEffect(() => {
    const from = prevValue.current;
    const to = value;
    prevValue.current = value;

    if (reduceMotionRef.current || from === to) {
      setDisplay(to);
      return;
    }

    let raf = 0;
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = easeOutQuint(t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return display;
}
