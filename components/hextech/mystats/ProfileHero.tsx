"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ProfileHero — the /mystats identity band, rebuilt 2026-07-30 against a
// TrackDIFF player-profile reference the user asked to be matched closely.
//
// WHY THIS IS NOT components/hextech/HeroBand. HeroBand is shared with the
// Builds page's FeaturedOtpCard and its geometry is fixed: a rounded-square
// portrait, then eyebrow / title / pill-row in one column. The reference's hero
// is a different composition — a CIRCULAR portrait carrying a live-state ring,
// the name at display size with a rank/region chip on its own line beneath, two
// lines of supporting copy, and an action cluster pinned right. Bending
// HeroBand into both shapes would have meant editing a file the Builds page
// depends on, which is outside this wave's split.
//
// The four-pass background is copied from HeroBand DELIBERATELY, not shared:
// splash -> aurora -> two scrims -> grain, identical constants, so the two
// surfaces still read as one product. HeroBand is the source of truth for those
// values; if its palette moves, move these with it. All four passes are
// `aria-hidden` and none of them animates, so there is nothing here for
// prefers-reduced-motion to reduce.
//
// ── WHAT THE REFERENCE HAS THAT THIS DOES NOT, AND WHY ──────────────────────
// · gold `PRO` chip — CoachBuild has no notion of a pro/verified status for the
//   signed-in user. `lib/pro/**` is a roster of OTHER people. DROPPED.
// · country flag + country name — never collected, nowhere in the schema, and
//   not derivable from a Riot region (EUW is ~30 countries). DROPPED.
// · four square social buttons — no social handles are stored or asked for.
//   The slot is real UI though, so it holds the one real action that belongs
//   there: the on-demand refresh control. One button, same square language.
// · `#1 EUW` ladder-rank chip — the REGION is real and renders; the ladder
//   POSITION is not something this app fetches for the signed-in user, and a
//   "#1" that is actually "we don't know" is the exact defect this page spent
//   last night removing. The chip carries region only, and reserves room for
//   engy's tier/LP without pretending to a ladder placing.
//
// The `LIVE` ring IS real: CompanionProvider already polls the LCU gameflow
// phase app-wide, so `live` here is the client genuinely being in a game (see
// isLiveGamePhase in profileModel.ts — champ select deliberately does not
// count).
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getSplashUrl } from "@/lib/splash";

/** Static fractal-noise tile, rasterised once by the browser and repeated —
 *  no animation, no per-frame cost. Byte-identical to HeroBand's. */
const GRAIN_TILE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23g)'/%3E%3C/svg%3E\")";

const AURORA =
  "radial-gradient(115% 150% at 88% 6%, rgba(200,170,110,0.20) 0%, rgba(200,170,110,0) 58%)," +
  "radial-gradient(95% 130% at 4% 104%, rgba(200,170,110,0.10) 0%, rgba(200,170,110,0) 62%)";

const SCRIM_X =
  "linear-gradient(90deg, rgba(10,13,11,0.97) 0%, rgba(10,13,11,0.92) 44%, rgba(10,13,11,0.58) 78%, rgba(10,13,11,0.74) 100%)";

const SCRIM_Y =
  "linear-gradient(180deg, rgba(10,13,11,0.30) 0%, rgba(10,13,11,0.20) 45%, rgba(10,13,11,0.74) 100%)";

export interface ProfileHeroProps {
  /** ddragon champion key ("Ahri", "MonkeyKing"). Null renders scrim + aurora
   *  alone, which is a finished surface rather than a visible hole. */
  splashKey?: string | null;
  avatarSrc?: string | null;
  avatarAlt?: string;
  avatarGlyph?: string;
  /** Small-caps line above the name. */
  eyebrow?: ReactNode;
  /** The Riot ID, at display size. */
  title: ReactNode;
  /** Chips on their own line under the name — region, and (once engy's field
   *  lands) tier/LP. Reserved even when empty so the band's height never
   *  changes as data arrives; that reservation is what closed this page's
   *  entire CLS budget in the previous ship and it is kept here. */
  chips?: ReactNode;
  /** Up to two short muted lines under the chips. Real copy only — this slot
   *  holds the coverage caveat and the freshness line, not marketing. */
  lines?: ReactNode;
  /** The League client is in a game right now (isLiveGamePhase). */
  live?: boolean;
  /** Right-hand action cluster — square buttons, per the reference. */
  actions?: ReactNode;
  headingLevel?: 1 | 2;
}

export default function ProfileHero({
  splashKey,
  avatarSrc,
  avatarAlt = "",
  avatarGlyph,
  eyebrow,
  title,
  chips,
  lines,
  live = false,
  actions,
  headingLevel = 1,
}: ProfileHeroProps) {
  const splash = splashKey ? getSplashUrl(splashKey) : null;
  const Heading = (headingLevel === 1 ? "h1" : "h2") as "h1" | "h2";

  return (
    <section className="relative overflow-hidden rounded-xl border border-line bg-panel">
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
              // A wrong/unknown ddragon key answers 403, not 404 (lib/splash.ts).
              // Either way the band degrades to the scrim, which is finished.
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

      {/* items-start, not items-center: at 390px the copy lines wrap to two or
          three lines and a centred portrait would drift down the block. */}
      <div className="relative flex items-start gap-4 sm:gap-5 px-4 sm:px-6 py-5 sm:py-6">
        {avatarSrc !== undefined && avatarSrc !== null && (
          <div className="relative flex-shrink-0">
            {/* The ring is a ring, not a border, so turning it red for LIVE
                cannot change the portrait's box size — no reflow when the
                companion connects mid-view. */}
            <span
              className={`relative block w-[64px] h-[64px] sm:w-[88px] sm:h-[88px] rounded-full overflow-hidden bg-black/50 shadow-[0_14px_34px_-16px_rgba(0,0,0,0.95)] ring-2 ${
                live ? "ring-bad" : "ring-teal/55"
              }`}
            >
              <IconWithFallback
                src={avatarSrc}
                alt={avatarAlt}
                fallbackGlyph={avatarGlyph ?? avatarAlt}
                className="w-full h-full object-cover"
                size={88}
              />
            </span>
            {live && (
              // Sits ON the ring's lower edge, per the reference. Colour is not
              // the only carrier — the word LIVE is in the DOM.
              <span className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 inline-flex items-center h-[16px] px-1.5 rounded-full bg-bad text-white text-[8.5px] font-bold uppercase tracking-[0.09em] shadow-[0_2px_8px_-2px_rgba(0,0,0,0.8)]">
                Live
              </span>
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-mut leading-none">{eyebrow}</p>
          )}
          {/* Negative tracking scales with size — the premium tell, and it
              actively hurts legibility below ~20px, so 390px gets less of it. */}
          <Heading className="mt-1.5 text-[22px] sm:text-[30px] font-semibold text-txt leading-[1.08] tracking-[-0.025em] break-words">
            {title}
          </Heading>

          {/*
            TWO chip rows are reserved, not one, and that is a CLS fix rather
            than a spacing preference.

            Every chip here arrives with a CLIENT fetch, so an unreserved row
            grows the band the moment the summary lands and everything below
            jumps. The previous /mystats ship measured that exact growth as the
            page's ENTIRE non-content-arrival CLS (0.103 -> 0) and closed it by
            reserving one row for three pills.

            This hero carries FIVE — region and rank were added alongside the
            existing coverage/W/L/main pills — and at 390px five wrap to two
            lines (measured in the browser, not reasoned about). Reserving one
            row would therefore re-open the very shift that was closed. So the
            box is sized for two rows unconditionally: 20px + 20px + the 6px
            flex gap = 46px, and it is the SAME height whether one chip resolves
            or five. Structurally zero shift, at every width.

            The alternative — dropping chips until they fit one row — trades a
            real fact (this account's rank) for 26px, on a hero the reference
            gives plenty of vertical room to.
          */}
          <div className="mt-2 flex items-start content-start gap-1.5 flex-wrap min-h-[46px]">{chips}</div>

          {lines && <div className="mt-2 space-y-0.5 text-[11.5px] text-mut leading-relaxed">{lines}</div>}
        </div>

        {actions && <div className="flex-shrink-0 flex items-center gap-1.5 self-start">{actions}</div>}
      </div>
    </section>
  );
}
