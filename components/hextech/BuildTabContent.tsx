"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import StartingCard from "./StartingCard";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";

interface BuildTabContentProps {
  champ: ChampionRef;
  lane: LaneId;
  /** Fires once a build response resolves, so the sidebar footer can show
   *  the resolved data patch without a second fetch. */
  onPatchResolved?: (patch: string) => void;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; build: BuildResponse }
  | { status: "empty" }
  | { status: "error" };

function CardSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-panel border border-line rounded-xl p-5 animate-pulse ${className}`}>
      <div className="h-2.5 w-28 bg-panel2 rounded mb-4" />
      <div className="flex gap-3">
        <div className="w-12 h-12 rounded-full bg-panel2" />
        <div className="space-y-2 flex-1">
          <div className="h-3 w-24 bg-panel2 rounded" />
          <div className="h-2.5 w-12 bg-panel2 rounded" />
        </div>
      </div>
    </div>
  );
}

function BuildLoadingSkeleton() {
  return (
    <div className="mt-5 space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <CardSkeleton className="md:col-span-2" />
        <CardSkeleton />
      </div>
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  const load = useCallback(
    async (c: ChampionRef, l: LaneId) => {
      setState({ status: "loading" });
      try {
        const roleId = LANE_TO_ROLE_ID[l];
        const res = await fetch(`/api/build?champ=${c.id}&role=${roleId}`);
        if (res.status === 404) {
          setState({ status: "empty" });
          return;
        }
        if (!res.ok) {
          setState({ status: "error" });
          return;
        }
        const data: BuildResponse[] = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
          setState({ status: "empty" });
          return;
        }
        // Spec shows a single primary build, not the top-3 variant switcher
        // the legacy Builds page rendered — the #1 ranked setup only.
        setState({ status: "ok", build: data[0] });
        onPatchResolved?.(data[0].patch);
      } catch {
        setState({ status: "error" });
      }
    },
    [onPatchResolved]
  );

  useEffect(() => {
    load(champ, lane);
  }, [champ, lane, load]);

  if (state.status === "loading") return <BuildLoadingSkeleton />;

  if (state.status === "empty") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">
          Not enough data for {champ.name} {LANE_LABEL[lane]}
        </div>
        <div className="text-mut text-sm">
          Try a different lane, or check{" "}
          <a
            href="https://coachless.gg"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal hover:underline"
          >
            coachless.gg
          </a>{" "}
          directly.
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">Couldn&apos;t load — try again</div>
        <div className="text-mut text-sm">
          Something went wrong fetching {champ.name} {LANE_LABEL[lane]}. Check your connection and
          refresh.
        </div>
      </div>
    );
  }

  const { build } = state;

  return (
    <div className="mt-5 space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="md:col-span-2">
          <RunesSummonersCard runes={build.runes} spells={build.spells} />
        </div>
        <StartingCard starter={build.items.starter} />
      </div>
      <CoreBuildOrderCard items={build.items} />
      <SituationalCard items={build.items} />
    </div>
  );
}
