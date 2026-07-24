"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import PageHeader from "@/components/hextech/PageHeader";
import MoverRow, { type Mover } from "@/components/hextech/MoverRow";

// ─────────────────────────────────────────────────────────────────────────────
// /movers — "Patch Movers" (mockup 7.png, v0.51 wave B). Rebuilt as ONE
// combined table across every role (no lane pills — the mockup mixes
// top/mid/jungle/support champions in a single win-rate-shift ranking),
// consuming the REWRITTEN /api/patch-movers (engo, concurrent): GET with no
// query params, {patch, prevPatch, movers:[{championId,championName,role,
// wrNow,wrPrev,deltaPp,games,note}]}. See MoverRow.tsx's header comment for
// the wrNow/deltaPp scale assumptions.
//
// `PatchMoversWire`/`UnsupportedWire` are declared locally (not imported
// from lib/patchMovers.ts, which still reflects the PRE-rewrite per-keystone/
// per-item shape as of this file's writing) — see MoverRow.tsx's header
// comment for why a local structural type is deliberate here.
// ─────────────────────────────────────────────────────────────────────────────

interface PatchMoversWire {
  patch: string;
  prevPatch: string;
  movers: Mover[];
}
interface UnsupportedWire {
  unsupported: true;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: PatchMoversWire }
  | { status: "unsupported" }
  | { status: "empty" }
  | { status: "error" };

function MoversSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse space-y-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-28 bg-panel2 rounded" />
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

export default function MoversPage() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const reqIdRef = useRef(0);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  const load = useCallback(async () => {
    const requestId = ++reqIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/patch-movers`);
      if (reqIdRef.current !== requestId) return;
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      const data: PatchMoversWire | UnsupportedWire = await res.json();
      if (reqIdRef.current !== requestId) return;
      if ("unsupported" in data) {
        setState({ status: "unsupported" });
        return;
      }
      if (!Array.isArray(data.movers) || data.movers.length === 0) {
        setState({ status: "empty" });
        return;
      }
      const sorted = [...data.movers].sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
      setState({ status: "ok", data: { ...data, movers: sorted } });
    } catch {
      if (reqIdRef.current === requestId) setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1000px] mx-auto px-4 sm:px-6">
        <PageHeader
          title="Patch Movers"
          subtitle={
            state.status === "ok"
              ? `Biggest win-rate shifts, ${state.data.prevPatch} → ${state.data.patch}`
              : "Biggest win-rate shifts between the last two patches."
          }
        />

        {state.status === "loading" && <MoversSkeleton />}

        {state.status === "unsupported" && (
          <EmptyPanel
            title="Patch comparison unavailable"
            body="No prior-patch data to compare against yet — check back once a second patch has landed."
          />
        )}

        {state.status === "empty" && (
          <EmptyPanel title="No movers yet" body="Check back shortly once this patch has more data." />
        )}

        {state.status === "error" && (
          <EmptyPanel
            title="Couldn't load — try again"
            body="Something went wrong fetching patch movers. Check your connection and refresh."
          />
        )}

        {state.status === "ok" && (
          <div className="bg-panel border border-line rounded-xl px-5">
            <div className="hidden sm:grid grid-cols-[1.7fr_110px_90px_80px_1.4fr] gap-3 pt-4 pb-2 text-[10px] tracking-[0.1em] uppercase text-mut font-semibold">
              <span>Champion</span>
              <span className="text-right">&Delta; win rate</span>
              <span className="text-right">WR now</span>
              <span className="text-right">Games</span>
              <span>Patch note</span>
            </div>
            {state.data.movers.map((m, i) => (
              <MoverRow key={`${m.championId}-${i}`} mover={m} championIcon={champIcons.get(m.championId)?.icon ?? ""} />
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
