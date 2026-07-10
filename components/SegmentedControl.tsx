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
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
}: SegmentedControlProps<T>) {
  const trackClass = size === "sm" ? "p-0.5 gap-0.5" : "p-1 gap-1";
  const btnClass = size === "sm" ? "px-2.5 py-1 text-[11.5px]" : "px-4 py-1.5 text-[13px]";
  return (
    <div
      className={`inline-flex ${trackClass} bg-panel2 border border-line rounded-xl`}
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
            className={`${btnClass} rounded-lg font-semibold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
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
}
