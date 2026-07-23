"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { PatchMoversResponse, PatchMoversUnsupported } from "@/lib/patchMovers";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import LaneFilterPills from "@/components/hextech/LaneFilterPills";
import MoverRow from "@/components/hextech/MoverRow";
import { patchHeaderText } from "@/components/hextech/patchMoversFormat";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: PatchMoversResponse }
  | { status: "unsupported" }
  | { status: "empty" }
  | { status: "error" };

function MoversSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse space-y-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-28 bg-panel2 rounded" />
            <div className="h-2 w-20 bg-panel2 rounded" />
          </div>
          <div className="h-3 w-12 bg-panel2 rounded flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-10 text-center">
      <div className="text-txt font-semibold mb-1">{title}</div>
      <div className="text-mut text-sm">{body}</div>
    </div>
  );
}

/**
 * Feature 4 (patch movers) — GET /api/patch-movers?role=<0-4>, per the
 * engine handoff's contract: 200 + {patch,prevPatch,movers[]} (cached
 * s-maxage=86400, "compared daily" — CDN-cached responses may be up to a day
 * old), 200 + {unsupported:true} when there's no previous populated patch to
 * compare against (defensive — not expected to fire today, see the handoff's
 * Known Issues), or {patch,prevPatch,movers:[]} treated as a degraded/empty
 * result distinct from unsupported.
 */
export default function MoversPage() {
  const [lane, setLane] = useState<LaneId>("mid");
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());

  // Stale-response guard on lane switches — same numeric request-id idiom
  // app/page.tsx's mostPlayedLaneRequestRef / SidebarChampionSearch's
  // debounced search already use in this codebase: bump on every new
  // request, only apply a response if its id is still the latest.
  const reqIdRef = useRef(0);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  const load = useCallback(async (l: LaneId) => {
    const requestId = ++reqIdRef.current;
    setState({ status: "loading" });
    try {
      const role = LANE_TO_ROLE_ID[l];
      const res = await fetch(`/api/patch-movers?role=${role}`);
      if (reqIdRef.current !== requestId) return; // superseded by a later lane switch
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      const data: PatchMoversResponse | PatchMoversUnsupported = await res.json();
      if (reqIdRef.current !== requestId) return;
      if ("unsupported" in data) {
        setState({ status: "unsupported" });
        return;
      }
      if (!Array.isArray(data.movers) || data.movers.length === 0) {
        setState({ status: "empty" });
        return;
      }
      setState({ status: "ok", data });
    } catch {
      if (reqIdRef.current === requestId) setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    load(lane);
  }, [lane, load]);

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6">
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <div className="text-center mb-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-balance">
              Patch <span className="text-teal">Movers</span>
            </h1>
            <p className="text-mut text-sm mt-1">
              {state.status === "ok"
                ? patchHeaderText(state.data.patch, state.data.prevPatch)
                : "Biggest WPA swings between the last two patches, per lane."}
            </p>
            <p className="text-mut/60 text-[11px] mt-1">Compared daily — data may be up to a day old.</p>
          </div>

          <LaneFilterPills value={lane} onChange={setLane} />
        </header>

        {state.status === "loading" && <MoversSkeleton />}

        {state.status === "unsupported" && (
          <EmptyPanel
            title="Patch comparison unavailable"
            body="No prior-patch data to compare against yet — check back once a second patch has landed."
          />
        )}

        {state.status === "empty" && (
          <EmptyPanel
            title="No movers yet for this lane"
            body="Try a different lane, or check back shortly."
          />
        )}

        {state.status === "error" && (
          <EmptyPanel
            title="Couldn't load — try again"
            body="Something went wrong fetching patch movers. Check your connection and refresh."
          />
        )}

        {state.status === "ok" && (
          <div className="bg-panel border border-line rounded-xl px-5">
            {state.data.movers.map((m, i) => (
              <MoverRow
                key={`${m.championId}-${m.kind}-${i}`}
                mover={m}
                championIcon={champIcons.get(m.championId)?.icon ?? ""}
              />
            ))}
          </div>
        )}

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Build data and icons © coachless.gg / Riot Games. For personal use.</p>
          <p>Not endorsed by Riot Games.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
