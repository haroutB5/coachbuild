"use client";

import { useEffect, useState } from "react";

interface IconWithFallbackProps {
  src: string;
  alt: string;
  className?: string;
  /** Text to derive the fallback glyph from (usually the resolved entity
   *  name) — falls back to `alt` when omitted. Only the first character is
   *  used. */
  fallbackGlyph?: string;
}

/**
 * Same job as ProGameCard's `ImgWithFallback` — render an icon, degrade
 * gracefully if the URL 404s/403s — but where that one hides the broken
 * `<img>` (leaving an invisible gap, the exact bug this component was added
 * to fix: a rune/item/spell icon failing silently reads as "nothing
 * rendered," not "this failed"), this one swaps in a bordered glyph tile so
 * a failure is always visible. Used in GameDetailSheet + the detail popovers,
 * and both ImgWithFallback wrappers (ProGameCard, RunePage) delegate here.
 */
export function IconWithFallback({ src, alt, className, fallbackGlyph }: IconWithFallbackProps) {
  const [failed, setFailed] = useState(false);

  // Reset on every `src` change — this component's callers reuse the same
  // element across a changing id (e.g. a tile whose runeId prop updates),
  // and plain `useState` only resets on remount, not on a prop change. A
  // stale `failed=true` from a PREVIOUS src would otherwise show the
  // fallback glyph forever even once a working src comes through.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    const source = (fallbackGlyph || alt || "?").trim();
    const glyph = source.charAt(0).toUpperCase() || "?";
    return (
      <div
        className={`${className ?? ""} flex items-center justify-center bg-panel2 text-mut font-bold text-[13px] select-none`}
        role="img"
        aria-label={alt}
      >
        {glyph}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
