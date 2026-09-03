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
 *
 * A single transient failure (flaky CDN edge, offline blip) must not pin the
 * glyph for the session: the image is retried ICON_MAX_ATTEMPTS times before
 * the fallback takes over. A genuinely broken URL costs at most
 * ICON_MAX_ATTEMPTS - 1 extra failed requests, which is negligible next to a
 * permanently wrong tile (2026-09-03: a Stormrazor step rendered as "S" for a
 * whole session off one failed load).
 */
export function IconWithFallback({ src, alt, className, fallbackGlyph, size }: IconWithFallbackProps) {
  const [failed, setFailed] = useState(false);
  const [failedSrc, setFailedSrc] = useState(src);
  const [attempt, setAttempt] = useState(0);

  // Reset on every `src` change — this component's callers reuse the same
  // element across a changing id (e.g. a tile whose runeId prop updates),
  // and plain `useState` only resets on remount, not on a prop change. A
  // stale `failed=true` from a PREVIOUS src would otherwise show the
  // fallback glyph forever even once a working src comes through.
  if (src !== failedSrc) {
    setFailedSrc(src);
    setFailed(false);
    setAttempt(0);
  }

  const handleError = () => {
    if (shouldRetryIconLoad(attempt)) setAttempt(attempt + 1);
    else setFailed(true);
  };

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
      key={`${src}#${attempt}`}
      src={src}
      alt={alt}
      className={className}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={handleError}
    />
  );
}

/** Total load attempts per src before the glyph fallback takes over (the
 *  initial load plus this many retries). Pure so the bound is unit-testable
 *  without a DOM; the component above is the only caller. */
export const ICON_MAX_ATTEMPTS = 3;

export function shouldRetryIconLoad(failedAttempts: number): boolean {
  return failedAttempts < ICON_MAX_ATTEMPTS - 1;
}
