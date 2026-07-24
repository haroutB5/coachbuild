"use client";

// DraftCompBars — replaces DraftCompRadar.tsx (draft redesign v0.51.0,
// mockup 3's "ENEMY COMP PROFILE" card). Radar chart → 6 labeled horizontal
// bars in a 3x2 grid, per the mockup exactly (CC/Engage/Damage top row,
// Tankiness/Mobility/Utility bottom row). Same data dependency as the retired
// radar: `aggregateEnemyComp` is a pure, static, client-safe lookup
// (lib/draft/compRatings.ts) called directly rather than wired through
// /api/draft/recommend.
//
// Value display: scaleTo100() (lib/draft/compRatings.ts, engo's pinned
// contract addition) converts the curated 0-3 rating average to the 0-100
// scale the mockup shows ("CC 82", "Engage 74", ...). Color = STATE, not
// decoration (craft bar): CC gets a red tint specifically once it reads
// "heavy" (>=60) — the one axis the takeaway copy calls out as a defensive
// concern (Cleanse/Tenacity) — every other axis stays the app's gold accent
// regardless of magnitude.
// NOTE (pinned contract, see HANDOFF-fronty.md): `scaleTo100` is engo's
// addition to lib/draft/compRatings.ts and `deriveTakeaways` lives in the new
// lib/draft/compTakeaways.ts — both part of this wave's pinned contracts.
// Neither exists yet at the time this file was written; `npx tsc --noEmit`
// will report both as missing exports until engo's edit/new-file lands.
import { aggregateEnemyComp, scaleTo100, type CompRatingVector } from "@/lib/draft/compRatings";
import { deriveTakeaways } from "@/lib/draft/compTakeaways";

interface DraftCompBarsProps {
  /** Enemy champion ids currently entered (order-preserved, ≤5 per
   *  MAX_DRAFT_ENEMIES — draftLiveSync.ts). */
  enemyIds: number[];
}

const AXES: { key: keyof CompRatingVector; label: string }[] = [
  { key: "cc", label: "CC" },
  { key: "engage", label: "Engage" },
  { key: "damage", label: "Damage" },
  { key: "tankiness", label: "Tankiness" },
  { key: "mobility", label: "Mobility" },
  { key: "utility", label: "Utility" },
];

function BarRow({ axisKey, label, rawValue }: { axisKey: keyof CompRatingVector; label: string; rawValue: number }) {
  // scaleTo100 already rounds + clamps to [0,100] (lib/draft/compRatings.ts).
  const clamped = scaleTo100(rawValue);
  const isHotCc = axisKey === "cc" && clamped >= 60;

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span
        className={`w-[72px] flex-shrink-0 text-[10.5px] tracking-[0.05em] uppercase font-semibold truncate ${
          isHotCc ? "text-bad" : "text-mut"
        }`}
      >
        {label}
      </span>
      <span className="flex-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
        <span
          className={`block h-full rounded-full ${isHotCc ? "bg-bad" : "bg-teal"}`}
          style={{ width: `${Math.min(100, Math.max(clamped, 2))}%` }}
        />
      </span>
      <span className={`w-7 flex-shrink-0 text-right text-[12px] font-bold tabular-nums ${isHotCc ? "text-bad" : "text-txt"}`}>
        {clamped}
      </span>
    </div>
  );
}

export default function DraftCompBars({ enemyIds }: DraftCompBarsProps) {
  if (enemyIds.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-5">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-1">Enemy Comp Profile</p>
        <p className="text-[11.5px] text-mut/70 py-8 text-center">Add enemies to see their team profile.</p>
      </div>
    );
  }

  const comp = aggregateEnemyComp(enemyIds);
  const takeaways = deriveTakeaways(comp).slice(0, 3);

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3.5">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Enemy Comp Profile</p>
        <p className="text-[10px] text-mut/50 italic whitespace-nowrap">curated kit ratings — not a stat</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-2.5">
        {AXES.map((axis) => (
          <BarRow key={axis.key} axisKey={axis.key} label={axis.label} rawValue={comp[axis.key]} />
        ))}
      </div>

      {comp.estimatedCount > 0 && (
        <p className="text-[10px] text-mut/50 mt-3">
          Some ratings estimated ({comp.estimatedCount} of {enemyIds.length} champions).
        </p>
      )}

      {takeaways.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-line">
          {takeaways.map((t) => {
            const isCcFlag = /\bCC\b/i.test(t) || /heavy cc/i.test(t);
            return (
              <span
                key={t}
                className={`px-2.5 py-1 rounded-full border text-[10.5px] font-medium ${
                  isCcFlag ? "border-bad/50 text-bad" : "border-line-gold text-teal"
                }`}
              >
                {t}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
