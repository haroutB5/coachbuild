"use client";

import { useState } from "react";

interface IconWithFallbackProps {
  src: string;
  alt: string;
  className?: string;
  /** Text to derive the fallback glyph from (usually the resolved entity
   *  name) — falls back to `alt` when omitted. Only the first character is
   *  used. */
  fallbackGlyph?: string;
  /** Intrinsic pixel size (both width and height — every icon here is a
   *  square box) for the `<img>`'s `width`/`height` attributes. Callers know
   *  their own fixed-size box (e.g. a `w-7 h-7` container -> `size={28}`) —
   *  measured perf audit (v0.18.1, /history) found 0 of 414 icon `<img>`s had
   *  these, so the browser couldn't reserve layout space before decode.
   *  Optional so existing callers keep compiling; new/touched call sites
   *  should always pass it. */
  size?: number;
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
export function IconWithFallback({ src, alt, className, fallbackGlyph, size }: IconWithFallbackProps) {
  const [failed, setFailed] = useState(false);
  const [failedSrc, setFailedSrc] = useState(src);

  // Reset on every `src` change — this component's callers reuse the same
  // element across a changing id (e.g. a tile whose runeId prop updates),
  // and plain `useState` only resets on remount, not on a prop change. A
  // stale `failed=true` from a PREVIOUS src would otherwise show the
  // fallback glyph forever even once a working src comes through.
  if (src !== failedSrc) {
    setFailedSrc(src);
    setFailed(false);
  }

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
    /* eslint-disable-next-line @next/next/no-img-element -- This shared sink accepts arbitrary CDN/data-URI URLs and must retain its onError glyph fallback. */
    <img
      src={src}
      alt={alt}
      className={className}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
