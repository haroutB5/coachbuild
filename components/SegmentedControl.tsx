"use client";

// Small reusable segmented control — same pill/border visual language as
// RoleSelector, wrapped in a single tinted track. Generic over the option
// value type so it can drive the Player|Champion mode toggle here and be
// reused elsewhere later.
interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** "sm" for compact inline placements (e.g. a filter row next to a section
   *  header) — same visual language, smaller footprint. Default "md". */
  size?: "md" | "sm";
  /** v0.44.0 (Builds responsive plan §2c) — ADDITIVE, default "inline" so
   *  every existing caller (/history, ProBuildsTab, mode toggles) renders
   *  byte-identical to before this prop existed. "scroll" renders the track
   *  as a horizontally-scrollable, snap-scrolling strip with a static
   *  right-edge gradient-fade affordance below the `sm` breakpoint (used by
   *  BuildTabContent's RankBracketSelector, where 7 rank-bracket pills don't
   *  fit one inline row at ≤390px) instead of wrapping or clipping. Native
   *  scroll only — no JS smooth-scroll, so it's reduced-motion-safe by
   *  construction. At `sm+` the fade is hidden and the track behaves like a
   *  normal row once its content fits. */
  layout?: "inline" | "scroll";
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  layout = "inline",
}: SegmentedControlProps<T>) {
  const trackClass = size === "sm" ? "p-0.5 gap-0.5" : "p-1 gap-1";
  const btnClass = size === "sm" ? "min-h-[44px] min-w-[44px] px-2.5 py-1 text-[11.5px] lg:min-h-0 lg:min-w-0" : "min-h-[44px] min-w-[44px] px-4 py-1.5 text-[13px] lg:min-h-0 lg:min-w-0";
  const scroll = layout === "scroll";
  const trackLayoutClass = scroll
    ? "flex w-full overflow-x-auto snap-x scroll-px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    : "inline-flex";

  const track = (
    <div
      className={`${trackLayoutClass} ${trackClass} bg-panel2 border border-line rounded-xl`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`${btnClass}${scroll ? " flex-shrink-0 snap-start whitespace-nowrap" : ""} rounded-lg font-semibold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              active
                ? "bg-teal text-bg shadow-[0_0_8px_rgba(130,219,247,0.4)]"
                : "text-mut hover:text-txt"
            }`}
            aria-pressed={active}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );

  if (!scroll) return track;

  // Wrapper is full-width below `sm` (the scroll strip genuinely needs to
  // claim the row) and content-sized at `sm+` (RankBracketSelector places it
  // inline-right-aligned next to its label there). The fade is a static
  // gradient matching the track's own `bg-panel2` surface — not a page-bg
  // gradient — so it convincingly masks the overflowing pill rather than
  // showing a mismatched-color edge.
  return (
    <div className="relative w-full sm:w-auto">
      {track}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-panel2 to-transparent rounded-r-xl sm:hidden"
      />
    </div>
  );
}
