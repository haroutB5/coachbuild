"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /compact — the mini view.
//
// One route, two hosts, deliberately:
//   • a browser user pops it out onto a second monitor (chrome-free, ~380px);
//   • the desktop shell loads THIS SAME ROUTE in its always-on-top champ-select
//     overlay window.
//
// That is the whole point. The overlay is the one thing a browser genuinely
// cannot do — but the CONTENT of it must not be desktop-only code, or the web
// app forks and the phone starts drifting behind. So the shell contributes
// window behaviour (small, always-on-top, auto-hidden once the game starts) and
// nothing else; everything you see here ships from Vercel like every other
// route, and improves for all three hosts in one deploy.
//
// Not follow-capable on purpose. followKindForRoute() still maps only "/" and
// "/draft", so having this open never suppresses the companion's Builds open
// for a browser user — worst case they get one redundant tab, which is the
// right side of that trade (the whole v1.7.0 saga was about "nothing opened"
// being far worse than "one tab too many"). The desktop shell ignores the
// follow machinery entirely, so this costs it nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import CoreBuildOrderCard from "@/components/hextech/CoreBuildOrderCard";
import RunesSummonersCard from "@/components/hextech/RunesSummonersCard";
import SkillOrderNextPanel from "@/components/hextech/SkillOrderNextPanel";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveChampSelectRoleId, resolveCurrentChampSelectChampionId } from "@/components/live/champSelectFollow";
import { roleIdToLane } from "@/components/live/deepLink";
import { LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import type { BuildResponse } from "@/lib/types";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading"; championId: number }
  | { kind: "ready"; build: BuildResponse }
  | { kind: "error"; message: string };

const roleParamToLane = (raw: string | null): LaneId | null => {
  if (raw == null || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 4) return null;
  return roleIdToLane(parsed as 0 | 1 | 2 | 3 | 4);
};

export default function CompactPage() {
  const companion = useCompanion();
  const [lane, setLane] = useState<LaneId | null>(null);
  const requestRef = useRef(0);

  // Session + deep link, read once at mount from the raw query string — the
  // same contract `/` uses, and the same reason it reads location directly
  // rather than useSearchParams (one mount-only read, no router coupling).
  const [initialChampionId, setInitialChampionId] = useState<number | null>(null);
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const session = params.get("session");
    if (session) companion.setSession(session);

    const laneFromParam = roleParamToLane(params.get("role"));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL parameters hydrate after SSR and must be applied once as one deep-link transaction.
    if (laneFromParam) setLane(laneFromParam);

    const championId = Number.parseInt(params.get("championId") ?? "", 10);
    if (Number.isFinite(championId) && championId > 0) setInitialChampionId(championId);
  }, [companion]);

  // Live-follow: whatever champ select currently resolves to wins over the
  // mount-time deep link, so the overlay tracks hovers in place exactly like
  // the Builds page does.
  const liveChampionId =
    companion.phase === "ChampSelect" ? resolveCurrentChampSelectChampionId(companion.champSelect) : null;
  const liveRoleId = companion.phase === "ChampSelect" ? resolveChampSelectRoleId(companion.champSelect) : undefined;
  const championId = liveChampionId ?? initialChampionId;
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const requestKey = championId == null ? null : `${championId}:${lane ?? ""}`;
  const [previousRequestKey, setPreviousRequestKey] = useState<string | null>(null);
  if (requestKey !== previousRequestKey) {
    setPreviousRequestKey(requestKey);
    if (championId !== null) setState({ kind: "loading", championId });
  }
  const liveLane = liveRoleId === undefined ? null : roleIdToLane(liveRoleId);
  if (liveLane !== null && liveLane !== lane) setLane(liveLane);

  const load = useCallback(async (champion: number, forLane: LaneId | null) => {
    const requestId = ++requestRef.current;
    try {
      const roleId = forLane ? LANE_TO_ROLE_ID[forLane] : 5; // 5 = let the API pick
      const response = await fetch(`/api/build?champ=${champion}&role=${roleId}`);
      if (requestRef.current !== requestId) return;
      if (!response.ok) {
        setState({ kind: "error", message: "No build for that champion and lane yet." });
        return;
      }
      // /api/build returns the TOP-3 VARIANTS as an array, not one build —
      // the mini view shows the top recommendation (rank 1 is first).
      const variants = (await response.json()) as BuildResponse[];
      if (requestRef.current !== requestId) return;
      const build = Array.isArray(variants) ? variants[0] : (variants as BuildResponse);
      if (!build?.champion) {
        setState({ kind: "error", message: "No build for that champion and lane yet." });
        return;
      }
      setState({ kind: "ready", build });
    } catch {
      if (requestRef.current !== requestId) return;
      setState({ kind: "error", message: "Couldn't reach the build service." });
    }
  }, [setState]);

  useEffect(() => {
    if (championId == null || championId <= 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `load` only updates from its asynchronous, request-id-guarded fetch response.
    void load(championId, lane);
  }, [championId, lane, load]);

  // The overlay opens before anyone has hovered anything — say so plainly
  // rather than showing an empty frame.
  if (championId == null || championId <= 0) {
    return (
      <main className="min-h-screen bg-bg text-txt flex flex-col items-center justify-center px-6 text-center">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-cyan font-semibold mb-3">CoachBuild</p>
        <p className="text-sm font-semibold mb-1">Waiting for champ select</p>
        <p className="text-xs text-mut leading-relaxed">
          Hover a champion and the runes and build for it appear here.
        </p>
        {!companion.clientConnected && (
          <p className="text-[10.5px] text-mut/70 mt-4">League client not detected yet.</p>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-txt px-3 py-3">
      {/* Deliberately OUTSIDE the build-fetch state branch, and deliberately
          first. It depends on /api/skill-order and the companion, not on
          /api/build, so a failed build fetch must not take the in-game skill
          prompt down with it — and during a game this is the single most
          time-critical thing on the surface, so it goes where the eye lands.
          Renders null in every state except "there is a live reading and a
          recommendation we stand behind", including the whole time no game is
          running, so it costs nothing when it has nothing to say. */}
      <div className="empty:hidden mb-3">
        <SkillOrderNextPanel championId={championId} lane={lane} />
      </div>
      {state.kind === "ready" ? (
        <>
          <header className="flex items-baseline justify-between gap-2 mb-3 px-0.5">
            <div className="min-w-0">
              <h1 className="font-headline text-lg font-bold truncate">{state.build.champion.name}</h1>
              <p className="text-[10.5px] tracking-[0.12em] uppercase text-mut font-semibold">
                {state.build.roleLabel} · {state.build.tierLabel}
              </p>
            </div>
            <span className="text-[10.5px] text-mut/70 shrink-0">Patch {state.build.patch}</span>
          </header>

          <div className="space-y-3">
            {/* Same components the full Builds page renders — one implementation
                of runes and item order, narrow layout for free (the app is
                already responsive down to ~390px). Apply-runes and Add-item-
                builds come along with the card, which is exactly what an
                overlay is for. */}
            <RunesSummonersCard
              runes={state.build.runes}
              spells={state.build.spells}
              onOpenDetail={() => {
                /* no detail sheets in the mini view — it is a glance surface */
              }}
              championName={state.build.champion.name}
              roleLabel={state.build.roleLabel}
              build={state.build}
              lane={lane ?? undefined}
            />
            <div className="rounded-lg border border-line bg-panel-glass px-3">
              <CoreBuildOrderCard items={state.build.items} onItemClick={() => {}} />
            </div>
          </div>
        </>
      ) : state.kind === "error" ? (
        <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
          <p className="text-sm font-semibold mb-1">{state.message}</p>
          <p className="text-xs text-mut">It will update on your next hover.</p>
        </div>
      ) : (
        <div className="space-y-3 animate-pulse" aria-label="Loading build">
          <div className="h-12 rounded-lg bg-panel2" />
          <div className="h-56 rounded-lg bg-panel2" />
          <div className="h-32 rounded-lg bg-panel2" />
        </div>
      )}
    </main>
  );
}
