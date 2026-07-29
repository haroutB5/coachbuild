"use client";

// ─────────────────────────────────────────────────────────────────────────────
// HeroBand — the shared identity header for a PERSON: champion splash art
// bleeding behind a dark scrim, a portrait with a thin gold ring, the name
// large, and rank/region as pill badges instead of a run-on "·" separated line.
//
// One component, two surfaces (2026-07-29 redesign): the Builds page's
// FeaturedOtpCard and /mystats. That is the whole point — before this, the
// featured card's identity block and /mystats' page header were unrelated
// text stacks, and the two surfaces answer the same question ("who is this
// player, and how good are they") with two different visual languages.
//
// The layered background is four flat passes, in this order, all
// `aria-hidden` and all non-animated (nothing here to reduce for
// prefers-reduced-motion):
//   1. splash art, dimmed
//   2. a soft aurora wash — the accent hue only, adapted from React Bits'
//      Soft Aurora as two static CSS radial gradients rather than its WebGL
//      canvas (no dependency, no GPU cost, no reduced-motion guard needed)
//   3. two scrim gradients, weighted toward the text side so the identity
//      block clears contrast against ANY champion's splash, not just the dark
//      ones — the art is never allowed behind the name at readable opacity
//   4. a fixed grain tile at 6%, the "physical surface" tell, inline as a
//      data-URI so it stays self-contained and CSP-safe
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getSplashUrl } from "@/lib/splash";

/** Static fractal-noise tile. `feTurbulence` is rasterised once by the
 *  browser and repeated — no animation, no per-frame cost. */
const GRAIN_TILE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23g)'/%3E%3C/svg%3E\")";

const AURORA =
  "radial-gradient(115% 150% at 88% 6%, rgba(200,170,110,0.20) 0%, rgba(200,170,110,0) 58%)," +
  "radial-gradient(95% 130% at 4% 104%, rgba(200,170,110,0.10) 0%, rgba(200,170,110,0) 62%)";

const SCRIM_X =
  "linear-gradient(90deg, rgba(10,13,11,0.97) 0%, rgba(10,13,11,0.92) 44%, rgba(10,13,11,0.58) 78%, rgba(10,13,11,0.74) 100%)";

const SCRIM_Y =
  "linear-gradient(180deg, rgba(10,13,11,0.30) 0%, rgba(10,13,11,0.20) 45%, rgba(10,13,11,0.74) 100%)";

// ── Pill ────────────────────────────────────────────────────────────────────

export type PillTone = "accent" | "neutral" | "good" | "bad";

const PILL_TONE: Record<PillTone, string> = {
  accent: "border-line-gold bg-teal/12 text-teal",
  neutral: "border-line bg-white/[0.05] text-txt/85",
  good: "border-good/35 bg-good/12 text-good",
  bad: "border-bad/35 bg-bad/12 text-bad",
};

/** Small badge used for rank / region / W-L counts. Fixed height so a row of
 *  them never changes the hero's height as content resolves. */
export function Pill({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: PillTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center h-[20px] px-2 rounded-full border text-[9.5px] font-bold uppercase tracking-[0.07em] whitespace-nowrap tabular-nums ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

// ── HeroBand ────────────────────────────────────────────────────────────────

export interface HeroBandProps {
  /** ddragon champion key ("Ahri", "MonkeyKing") — drives the splash art.
   *  null/absent renders the scrim + aurora alone, which is a complete look
   *  on its own rather than a visible gap. */
  splashKey?: string | null;
  avatarSrc?: string | null;
  avatarAlt?: string;
  avatarGlyph?: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  /** A row of <Pill>s. */
  pills?: ReactNode;
  /** Keep the pill row's height even while `pills` is still empty. Set this on
   *  any hero whose pills arrive with a client fetch: without it the band grows
   *  ~28px the moment the data lands and everything below jumps. Measured on
   *  /mystats 2026-07-29 — that single growth was the page's ENTIRE
   *  non-content-arrival CLS (0.103 -> 0). */
  reservePills?: boolean;
  /** Right-aligned slot — a refresh control, an attribution. */
  right?: ReactNode;
  /** 1 for a page header, 3 inside a card that already sits under an h2. */
  headingLevel?: 1 | 2 | 3;
  /** Drop the rounding/border so the band can be the top slice of a card that
   *  owns its own frame. */
  flush?: boolean;
  className?: string;
}

export default function HeroBand({
  splashKey,
  avatarSrc,
  avatarAlt = "",
  avatarGlyph,
  eyebrow,
  title,
  pills,
  reservePills = false,
  right,
  headingLevel = 2,
  flush = false,
  className,
}: HeroBandProps) {
  const splash = splashKey ? getSplashUrl(splashKey) : null;
  const Heading = (headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2") as "h1" | "h2" | "h3";

  return (
    <section
      className={`relative overflow-hidden bg-panel ${flush ? "" : "rounded-xl border border-line"} ${className ?? ""}`}
    >
      <div className="absolute inset-0" aria-hidden="true">
        {splash && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={splash}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover object-[50%_16%] opacity-60"
            onError={(e) => {
              // A wrong/unknown ddragon key answers 403, not 404 — see
              // lib/splash.ts's header. Either way the band degrades to the
              // scrim, which is a finished surface on its own.
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="absolute inset-0" style={{ background: AURORA }} />
        <div className="absolute inset-0" style={{ background: SCRIM_X }} />
        <div className="absolute inset-0" style={{ background: SCRIM_Y }} />
        <div
          className="absolute inset-0 opacity-[0.06] mix-blend-overlay"
          style={{ backgroundImage: GRAIN_TILE, backgroundSize: "120px 120px" }}
        />
      </div>

      <div className="relative flex items-center gap-3.5 sm:gap-4 px-4 sm:px-5 py-4 sm:py-5 min-h-[92px] sm:min-h-[104px]">
        {avatarSrc !== undefined && avatarSrc !== null && (
          <span className="relative flex-shrink-0 w-[52px] h-[52px] sm:w-[62px] sm:h-[62px] rounded-xl overflow-hidden bg-black/50 ring-1 ring-teal/55 shadow-[0_12px_30px_-14px_rgba(0,0,0,0.95)]">
            <IconWithFallback
              src={avatarSrc}
              alt={avatarAlt}
              fallbackGlyph={avatarGlyph ?? avatarAlt}
              className="w-full h-full object-cover"
              size={62}
            />
          </span>
        )}

        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-mut leading-none">{eyebrow}</p>
          )}
          {/* Negative tracking on the large size only — the premium tell, and
              it actively hurts legibility below ~20px. */}
          <Heading className="mt-1.5 text-[19px] sm:text-[23px] font-semibold text-txt leading-[1.12] tracking-[-0.022em] break-words">
            {title}
          </Heading>
          {(pills || reservePills) && (
            <div className="mt-2 flex items-center gap-1.5 flex-wrap min-h-[20px]">{pills}</div>
          )}
        </div>

        {right && <div className="flex-shrink-0 self-start">{right}</div>}
      </div>
    </section>
  );
}
