"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PanelHeading — the small-caps label at the top of a dark elevated panel,
// with an optional right-aligned meta slot on the same baseline.
//
// The meta slot is doing real work, not decoration: it is where a section's
// own DENOMINATOR goes. CoachBuild has already shipped one production bug from
// two denominators drifting apart (career games vs. the games we actually
// store, v0.73.1), so a percentage's sample belongs beside the heading of the
// section it governs — not in a grey paragraph at the top of the card, where
// it eats the fold and is read as boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";

export interface PanelHeadingProps {
  children: ReactNode;
  /** Right-aligned, same baseline — sample sizes, counts, "last N games". */
  meta?: ReactNode;
  /** Hairline under the row. On by default. */
  rule?: boolean;
  className?: string;
}

export default function PanelHeading({ children, meta, rule = true, className }: PanelHeadingProps) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 flex-wrap ${
        rule ? "pb-2 border-b border-line" : ""
      } ${className ?? ""}`}
    >
      <p className="text-[10px] tracking-[0.13em] uppercase text-mut font-semibold">{children}</p>
      {meta && <p className="text-[10px] text-mut/85 tabular-nums text-right min-w-0">{meta}</p>}
    </div>
  );
}
