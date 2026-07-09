"use client";

// Lane filter row for Champion mode on /history. Same visual language as
// RoleSelector but includes an "All" pill (role param 5 = no lane filter on
// /api/pros, per that route's contract), which RoleSelector's build-recommender
// use case never needed.
const LANES: { id: number; label: string }[] = [
  { id: 5, label: "All" },
  { id: 0, label: "Top" },
  { id: 1, label: "Jungle" },
  { id: 2, label: "Mid" },
  { id: 3, label: "Bot" },
  { id: 4, label: "Support" },
];

interface LanePillRowProps {
  value: number;
  onChange: (role: number) => void;
}

export default function LanePillRow({ value, onChange }: LanePillRowProps) {
  return (
    <div className="flex gap-1.5 flex-wrap justify-center" role="group" aria-label="Filter by lane">
      {LANES.map((lane) => {
        const active = value === lane.id;
        return (
          <button
            key={lane.id}
            type="button"
            onClick={() => onChange(lane.id)}
            className={`px-3 py-1 rounded-lg text-[12.5px] font-semibold transition-all border active:scale-95 ${
              active
                ? "bg-teal text-bg border-teal shadow-[0_0_8px_rgba(45,212,191,0.4)]"
                : "bg-panel2 text-mut border-line hover:border-teal-dim hover:text-txt"
            }`}
            aria-pressed={active}
          >
            {lane.label}
          </button>
        );
      })}
    </div>
  );
}
