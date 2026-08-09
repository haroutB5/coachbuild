"use client";

import { aggregateEnemyComp, scaleTo100, type CompRatingVector } from "@/lib/draft/compRatings";
import { deriveTakeaways } from "@/lib/draft/compTakeaways";

interface DraftCompBarsProps {
  enemyIds: number[];
}

const AXES: { key: keyof CompRatingVector; label: string }[] = [
  { key: "damage", label: "Damage" },
  { key: "engage", label: "Engage" },
  { key: "cc", label: "Crowd control" },
  { key: "tankiness", label: "Frontline" },
  { key: "mobility", label: "Mobility" },
  { key: "utility", label: "Utility" },
];

function axisTone(axisKey: keyof CompRatingVector, value: number): "bad" | "accent" | "muted" {
  if (value < 25) return "muted";
  if (axisKey === "damage" || axisKey === "engage") return "bad";
  return "accent";
}

function toneClasses(tone: ReturnType<typeof axisTone>): { text: string; fill: string } {
  if (tone === "bad") return { text: "text-bad", fill: "bg-bad" };
  if (tone === "accent") return { text: "text-accent-400", fill: "bg-accent" };
  return { text: "text-txt/[0.45]", fill: "bg-txt/[0.35]" };
}

function archetype(comp: ReturnType<typeof aggregateEnemyComp>): string | null {
  if (comp.engage >= 2.4 && comp.damage >= 2) return "DIVE · DAMAGE-HEAVY";
  if (comp.engage >= 2.4) return "DIVE · ENGAGE";
  if (comp.damage >= 2.2) return "DAMAGE-HEAVY";
  if (comp.utility >= 2.4) return "UTILITY-HEAVY";
  return null;
}

function BarRow({ axisKey, label, rawValue }: { axisKey: keyof CompRatingVector; label: string; rawValue: number }) {
  const value = scaleTo100(rawValue);
  const tone = toneClasses(axisTone(axisKey, value));
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`w-[78px] flex-shrink-0 truncate text-[10px] font-medium uppercase tracking-[0.06em] ${tone.text}`}>{label}</span>
      <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-txt/[0.08]">
        <span className={`block h-full rounded-full ${tone.fill}`} style={{ width: `${Math.max(2, value)}%` }} />
      </span>
      <span className={`w-7 flex-shrink-0 text-right text-[11px] font-semibold tabular-nums ${tone.text}`}>{value}</span>
    </div>
  );
}

export default function DraftCompBars({ enemyIds }: DraftCompBarsProps) {
  if (enemyIds.length === 0) {
    return (
      <section className="rounded-[9px] p-3.5" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }} aria-labelledby="enemy-comp-heading">
        <h2 id="enemy-comp-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">Enemy comp profile</h2>
        <p className="py-8 text-center text-[11px] text-txt/[0.48]">Add enemies to see the team profile.</p>
      </section>
    );
  }

  const comp = aggregateEnemyComp(enemyIds);
  const takeaways = deriveTakeaways(comp).slice(0, 3);
  const archetypeLabel = archetype(comp);

  return (
    <section className="rounded-[9px] p-3.5" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }} aria-labelledby="enemy-comp-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="enemy-comp-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">Enemy comp profile</h2>
          <p className="mt-1 text-[10px] text-txt/[0.34]">Curated kit ratings · not a stat</p>
        </div>
        {archetypeLabel && <span className="rounded-[5px] bg-bad/[0.14] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-bad">{archetypeLabel}</span>}
      </div>

      <div className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
        {AXES.map((axis) => <BarRow key={axis.key} axisKey={axis.key} label={axis.label} rawValue={comp[axis.key]} />)}
      </div>

      {comp.estimatedCount > 0 && <p className="mt-3 text-[10px] text-txt/[0.34]">Some ratings estimated ({comp.estimatedCount} of {enemyIds.length} champions).</p>}

      <div className="mt-4 border-t border-txt/[0.08] pt-3">
        {takeaways.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {takeaways.map((takeaway) => (
              <span key={takeaway} className="rounded-[5px] bg-accent/[0.12] px-2 py-1 text-[10px] font-medium leading-[1.2] text-accent-300">{takeaway}</span>
            ))}
            <span className="rounded-[5px] bg-txt/[0.07] px-2 py-1 text-[10px] font-medium leading-[1.2] text-txt/[0.55]">High ban priority</span>
          </div>
        ) : (
          <span className="rounded-[5px] bg-txt/[0.07] px-2 py-1 text-[10px] font-medium text-txt/[0.55]">High ban priority</span>
        )}
      </div>
    </section>
  );
}
