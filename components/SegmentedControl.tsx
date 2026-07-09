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
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      className="inline-flex p-1 bg-panel2 border border-line rounded-xl gap-1"
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
            className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-all active:scale-95 ${
              active
                ? "bg-teal text-bg shadow-[0_0_8px_rgba(45,212,191,0.4)]"
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
