"use client";

// ─────────────────────────────────────────────────────────────────────────────
// KpiStrip — the shared "3-4 big numbers" band, on a slightly inset elevated
// surface with hairline separators. Second half of the shared visual language
// HeroBand starts (2026-07-29 redesign): the Builds page's FeaturedOtpCard and
// /mystats both render one directly under their hero.
//
// The label sits UNDERNEATH the value, which is the fix for the specific
// defect this redesign was raised over: on the featured card the stat labels
// used to float ABOVE the player's name baseline in a right-aligned <dl>, so
// at 390px the identity block and the numbers read as two unrelated things
// that happened to collide.
//
// Semantics: a real <dl>. Each cell is `<dt>` (label) then `<dd>` (value) then
// an optional second `<dd>` (delta) in DOM order — so a screen reader hears
// "Win rate, 52.6%, up 2.1 points vs last split" — with CSS `order` flipping
// the value above the label visually. Two <dd>s per <dt> is valid: one term,
// two descriptions.
//
// The hairlines are grid GAPS (`gap-px` over a `bg-line` parent), not borders,
// so they land between every pair of cells in both axes without any
// first:/last: bookkeeping when the grid wraps to 2x2 on mobile.
// ─────────────────────────────────────────────────────────────────────────────

import CountUp from "./CountUp";

/**
 * The chip beside a KPI. TWO shapes on purpose:
 *
 *  · `delta` — a REAL signed comparison that exists in the data.
 *  · `unknown` — the comparison is genuinely unavailable, said out loud.
 *
 * There is deliberately no third option of "render nothing". A comparison that
 * cannot be made must LOOK unmade: a `0` or a `0.0pp` here is a confident lie
 * about the user's own record, and silently dropping the chip reflows the row
 * so the strip changes shape depending on how much data an account has. Both
 * shapes occupy the same 17px row.
 */
export type KpiDelta =
  | {
      kind: "delta";
      /** Signed percentage-point difference. */
      pp: number;
      /** What is being compared. Shown on hover and read out to assistive tech
       *  — a bare "+8.3pp" beside a number is a riddle, not a fact. */
      title: string;
    }
  | {
      kind: "unknown";
      /** Short, visibly non-numeric — "Too few games", never "0.0pp". */
      text: string;
      /** The specific reason, for hover + assistive tech. */
      title: string;
    };

export interface KpiItem {
  key: string;
  label: string;
  /** null renders an em dash. An honest absence, never a fabricated 0. */
  value: number | null;
  /** Formats the value (and every count-up frame). Defaults to a rounded int. */
  format?: (n: number) => string;
  /** Non-numeric KPI (a champion name, a "W-L" record). Wins over `value`. */
  text?: string | null;
  valueClassName?: string;
  delta?: KpiDelta | null;
  /** A few words under the chip saying what it compared — "vs last split",
   *  "22g on · 14g off". Lives HERE, per cell, rather than in a shared
   *  paragraph under the strip: a chip is a bare number and the thing that
   *  explains it should sit with it. Keep it under ~18 characters; a KPI cell
   *  is ~101px wide at 390px. Its row is reserved in every cell when any cell
   *  uses it, so an absent note never changes the strip's height. */
  note?: string;
  /** Roll the number up on mount. Off by default — a count-up on a value the
   *  user is comparing against another cell is noise. */
  countUp?: boolean;
}

function DeltaChip({ delta }: { delta: KpiDelta }) {
  if (delta.kind === "unknown") {
    return (
      <span
        title={delta.title}
        className="inline-flex items-center h-[17px] px-1.5 rounded-full border border-line bg-white/[0.04] text-[9.5px] font-semibold text-mut leading-none"
      >
        <span className="sr-only">{delta.title}. </span>
        {delta.text}
      </span>
    );
  }
  const up = delta.pp >= 0;
  return (
    <span
      title={delta.title}
      className={`inline-flex items-center gap-1 h-[17px] px-1.5 rounded-full border text-[9.5px] font-bold tabular-nums leading-none ${
        up ? "border-good/35 bg-good/12 text-good" : "border-bad/35 bg-bad/12 text-bad"
      }`}
    >
      <span aria-hidden="true">{up ? "▲" : "▼"}</span>
      <span className="sr-only">{delta.title}: </span>
      {up ? "+" : ""}
      {delta.pp.toFixed(1)}pp
    </span>
  );
}

export interface KpiStripProps {
  items: KpiItem[];
  /** 3 keeps one row at every width; 4 wraps to 2x2 under `sm`. */
  columns?: 2 | 3 | 4;
  /** Drop the rounding/outer border so the strip can be a slice of a card
   *  that owns its own frame — it keeps a top+bottom hairline instead. */
  flush?: boolean;
  className?: string;
}

const COLUMNS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

export default function KpiStrip({ items, columns = 3, flush = false, className }: KpiStripProps) {
  // One cell carrying a delta (or a note) reserves that row in EVERY cell, so
  // the labels stay on one baseline across the strip instead of stair-stepping,
  // and the strip's height never depends on how much data an account has.
  const anyDelta = items.some((i) => i.delta);
  const anyNote = items.some((i) => i.note);

  return (
    <dl
      className={`grid ${COLUMNS[columns]} gap-px bg-line ${
        flush ? "border-y border-line" : "rounded-xl overflow-hidden border border-line"
      } ${className ?? ""}`}
    >
      {items.map((it) => {
        const fmt = it.format ?? ((n: number) => String(Math.round(n)));
        return (
          <div key={it.key} className="flex flex-col bg-panel2/70 px-2.5 sm:px-4 py-3 sm:py-3.5">
            <dt className="order-2 mt-1.5 text-[9px] sm:text-[9.5px] font-semibold uppercase tracking-[0.09em] text-mut leading-[1.3] min-h-[24px]">
              {it.label}
            </dt>
            <dd
              className={`order-1 text-[21px] sm:text-[26px] font-semibold leading-none tracking-[-0.025em] tabular-nums ${
                it.valueClassName ?? "text-txt"
              }`}
            >
              {it.text != null ? (
                <span className="block truncate">{it.text}</span>
              ) : it.value === null ? (
                <span className="text-mut">&mdash;</span>
              ) : it.countUp ? (
                <CountUp value={it.value} format={fmt} />
              ) : (
                fmt(it.value)
              )}
            </dd>
            {anyDelta && (
              <dd className="order-3 mt-1.5 h-[17px] flex items-center">
                {it.delta ? <DeltaChip delta={it.delta} /> : null}
              </dd>
            )}
            {anyNote && (
              <dd className="order-4 mt-1 min-h-[13px] text-[9px] leading-[1.25] text-mut/75 tabular-nums">
                {it.note ?? ""}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}
