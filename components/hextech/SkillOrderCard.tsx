"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID } from "./heroContracts";
import { formatSharePct } from "./proConsensus";
import {
  ABILITY_ROWS,
  LOW_SAMPLE_THRESHOLD,
  fetchSkillOrder,
  formatPriorityString,
  formatSkillOrderSampleLine,
  isDerivedLevel,
  observedLevelCount,
  sortedLevels,
  type Ability,
  type SkillOrderModel,
} from "./skillOrder";

interface SkillOrderCardProps {
  champ: ChampionRef;
  lane: LaneId;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; model: SkillOrderModel }
  | { status: "hidden" } // API returned `null` — no data by design, same
  // "absent, not empty" convention ProConsensusCard's N=0 state established;
  // renders NO card at all, not an empty one.
  | { status: "error"; reason: string };

function CardHeader({ children }: { children: React.ReactNode }) {
  return <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">{children}</p>;
}

function SkillOrderSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse">
      <div className="h-2.5 w-24 bg-panel2 rounded mb-4" />
      <div className="h-5 w-28 bg-panel2 rounded mb-4" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-4 w-full bg-panel2 rounded" />
        ))}
      </div>
    </div>
  );
}

/** One Q/W/E/R row of the skill PATH (not the 18-column timeline grid — see
 *  skillOrder.ts's module header for why these are different features). R is
 *  marked distinctly (solid teal fill) since 6/11/16 are the power-spike
 *  levels — same "R reads as the hero ability" treatment GameDetailSheet's
 *  own SkillGridRow already uses for its filled cells, reused here rather
 *  than invented fresh so the two skill-order surfaces read consistently. */
function AbilityRow({
  ability,
  levels,
  isDerived,
}: {
  ability: Ability;
  levels: number[];
  /** True for a level this app DERIVED rather than the source publishing it.
   *  Rendered as an outline instead of a fill — see the card's footnote. */
  isDerived: (level: number) => boolean;
}) {
  const isUlt = ability === "R";
  const sorted = sortedLevels(levels);
  const derived = sorted.filter(isDerived);
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span
        className={`w-5 flex-shrink-0 text-center text-[11px] font-bold ${isUlt ? "text-teal" : "text-mut"}`}
        aria-hidden="true"
      >
        {ability}
      </span>
      {sorted.length > 0 ? (
        <div
          className="flex flex-wrap gap-1"
          aria-label={
            // The screen-reader label carries the provenance too. A visual-only
            // distinction would tell sighted users the tail is derived and tell
            // everyone else it was measured — which is the fabrication hard
            // rule #4 forbids, just aimed at a subset of the audience.
            `${ability} ranked at level${sorted.length === 1 ? "" : "s"} ${sorted.join(", ")}` +
            (derived.length
              ? `. Level${derived.length === 1 ? "" : "s"} ${derived.join(", ")} derived, not recorded`
              : "")
          }
        >
          {sorted.map((lvl) => (
            <span
              key={lvl}
              className={`inline-flex items-center justify-center min-w-[22px] px-1 py-0.5 rounded-[4px] text-[10.5px] font-semibold tabular-nums leading-none ${
                isDerived(lvl)
                  ? "bg-transparent border border-dashed border-mut/50 text-mut"
                  : isUlt
                    ? "bg-teal text-bg"
                    : "bg-teal-dim/20 border border-teal-dim/60 text-teal-hover"
              }`}
            >
              {lvl}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-[10.5px] text-mut/50" aria-label={`${ability} — no leveling data`}>
          —
        </span>
      )}
    </div>
  );
}

/** "Recommended skill order" card for the Builds page — a RECOMMENDATION
 *  (max-priority string + per-ability path), distinct from GameDetailSheet's
 *  18-column timeline of what happened in one pro game (skillOrderGrid.ts,
 *  untouched by this feature). See skillOrder.ts's module header for the full
 *  rationale (U.GG-derived two-part convention, mobile-first column budget).
 *
 *  `null` payload (API's "no data for this champ+role" — a normal 200) renders
 *  NO card at all, same convention ProConsensusCard's N=0 "hidden" state
 *  already established — never an empty/placeholder card. */
export default function SkillOrderCard({ champ, lane }: SkillOrderCardProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    fetchSkillOrder(champ.id, role).then((result) => {
      if (cancelled) return;
      setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, retryToken]);

  if (state.status === "loading") return <SkillOrderSkeleton />;
  if (state.status === "hidden") return null;
  if (state.status === "error") {
    return (
      <div className="bg-panel border border-line rounded-xl p-5">
        <CardHeader>Skill Order</CardHeader>
        <p className="text-[10.5px] text-mut/50" role="status">
          Skill order data couldn&apos;t load ({state.reason}).{" "}
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              setRetryToken((t) => t + 1);
            }}
            className="underline decoration-dotted underline-offset-2 text-mut/80 hover:text-teal-dim transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal rounded-sm"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  const { model } = state;
  const lowSample = model.sampleSize < LOW_SAMPLE_THRESHOLD;
  // Levels this app derived rather than the source publishing them. One
  // implementation, imported from lib/skillOrderModel.ts (see skillOrder.ts's
  // re-export note) so the card and the desktop overlay cannot disagree about
  // which levels are ours.
  const derivedAt = (level: number) => isDerivedLevel(model, level);
  const hasDerivedTail = model.order.length > observedLevelCount(model);

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <CardHeader>Skill Order</CardHeader>

      {/* Part 1 — skill PRIORITY, the compact max-order string, deliberately
          FIRST (module header: "the thing players actually memorise"). */}
      <p
        className="text-[20px] font-semibold tracking-[-0.01em] text-txt mb-4"
        aria-label={`Skill priority: ${model.priority.join(", then ")}`}
      >
        {formatPriorityString(model.priority)}
      </p>

      {/* Part 2 — skill PATH, one row per ability with the levels it's
          ranked at (NOT an 18-column grid — see module header). */}
      <div className="space-y-0.5">
        {ABILITY_ROWS.map((ability) => (
          <AbilityRow
            key={ability}
            ability={ability}
            levels={model.levels[ability] ?? []}
            isDerived={derivedAt}
          />
        ))}
      </div>

      {/* Honesty requirement — `completed: false` must be VISIBLE, not
          silently hidden: it means levels 16-18 are genuinely unknown rather
          than derived, so the short rows above are the truth, not a data gap
          to apologize for. Never padded to 18 to look tidy (see AbilityRow /
          skillOrder.ts — the levels arrays are rendered exactly as supplied). */}
      {!model.completed && (
        <p className="text-[10.5px] text-gold/70 mt-3 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Only levels 1–15 are confirmed for this sample — 16–18 aren&apos;t recorded.
        </p>
      )}

      {/* The other half of the same honesty requirement, and the one that is
          easy to forget: a COMPLETED order shows all 18 levels, and three of
          them are ours. The dashed chips above already say so visually; this
          says it in words, because a visual convention nobody explained is
          not a disclosure. Deliberately not styled as a warning — a derived
          tail is a legitimate, useful answer, just not a measured one. */}
      {hasDerivedTail && (
        <p className="text-[10.5px] text-mut/70 mt-3">
          {/* Three states, not two. A payload cached before `completionBasis`
              existed carries no basis at all, and the old two-way ternary
              silently called those "levelling path" — naming a provenance we
              do not actually hold, which is the same fabrication the dashed
              chips exist to prevent, just in prose. When we don't know, we say
              only what we do know: these levels are ours, not the source's. */}
          {model.completionBasis === "published"
            ? "Dashed levels are derived from this champion's published max order, not recorded"
            : model.completionBasis === "derived"
              ? "Dashed levels are derived from this champion's levelling path, not recorded"
              : "Dashed levels are derived, not recorded"}
          {" — the source publishes levels 1–15 only."}
        </p>
      )}

      {lowSample && (
        <p className="text-[10.5px] text-gold/70 mt-2 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Low sample size — treat this order with caution.
        </p>
      )}

      {/* Honesty requirement — never present a recommendation without the N
          behind it. Reuses proConsensus.ts's formatSharePct so this card's
          percentages round the exact same way ProConsensusCard's do (whole
          percent, never a decimal) — one house rounding rule, not two. */}
      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line tabular-nums">
        From {formatSkillOrderSampleLine(model, formatSharePct)}
      </p>
    </div>
  );
}
