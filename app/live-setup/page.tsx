"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { useCompanion } from "@/components/live/CompanionProvider";
import {
  clearCompanionErrorLog,
  COMPANION_STATUS_POLL_MS,
  getAutoItemSetsEnabled,
  getAutoRunesEnabled,
  getCompanionErrorLog,
  getStoredSession,
  probeCompanion,
  refreshStatus,
  setAutoItemSetsEnabled,
  setAutoRunesEnabled,
  setStoredSession,
  type CompanionErrorLogEntry,
  type ProbeState,
} from "@/components/live/companionClient";
import { isCompanionStatusFresh } from "@/components/live/companionLiveness";
import { resolveChampSelectRoleId, resolveCurrentChampSelectChampionId } from "@/components/live/champSelectFollow";
import { roleIdToLane } from "@/components/live/deepLink";
import { LANE_LABEL } from "@/components/hextech/heroContracts";
import AutomationToggles from "@/components/hextech/companion/AutomationToggles";
import InstallCommands from "@/components/hextech/companion/InstallCommands";
import OverlayDownload from "@/components/hextech/companion/OverlayDownload";
import StatusHeroCard from "@/components/hextech/companion/StatusHeroCard";

type Indicator = "off" | "partial" | "connected";

function indicatorFor(state: ProbeState | null): Indicator {
  if (!state || state.kind !== "connected") return "off";
  return state.status.clientConnected ? "connected" : "partial";
}

const INDICATOR_DOT: Record<Indicator, string> = {
  off: "bg-txt/20",
  partial: "bg-accent-400",
  connected: "bg-good",
};

const INDICATOR_LABEL: Record<Indicator, string> = {
  off: "Not connected",
  partial: "Companion running · League client not detected",
  connected: "Connected",
};

export default function LiveSetupPage() {
  const companion = useCompanion();
  const [session, setSession] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<ProbeState | null>(null);
  const [lastSuccessfulPollAt, setLastSuccessfulPollAt] = useState<number | null>(null);
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const [probing, setProbing] = useState(false);
  const [autoItemSets, setAutoItemSets] = useState(false);
  const [autoRunes, setAutoRunes] = useState(false);
  const [autoHydrated, setAutoHydrated] = useState(false);
  const [errorLog, setErrorLog] = useState<CompanionErrorLogEntry[]>([]);
  const [champions, setChampions] = useState<ChampionRef[]>([]);
  const statusPollRequestRef = useRef(0);
  const hydratedRef = useRef(false);
  const statusFresh = isCompanionStatusFresh(lastSuccessfulPollAt, statusClock);

  const acceptProbeState = useCallback((next: ProbeState) => {
    const now = Date.now();
    setStatusClock(now);
    setLastSuccessfulPollAt(next.kind === "connected" ? now : null);
    setProbeState(next);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setStatusClock(Date.now()), COMPANION_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("session");
    if (fromUrl) {
      setStoredSession(fromUrl);
      companion.setSession(fromUrl);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL pairing hydrates once after SSR.
      setSession(fromUrl);
    } else {
      setSession(getStoredSession());
    }
    setAutoItemSets(getAutoItemSetsEnabled());
    setAutoRunes(getAutoRunesEnabled());
    setAutoHydrated(true);
    setErrorLog(getCompanionErrorLog());
  }, [companion]);

  useEffect(() => {
    if (!session) return;
    const currentSession = session;
    let cancelled = false;

    async function poll() {
      const requestId = ++statusPollRequestRef.current;
      const state = await refreshStatus(currentSession, {}, null);
      if (!cancelled && requestId === statusPollRequestRef.current) acceptProbeState(state);
    }

    void poll();
    const interval = setInterval(() => void poll(), COMPANION_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      statusPollRequestRef.current += 1;
      clearInterval(interval);
    };
  }, [acceptProbeState, session]);

  const runTest = useCallback(async () => {
    if (!session) return;
    setProbing(true);
    const state = await probeCompanion(session, "user-click");
    acceptProbeState(state);
    setProbing(false);
  }, [acceptProbeState, session]);

  const handleClearErrorLog = useCallback(() => {
    clearCompanionErrorLog();
    setErrorLog([]);
  }, []);

  const rawStatus = probeState?.kind === "connected" ? probeState.status : null;
  const localConnected = statusFresh && probeState?.kind === "connected";
  const status = localConnected ? rawStatus : null;

  // The shared provider owns the hero's phase truth. This route-local poll is
  // retained for version/last-poll diagnostics and the user-triggered probe.
  const providerFresh = companion.statusFresh && companion.session !== null;
  const providerPhase = providerFresh ? companion.phase : null;
  const providerClientConnected = providerFresh && companion.clientConnected;
  const championId = providerPhase === "ChampSelect" ? resolveCurrentChampSelectChampionId(companion.champSelect) : null;
  const roleId = providerPhase === "ChampSelect" ? resolveChampSelectRoleId(companion.champSelect) : undefined;

  useEffect(() => {
    if (championId === null || champions.length > 0) return;
    fetch("/api/champions")
      .then((response) => (response.ok ? (response.json() as Promise<ChampionRef[]>) : []))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {
        /* Status remains honest and says champ select is still resolving. */
      });
  }, [championId, champions.length]);

  const champSelectChampionName = championId !== null ? champions.find((champion) => champion.id === championId)?.name ?? null : null;
  const champSelectRoleLabel = roleId !== undefined ? LANE_LABEL[roleIdToLane(roleId)] : null;
  const indicator = statusFresh ? indicatorFor(probeState) : "off";

  return (
    <div className="min-h-screen pb-16">
      <div className="mx-auto max-w-[900px] px-4 sm:px-6">
        <header className="pb-5 pt-8">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-accent-400">Runs on your PC · no login · local only</p>
          <h1 className="mt-1 text-[30px] font-medium leading-tight tracking-[-0.03em] text-txt sm:text-[34px]">Companion</h1>
          <p className="mt-1.5 max-w-[70ch] text-[13.5px] leading-relaxed text-mut">
            A small companion that watches your League client and hands CoachBuild the state of your game. It reads picks, roles and item builds — never names, never cooldowns, and never acts in-game for you.
          </p>
        </header>

        <div className="space-y-5">
          <StatusHeroCard
            clientConnected={providerClientConnected}
            phase={providerPhase}
            champSelectChampionName={champSelectChampionName}
            champSelectRoleLabel={champSelectRoleLabel}
            scriptVersion={rawStatus?.version ?? null}
            lastPollAt={rawStatus?.lastPollAt ?? null}
            statusFresh={providerFresh}
          />

          <InstallCommands />

          <AutomationToggles
            autoItemSets={autoItemSets}
            autoRunes={autoRunes}
            hydrated={autoHydrated}
            onToggleItemSets={(next) => {
              setAutoItemSets(next);
              setAutoItemSetsEnabled(next);
            }}
            onToggleRunes={(next) => {
              setAutoRunes(next);
              setAutoRunesEnabled(next);
            }}
          />

          <OverlayDownload />

          <details className="overflow-hidden rounded-[9px] bg-panel-glass shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] group">
            <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-5 py-4 text-[11px] font-medium uppercase tracking-[0.12em] text-mut transition-colors duration-[120ms] ease-in hover:text-txt sm:px-6">
              Diagnostics and manual connection test
              <span className="transition-transform duration-[120ms] ease-in group-open:rotate-180" aria-hidden="true">⌄</span>
            </summary>

            <div className="space-y-5 border-t border-txt/[0.06] px-5 pb-6 pt-5 sm:px-6">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-txt/[0.44]">Connection</p>
                  <span className="flex items-center gap-1.5 text-[11px] text-mut">
                    <span className={`h-2 w-2 rounded-full ${INDICATOR_DOT[indicator]}`} aria-hidden="true" />
                    {INDICATOR_LABEL[indicator]}
                  </span>
                </div>

                <p className="text-[12px] leading-relaxed text-mut">
                  Your browser may ask to allow CoachBuild to reach a local app on this PC. This is expected the first time; click <strong className="font-semibold text-txt">Allow</strong>.
                </p>

                <button
                  type="button"
                  onClick={() => void runTest()}
                  disabled={!session || probing}
                  className="min-h-[44px] rounded-[8px] px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-accent-400 shadow-[inset_0_0_0_1px_#9184d9] transition-colors duration-[120ms] ease-in hover:bg-accent/[0.14] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
                >
                  {probing ? "Testing…" : "Test connection"}
                </button>

                {!session && <p className="text-[11px] text-mut">No pairing session yet — open this page from the desktop companion first.</p>}
                {session && !statusFresh && <p className="text-[11px] text-mut">Companion not responding — check that it is running, then test again.</p>}

                {status && (
                  <dl className="grid grid-cols-3 gap-3 border-t border-txt/[0.06] pt-4 text-[11px]">
                    <div><dt className="text-[9px] uppercase tracking-[0.08em] text-mut">Version</dt><dd className="font-medium text-txt tabular-nums">{status.version}</dd></div>
                    <div><dt className="text-[9px] uppercase tracking-[0.08em] text-mut">Phase</dt><dd className="font-medium text-txt">{status.phase}</dd></div>
                    <div><dt className="text-[9px] uppercase tracking-[0.08em] text-mut">Client</dt><dd className="font-medium text-txt">{status.clientConnected ? "Connected" : "Not detected"}</dd></div>
                  </dl>
                )}

                {probeState?.kind === "lna-denied" && (
                  <div className="space-y-1 text-[11.5px] leading-relaxed text-bad">
                    <p>Blocked by your browser.</p>
                    <p>Chrome / Edge: open the address-bar site settings and allow Local network access, then test again.</p>
                    <p>Brave: allow <code className="text-[10.5px]">https://coachbuild.vercel.app</code> under localhost access, then reload.</p>
                  </div>
                )}
                {probeState?.kind === "no-companion" && <p className="text-[11.5px] text-mut">Could not reach the companion. Make sure it is running and try again.</p>}
              </div>

              {errorLog.length > 0 && (
                <div className="space-y-3 border-t border-txt/[0.06] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-txt/[0.44]">Recent errors</p>
                    <button type="button" onClick={handleClearErrorLog} className="text-[10px] font-semibold uppercase tracking-[0.08em] text-mut hover:text-txt focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">Clear</button>
                  </div>
                  <ul className="space-y-2 text-[11px]">
                    {[...errorLog].reverse().slice(0, 5).map((entry, index) => (
                      <li key={`${entry.ts}-${index}`} className="border-t border-txt/[0.05] pt-2 first:border-t-0 first:pt-0">
                        <p className="text-[10px] text-mut/70">{new Date(entry.ts).toLocaleString()} · {entry.kind}</p>
                        <p className="text-bad/80">{entry.detail}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-3 border-t border-txt/[0.06] pt-4">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-txt/[0.44]">Five-minute self-test</p>
                <ol className="list-inside list-decimal space-y-2 text-[12px] leading-relaxed text-mut">
                  <li>Install the native desktop app and confirm its tray icon appears.</li>
                  <li>Click <strong className="font-semibold text-txt">Test connection</strong> and allow local network access if prompted.</li>
                  <li>Enter champ select — the companion follows your pick and role without writing personal pages.</li>
                  <li>Once the game starts, the overlay reads only your own level and ability ranks and shows the next safe point.</li>
                </ol>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
