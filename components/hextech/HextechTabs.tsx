"use client";

// Kept for back-compat: page.tsx's FIXED_TAB and homeSearch.ts's WireMainView
// contract still import this TYPE (not the component below) for the retired
// "/" BUILD/PRO BUILDS mode toggle (v0.51.0, D1) — see app/page.tsx's own
// comment. Untouched by the generalization below.
export type HextechTab = "build" | "proBuilds";

// v0.62.x (mobile BUILD|PRO segmented control, BuildTabContent.tsx): this
// component itself had ZERO render call sites left after D1 retired it (grep-
// verified — only the `HextechTab` type above was still imported anywhere).
// Generalized from a hardcoded build/proBuilds pair to a generic options list
// so BuildTabContent can reuse the SAME role=tablist/tab/aria-selected + gold-
// underline visual language for its own distinct BUILD/PRO pair, instead of
// hand-rolling a second tab primitive. No existing caller broke — there were
// none rendering the old default export, only the type import above.
export interface HextechTabOption<T extends string> {
  value: T;
  label: string;
}

interface HextechTabsProps<T extends string> {
  options: HextechTabOption<T>[];
  value: T;
  onChange: (tab: T) => void;
  ariaLabel: string;
}

export default function HextechTabs<T extends string>({ options, value, onChange, ariaLabel }: HextechTabsProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-6 border-b border-line px-1">
      {options.map((tab) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`hextech-tab-${tab.value}`}
            aria-selected={active}
            aria-controls={`hextech-tabpanel-${tab.value}`}
            onClick={() => onChange(tab.value)}
            // min-h-[44px] (v0.61.0 touch-target convention, see
            // ApplyRunesButton.tsx) — the original underline-tab padding
            // (py-3 + text-[13px]) landed under 44px tall on its own.
            className={`relative flex items-center min-h-[44px] px-1 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
              active ? "text-txt" : "text-mut hover:text-txt/80"
            }`}
          >
            {tab.label}
            {active && (
              <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-teal rounded-full" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}
