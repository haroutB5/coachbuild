"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID } from "./heroContracts";
import SkillGrid from "@/components/SkillGrid";
import { formatSharePct } from "./proConsensus";
import {
  LOW_SAMPLE_THRESHOLD,
  buildRecommendedSkillGrid,
  fetchSkillOrder,
  formatPriorityString,
  formatSkillOrderSampleLine,
  hasDerivedTail,
  inferredTailRange,
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

/** "Recommended skill order" card for the Builds page — a RECOMMENDATION
 *  (max-priority string + the classic 18-column skill grid).
 *
 *  ── Two things changed here on 2026-07-29, both by user directive ─────────
 *  1. The per-ability level lists ("Q  2 4 5 7 9") became THE GRID, the same
 *     primitive GameDetailSheet renders (components/SkillGrid.tsx). This file
 *     used to carry a rationale for why a grid was wrong on a phone-first app;
 *     that rationale is gone because the decision is reversed, and the mobile
 *     concern is answered by `minmax(0, 1fr)` tracks rather than by avoiding
 *     the grid.
 *  2. The grid always renders all 18 levels. Where lib/skillOrderModel.ts's
 *     arithmetic resolves 16-18 it always did; where it REFUSES, the tail is
 *     now inferred from the champion's published max-priority order and marked
 *     as inferred — dashed chips plus a plain caption below. It is still not
 *     presented as measured, which is the line hard rule #4 draws.
 *
 *  Same primitive as the per-game grid, different FILL RULE: a game that ended
 *  at level 16 shows 16 there, because that is a record of something that
 *  happened. A recommendation answers the whole game.
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
  // One implementation of "which levels are ours", imported rather than
  // reimplemented (see skillOrder.ts's re-export note) so the card, the grid
  // and the desktop overlay cannot disagree about it.
  const grid = buildRecommendedSkillGrid(model);
  const derivedTail = hasDerivedTail(model);
  const inferred = inferredTailRange(model);
  // The genuinely-unknown case: the derivation refused AND the inference could
  // not fill the gap either (the priority named nothing left under a cap), so
  // the tail columns are empty. Rare, and it must still be said out loud.
  const knownLevels = model.order.length + (model.inferredTail?.length ?? 0);
  const incompleteGrid = knownLevels < 18;

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

      {/* Part 2 — THE GRID. 18 columns always: a recommendation answers the
          whole game. `max-w` caps how big the cells get on a wide desktop so
          it reads as a compact chart rather than 18 giant squares; on a 390px
          phone the 1fr tracks shrink to fit and the page gains no horizontal
          scroll (see SkillGrid.tsx's header). */}
      <SkillGrid grid={grid} className="max-w-[560px]" />

      {/* Honesty requirements below. All three are about the same thing —
          saying which levels are ours — and they are deliberately separate
          sentences rather than one merged line, because a reader who sees only
          solid chips should see NO caption at all. */}

      {/* The tail was INFERRED: the derivation refused for this champion and
          the levels were filled from the published max-priority order so the
          grid reads complete. That is a good guess and it is still a guess.
          Dashed chips say so visually; this says it in words, because a visual
          convention nobody explained is not a disclosure. */}
      {inferred && (
        <p className="text-[10.5px] text-gold/70 mt-3 flex items-start gap-1">
          <span aria-hidden="true">⚠</span>
          <span>
            The source publishes levels 1–{model.order.length} only, and this champion&apos;s last
            points can&apos;t be worked out from them. Level{inferred.from === inferred.to ? " " : "s "}
            <span className="tabular-nums">
              {inferred.from === inferred.to ? inferred.from : `${inferred.from}–${inferred.to}`}
            </span>{" "}
            {inferred.from === inferred.to ? "is" : "are"} inferred from{" "}
            {model.inferredBasis === "published"
              ? "the champion's published max order"
              : "the levelling path above"}{" "}
            (dashed) — a best guess, not recorded data.
          </span>
        </p>
      )}

      {/* Neither derived nor inferable. Rare, and the one case where the grid
          genuinely has holes — never padded to look tidy. */}
      {incompleteGrid && (
        <p className="text-[10.5px] text-gold/70 mt-3 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          <span className="tabular-nums">
            Levels {knownLevels + 1}–18 are unknown for this champion and left blank.
          </span>
        </p>
      )}

      {/* The other half of the same honesty requirement, and the one that is
          easy to forget: a COMPLETED order shows all 18 levels, and three of
          them are ours. The outlined chips already say so visually; this says
          it in words, because a visual convention nobody explained is not a
          disclosure. Deliberately not styled as a warning — a DERIVED tail is
          arithmetic with exactly one answer, a legitimate and useful result,
          just not a measured one. That is why it reads differently from the
          INFERRED caption above, which is a genuine guess. */}
      {derivedTail && (
        <p className="text-[10.5px] text-mut/70 mt-3">
          {/* Three states, not two. A payload cached before `completionBasis`
              existed carries no basis at all, and the old two-way ternary
              silently called those "levelling path" — naming a provenance we
              do not actually hold, which is the same fabrication the chip
              treatments exist to prevent, just in prose. When we don't know, we
              say only what we do know: these levels are ours, not the
              source's. */}
          {model.completionBasis === "published"
            ? "Outlined levels are derived from this champion's published max order, not recorded"
            : model.completionBasis === "derived"
              ? "Outlined levels are derived from this champion's levelling path, not recorded"
              : "Outlined levels are derived, not recorded"}
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
