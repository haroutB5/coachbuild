"use client";

export type HextechTab = "build" | "proBuilds";

interface HextechTabsProps {
  value: HextechTab;
  onChange: (tab: HextechTab) => void;
}

const TABS: { value: HextechTab; label: string }[] = [
  { value: "build", label: "Build" },
  { value: "proBuilds", label: "Pro Builds" },
];

export default function HextechTabs({ value, onChange }: HextechTabsProps) {
  return (
    <div role="tablist" aria-label="Champion view" className="flex gap-6 border-b border-line px-1">
      {TABS.map((tab) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={`relative py-3 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
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
