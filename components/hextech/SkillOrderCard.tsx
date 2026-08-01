"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID } from "./heroContracts";
import { formatSharePct } from "./proConsensus";
import { fetchSkillOrder, formatSkillOrderSampleLine, type SkillOrderModel } from "./skillOrder";
import SkillOrderGrid from "./SkillOrderGrid";

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

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <CardHeader>Skill Order</CardHeader>
      <SkillOrderGrid
        model={model}
        sampleLabel={formatSkillOrderSampleLine(model, formatSharePct)}
      />
    </div>
  );
}
