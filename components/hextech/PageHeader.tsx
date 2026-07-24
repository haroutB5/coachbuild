"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PageHeader — shared left-aligned page header (CoachBuild v0.51 redesign wave
// B: mockups 2/6/7/8 all use the SAME convention — a bold title, an inline
// muted description on the same baseline, and an optional right-aligned slot
// (attribution, a refresh pill, etc.) — replacing the pre-wave centered
// `text-3xl ... text-center` header each of /mystats, /movers, /history had
// independently. Extracted here rather than left duplicated 4x so the
// convention can't silently drift between routes.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned slot — e.g. Pro Players' "LEAGUEPEDIA · CC BY-SA"
   *  attribution. Wraps below the title/subtitle on narrow viewports. */
  right?: ReactNode;
  className?: string;
}

export default function PageHeader({ title, subtitle, right, className }: PageHeaderProps) {
  return (
    <header
      className={`pt-8 pb-5 border-b border-line mb-6 flex items-start justify-between gap-4 flex-wrap ${className ?? ""}`}
    >
      <div className="flex items-baseline gap-3 flex-wrap min-w-0">
        <h1 className="text-[22px] sm:text-2xl font-extrabold tracking-[-0.02em] text-txt whitespace-nowrap">
          {title}
        </h1>
        {subtitle && <p className="text-mut text-[13px] min-w-0">{subtitle}</p>}
      </div>
      {right && <div className="flex-shrink-0 text-[11px] text-mut tracking-[0.06em] uppercase">{right}</div>}
    </header>
  );
}
