"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import type { PatchMover, PatchMoversResponse } from "@/lib/patchMovers";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: PatchMoversResponse }
  | { status: "unsupported" }
  | { status: "empty" }
  | { status: "error" };

function formatGames(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

function roleLabel(role: number): string {
  return ["TOP", "JUNGLE", "MID", "BOT", "SUP"][role] ?? "ALL LANES";
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return <div className="rounded-[9px] bg-panel-glass px-5 py-10 text-center shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]"><p className="text-[13px] font-semibold text-txt">{title}</p><p className="mt-1.5 text-[12px] leading-relaxed text-mut">{body}</p></div>;
}

function ShiftBar({ delta, label }: { delta: number; label: string }) {
  const positive = delta > 0;
  const negative = delta < 0;
  // Scale: the largest observed shifts run ~±4pp, so 12%/pp saturates the
  // 142px track at 4pp — a deliberate full-scale choice, not a magic number.
  const width = Math.min(48, Math.abs(delta) * 12);
  return (
    <div className="flex items-center gap-3" role="img" aria-label={`${label}: ${formatDelta(delta)}`}>
      <div className="relative h-2 w-[142px] rounded-full bg-white/[0.06]" aria-hidden="true">
        <span className="absolute bottom-[-3px] left-1/2 top-[-3px] w-px bg-white/[0.25]" aria-hidden="true" />
        {width > 0 && <span className={`absolute top-0 h-2 rounded-full ${positive ? "bg-good" : "bg-bad"}`} style={positive ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }} />}
      </div>
      <span className={`min-w-[58px] text-right text-[12px] font-semibold tabular-nums ${positive ? "text-good" : negative ? "text-bad" : "text-mut"}`}>{formatDelta(delta)}</span>
    </div>
  );
}

function MoverRow({ mover, icon }: { mover: PatchMover; icon: ChampionIconEntry | undefined }) {
  const href = mover.role >= 0 && mover.role <= 4 ? `/?championId=${mover.championId}&role=${mover.role}` : `/?championId=${mover.championId}`;
  return (
    <Link href={href} aria-label={`See ${mover.championName} build details`} className="block border-t border-white/[0.06] transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
      <div className="hidden min-w-[760px] grid-cols-[minmax(250px,1fr)_78px_88px_210px_88px] items-center gap-3 px-4 py-2.5 sm:grid sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-gradient-to-br from-[#2b2e42] to-[#1c1e2c] shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={icon?.icon ?? ""} alt={mover.championName} fallbackGlyph={mover.championName} className="h-full w-full object-cover" size={32} /></span>
          <span className="min-w-0"><span className="block truncate text-[13px] font-semibold text-txt">{mover.championName}</span><span className="block text-[9px] uppercase tracking-[0.08em] text-mut">{roleLabel(mover.role)}</span><span className="mt-1 block truncate text-[11px] text-mut/60">{mover.note ?? "—"}</span></span>
        </div>
        <span className="text-right text-[12px] text-mut tabular-nums">{mover.wrPrev.toFixed(1)}%</span>
        <span className="text-right text-[12px] font-semibold text-txt tabular-nums">{mover.wrNow.toFixed(1)}%</span>
        <ShiftBar delta={mover.deltaPp} label={`${mover.championName} ${roleLabel(mover.role)} win-rate shift`} />
        <span className="text-right text-[11px] text-mut tabular-nums">{formatGames(mover.games)}</span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3 sm:hidden">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-gradient-to-br from-[#2b2e42] to-[#1c1e2c] shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={icon?.icon ?? ""} alt={mover.championName} fallbackGlyph={mover.championName} className="h-full w-full object-cover" size={36} /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-txt">{mover.championName}</span><span className="block text-[9px] uppercase tracking-[0.08em] text-mut">{roleLabel(mover.role)} · {formatGames(mover.games)} games · {mover.wrPrev.toFixed(1)}→{mover.wrNow.toFixed(1)}%</span><span className="mt-1 block truncate text-[11px] text-mut/60">{mover.note ?? "—"}</span></span>
        <span className={`text-[13px] font-semibold tabular-nums ${mover.deltaPp >= 0 ? "text-good" : "text-bad"}`}>{formatDelta(mover.deltaPp)}</span>
      </div>
    </Link>
  );
}

function MoversTable({ data, icons }: { data: PatchMoversResponse; icons: Map<number, ChampionIconEntry> }) {
  return (
    <div className="overflow-x-auto rounded-[9px] bg-panel-glass shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <div className="hidden min-w-[760px] grid-cols-[minmax(250px,1fr)_78px_88px_210px_88px] gap-3 bg-white/[0.025] px-4 py-2.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-mut sm:grid sm:px-5"><span>Champion</span><span className="text-right">{data.prevPatch}</span><span className="text-right">{data.patch}</span><span className="text-center">Shift</span><span className="text-right">Games</span></div>
      {data.movers.map((mover) => <MoverRow key={`${mover.championId}-${mover.role}`} mover={mover} icon={icons.get(mover.championId)} />)}
    </div>
  );
}

export default function MoversPage() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [icons, setIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const requestRef = useRef(0);

  useEffect(() => {
    getChampionIconMap().then(setIcons);
  }, []);

  useEffect(() => {
    const requestId = ++requestRef.current;
    fetch("/api/patch-movers")
      .then(async (response) => {
        if (!response.ok) throw new Error("patch movers request failed");
        return response.json();
      })
      .then((data: PatchMoversResponse | { unsupported?: true }) => {
        if (requestRef.current !== requestId) return;
        if (data && "unsupported" in data && data.unsupported) {
          setState({ status: "unsupported" });
          return;
        }
        const response = data as PatchMoversResponse;
        if (!response || !Array.isArray(response.movers) || response.movers.length === 0) {
          setState({ status: "empty" });
          return;
        }
        setState({ status: "ok", data: { ...response, movers: [...response.movers].sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp)) } });
      })
      .catch(() => {
        if (requestRef.current === requestId) setState({ status: "error" });
      });
  }, []);

  return (
    <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6">
      <div className="flex items-end justify-between gap-5">
        <div><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-teal">{state.status === "ok" ? `${state.data.prevPatch} → ${state.data.patch}` : "PATCH COMPARISON"} · EVERY LANE</p><h1 className="mt-1.5 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">Patch Movers</h1></div>
        <p className="hidden max-w-[330px] text-right text-[11px] leading-relaxed text-mut sm:block">The biggest win-rate shifts since the patch landed. A note appears only when one genuinely exists.</p>
      </div>
      <div className="mt-5">
        {state.status === "loading" && <div className="h-[510px] animate-pulse rounded-[9px] bg-panel-glass" aria-label="Loading Patch Movers" />}
        {state.status === "unsupported" && <EmptyPanel title="Patch comparison unavailable" body="No prior-patch data is available to compare against yet." />}
        {state.status === "empty" && <EmptyPanel title="No movers yet" body="Check back once this patch has enough measured games." />}
        {state.status === "error" && <EmptyPanel title="Couldn&apos;t load Patch Movers" body="The patch comparison could not be read right now. Refresh to try again." />}
        {state.status === "ok" && <MoversTable data={state.data} icons={icons} />}
      </div>
      <footer className="mt-10 border-t border-white/[0.06] pt-4 text-[11px] text-mut">Patch comparison and curated notes · display only. A missing patch note is shown as —.</footer>
    </main>
  );
}
