"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /live-setup — install + pair the desktop companion (mockup 2.png, v0.51
// redesign wave B). Reads window.location.search directly (not
// useSearchParams) — no Suspense boundary needed, consistent with
// app/page.tsx's own deliberate router-param avoidance for this feature.
//
// v0.51 wave B: rebuilt around StatusHeroCard (gold hero + 4-node progress
// rail) + InstallCommands + AutomationToggles (components/hextech/companion/)
// per the mockup. The pre-redesign connection-test / LNA-help / error-log /
// self-test machinery is KEPT, functionally unchanged, just demoted below the
// fold into a collapsible <details> section — none of that capability is
// dropped, only reordered.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from "react";
import type { ChampionRef } from "@/lib/types";
import {
  getStoredSession,
  setStoredSession,
  probeCompanion,
  refreshStatus,
  COMPANION_STATUS_POLL_MS,
  getAutoItemSetsEnabled,
  setAutoItemSetsEnabled,
  getAutoRunesEnabled,
  setAutoRunesEnabled,
  getCompanionErrorLog,
  clearCompanionErrorLog,
  type ProbeState,
  type CompanionErrorLogEntry,
} from "@/components/live/companionClient";
import { isCompanionStatusFresh } from "@/components/live/companionLiveness";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import { roleIdToLane } from "@/components/live/deepLink";
import { LANE_LABEL } from "@/components/hextech/heroContracts";
import PageHeader from "@/components/hextech/PageHeader";
import StatusHeroCard from "@/components/hextech/companion/StatusHeroCard";
import InstallCommands from "@/components/hextech/companion/InstallCommands";
import AutomationToggles from "@/components/hextech/companion/AutomationToggles";
import OverlayDownload from "@/components/hextech/companion/OverlayDownload";

type Indicator = "off" | "partial" | "connected";

function indicatorFor(state: ProbeState | null): Indicator {
  if (!state || state.kind !== "connected") return "off";
  return state.status.clientConnected ? "connected" : "partial";
}

const INDICATOR_DOT: Record<Indicator, string> = {
  off: "bg-mut",
  partial: "bg-teal",
  connected: "bg-win",
};
const INDICATOR_LABEL: Record<Indicator, string> = {
  off: "Not connected",
  partial: "Companion running — League client not detected",
  connected: "Connected",
};

export default function LiveSetupPage() {
  const [session, setSession] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<ProbeState | null>(null);
  const [lastSuccessfulPollAt, setLastSuccessfulPollAt] = useState<number | null>(null);
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const [probing, setProbing] = useState(false);
  // Hydrated post-mount (localStorage read) to avoid an SSR/client mismatch,
  // same pattern BuildTabContent's rankHydrated uses.
  const [autoItemSets, setAutoItemSets] = useState(false);
  const [autoRunes, setAutoRunes] = useState(false);
  const [autoHydrated, setAutoHydrated] = useState(false);
  // v0.43.0 diagnosability -- recent companion-call failures (apply-runes/
  // apply-itemsets), persisted client-side so a return visit shows history
  // even without PowerShell/log access. Hydrated post-mount same as the
  // toggles above (localStorage read).
  const [errorLog, setErrorLog] = useState<CompanionErrorLogEntry[]>([]);
  // v0.51.0 wave B: champ-select champion id -> display name resolution for
  // StatusHeroCard's headline — same lazy /api/champions fetch pattern
  // GlobalNav/ChampSelectChip.tsx already uses (only fires once champ select
  // is actually live and a championId has resolved).
  const [champions, setChampions] = useState<ChampionRef[]>([]);
  const statusPollRequestRef = useRef(0);
  const statusFresh = isCompanionStatusFresh(lastSuccessfulPollAt, statusClock);

  const acceptProbeState = useCallback((next: ProbeState) => {
    const now = Date.now();
    setStatusClock(now);
    setLastSuccessfulPollAt(next.kind === "connected" ? now : null);
    setProbeState(next);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setStatusClock(Date.now()), COMPANION_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Mount-only: capture ?session= from a companion-opened link, else fall
  // back to whatever's already stored from a previous pairing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("session");
    if (fromUrl) {
      setStoredSession(fromUrl);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The paired session and its local preferences hydrate together after SSR.
      setSession(fromUrl);
    } else {
      setSession(getStoredSession());
    }
    setAutoItemSets(getAutoItemSetsEnabled());
    setAutoRunes(getAutoRunesEnabled());
    setAutoHydrated(true);
    setErrorLog(getCompanionErrorLog());
  }, []);

  // v0.51.0 wave B: a periodic PASSIVE poll (never triggers its own LNA
  // prompt UX — that's the "Test connection" button's job below) so
  // StatusHeroCard's phase/version/last-poll fields update live without
  // requiring a manual click, matching the mockup's already-connected state.
  // Same cadence/shape as CompanionProvider's app-wide poll (COMPANION_
  // STATUS_POLL_MS) — a second concurrent /status call on this one route is
  // a negligible cost (loopback-local, ~3s cadence) for the diagnostic
  // fields (version/lastPollAt/lastError) the app-wide context doesn't
  // expose.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    async function poll() {
      const requestId = ++statusPollRequestRef.current;
      const state = await refreshStatus(session as string, {}, null);
      if (!cancelled && requestId === statusPollRequestRef.current) acceptProbeState(state);
    }

    poll();
    const id = setInterval(poll, COMPANION_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      statusPollRequestRef.current += 1;
      clearInterval(id);
    };
  }, [acceptProbeState, session]);

  function handleClearErrorLog() {
    clearCompanionErrorLog();
    setErrorLog([]);
  }

  function handleAutoItemSetsToggle(next: boolean) {
    setAutoItemSets(next);
    setAutoItemSetsEnabled(next);
  }

  function handleAutoRunesToggle(next: boolean) {
    setAutoRunes(next);
    setAutoRunesEnabled(next);
  }

  const runTest = useCallback(async () => {
    if (!session) return;
    setProbing(true);
    // The deliberate LNA-prompt moment (research §E) — a real user click,
    // so a continued failure after walking all 3 ports is classified as
    // lna-denied rather than the quieter no-companion (see companionClient's
    // ProbeState doc comment on why this is a heuristic).
    const state = await probeCompanion(session, "user-click");
    acceptProbeState(state);
    setProbing(false);
  }, [acceptProbeState, session]);

  const indicator = statusFresh ? indicatorFor(probeState) : "off";
  const rawStatus = probeState?.kind === "connected" ? probeState.status : null;
  const connected = statusFresh && probeState?.kind === "connected";
  const status = connected ? rawStatus : null;

  // StatusHeroCard's champion/role resolution — mirrors ChampSelectChip.tsx's
  // id -> display-string approach exactly.
  const championId = status ? resolveCurrentChampSelectChampionId(status.champSelect) : null;
  const roleId = status ? resolveChampSelectRoleId(status.champSelect) : undefined;
  useEffect(() => {
    if (championId === null || champions.length > 0) return;
    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {
        /* stays unresolved this tick — StatusHeroCard degrades to the honest
           "still picking" label rather than a guessed name */
      });
  }, [championId, champions.length]);
  const champSelectChampionName =
    championId !== null ? champions.find((c) => c.id === championId)?.name ?? null : null;
  const champSelectRoleLabel = roleId !== undefined ? LANE_LABEL[roleIdToLane(roleId)] : null;

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[820px] mx-auto px-4 sm:px-6">
        <PageHeader
          title="Companion"
          subtitle="Watches your League client — no install, no login, runs on your PC"
        />

        <div className="space-y-5">
          <StatusHeroCard
            clientConnected={status?.clientConnected ?? false}
            phase={status?.phase ?? null}
            champSelectChampionName={champSelectChampionName}
            champSelectRoleLabel={champSelectRoleLabel}
            scriptVersion={rawStatus?.version ?? null}
            lastPollAt={rawStatus?.lastPollAt ?? null}
            statusFresh={statusFresh}
          />

          <InstallCommands />

          <AutomationToggles
            autoItemSets={autoItemSets}
            autoRunes={autoRunes}
            hydrated={autoHydrated}
            onToggleItemSets={handleAutoItemSetsToggle}
            onToggleRunes={handleAutoRunesToggle}
          />

          <OverlayDownload />

          {/* Pre-redesign diagnostics — connection test, LNA-denied help,
              error log, self-test. Functionally unchanged, only demoted
              below the fold behind a native <details> disclosure (zero-JS
              accessible, keyboard/AT-friendly) per the brief's "keep,
              restyled/demoted, collapsible" instruction. */}
          <details className="bg-panel border border-line rounded-xl overflow-hidden group">
            <summary className="cursor-pointer select-none px-5 sm:px-6 py-4 text-[11px] tracking-[0.12em] uppercase text-mut font-semibold flex items-center justify-between gap-3 hover:text-txt transition-colors">
              Diagnostics &amp; manual connection test
              <span className="text-mut transition-transform duration-150 group-open:rotate-180" aria-hidden="true">
                &#9662;
              </span>
            </summary>

            <div className="px-5 sm:px-6 pb-6 space-y-5 border-t border-line/60 pt-5">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Connection</p>
                  <span className="flex items-center gap-1.5 text-[11px] text-mut">
                    <span className={`w-2 h-2 rounded-full ${INDICATOR_DOT[indicator]}`} aria-hidden="true" />
                    {INDICATOR_LABEL[indicator]}
                  </span>
                </div>

                <p className="text-[12px] text-mut leading-relaxed">
                  Your browser will ask to allow CoachBuild to reach a local app on this PC
                  (Chrome&apos;s Local Network Access permission) — this is expected the first time.
                  Click <strong className="text-txt">Allow</strong>.
                </p>

                <button
                  type="button"
                  onClick={runTest}
                  disabled={!session || probing}
                  className="text-[12px] font-semibold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-4 py-2 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                >
                  {probing ? "Testing…" : "Test connection"}
                </button>

                {!session && (
                  <p className="text-[11px] text-mut">
                    No pairing session yet — open this page from the companion&apos;s tray menu, or
                    from a champ-select auto-open link, first.
                  </p>
                )}

                {session && !statusFresh && (
                  <p className="text-[11.5px] text-mut">
                    Companion not responding — check that it&apos;s running, then test again.
                  </p>
                )}

                {status && (
                  <>
                    <dl className="grid grid-cols-3 gap-3 text-[11px]">
                      <div>
                        <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Version</dt>
                        <dd className="text-txt font-medium tabular-nums">{status.version}</dd>
                      </div>
                      <div>
                        <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Phase</dt>
                        <dd className="text-txt font-medium">{status.phase}</dd>
                      </div>
                      <div>
                        <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Client</dt>
                        <dd className="text-txt font-medium">
                          {status.clientConnected ? "Connected" : "Not detected"}
                        </dd>
                      </div>
                    </dl>

                    {/* Diagnosability (v1.2.0-1.2.2) — lets us debug a "nothing
                        opens" report remotely from ONE screenshot, without a
                        screen-share. */}
                    {(status.lastOpen || status.champSelect || status.lastPollAt || status.lastError) && (
                      <div className="text-[10px] text-mut/70 space-y-0.5 pt-1 border-t border-line/50">
                        {status.lastPollAt && (
                          <p>Last poll: {new Date(status.lastPollAt).toLocaleTimeString()}</p>
                        )}
                        {status.lastOpen && (
                          <p>
                            Last opened: champion #{status.lastOpen.championId}, role{" "}
                            {status.lastOpen.roleId ?? "auto"} at{" "}
                            {new Date(status.lastOpen.at).toLocaleTimeString()}
                          </p>
                        )}
                        {status.champSelect && (
                          <p>
                            Champ select: cell #{status.champSelect.localPlayerCellId}, champion{" "}
                            {status.champSelect.cellChampionId ??
                              status.champSelect.pickIntent ??
                              status.champSelect.actionChampionId ??
                              "none yet"}
                            , role {status.champSelect.roleId ?? "auto"}
                          </p>
                        )}
                        {status.lastError && <p className="text-bad/80">Last error: {status.lastError}</p>}
                      </div>
                    )}
                  </>
                )}

                {probeState?.kind === "lna-denied" && (
                  <div className="text-[11.5px] text-bad space-y-1">
                    <p>Blocked by your browser.</p>
                    <p>
                      <span className="font-semibold">Chrome / Edge:</span> click the lock icon in
                      the address bar &rarr; Site settings &rarr; allow &quot;Local network
                      access&quot;, then test again.
                    </p>
                    <p>
                      <span className="font-semibold">Brave:</span> open{" "}
                      <code className="text-[10.5px]">brave://settings/content/localhostAccess</code>{" "}
                      and add <code className="text-[10.5px]">https://coachbuild.vercel.app</code>{" "}
                      under &quot;Allowed to access localhost&quot; (Brave blocks silently instead of
                      prompting), then reload and test again.
                    </p>
                    <p className="text-mut">
                      This can also appear when the companion simply isn&apos;t running — check the
                      system tray first before changing browser settings.
                    </p>
                  </div>
                )}

                {probeState?.kind === "no-companion" && (
                  <p className="text-[11.5px] text-mut">
                    Couldn&apos;t reach the companion. Make sure it&apos;s running (check your system
                    tray) and try again.
                  </p>
                )}
              </div>

              {errorLog.length > 0 && (
                <div className="space-y-3 pt-4 border-t border-line/60">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Recent errors</p>
                    <button
                      type="button"
                      onClick={handleClearErrorLog}
                      className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mut hover:text-txt transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                  <p className="text-[11px] text-mut leading-relaxed">
                    The last few times an &quot;Apply runes&quot; or &quot;Add item builds&quot; write
                    failed on this device -- kept here so you can share it (a screenshot works)
                    without needing PowerShell access to the companion&apos;s own log.
                  </p>
                  <ul className="space-y-1.5 text-[11px]">
                    {[...errorLog]
                      .reverse()
                      .slice(0, 5)
                      .map((entry, i) => (
                        <li
                          key={`${entry.ts}-${i}`}
                          className="border-t border-line/50 pt-1.5 first:border-t-0 first:pt-0"
                        >
                          <p className="text-mut/70 text-[10px]">
                            {new Date(entry.ts).toLocaleString()} &middot; {entry.kind}
                          </p>
                          <p className="text-bad/80">{entry.detail}</p>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              <div className="space-y-3 pt-4 border-t border-line/60">
                <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">5-minute self-test</p>
                <ol className="space-y-2.5 text-[12.5px] text-txt list-decimal list-inside">
                  <li>Run the one-liner above — a tray icon appears, no console window.</li>
                  <li>
                    Click <strong>Test connection</strong> above &rarr; allow the browser prompt
                    &rarr; version and client status show above.
                  </li>
                  <li>
                    Enter champ select in League — the Builds page opens automatically for your
                    pick + role; changing your hover updates it; re-picking the same champion does
                    not reopen it.
                  </li>
                  <li>
                    On the Builds page, click <strong>Apply runes</strong> &rarr; your in-client
                    rune page is replaced with &quot;CoachBuild &lt;champ&gt; &lt;role&gt;&quot; (a
                    failed delete prompts you to remove the old page manually, then retry).
                  </li>
                  <li>
                    Once the game starts, a live panel appears showing the enemy champions and
                    roles — never names or timers — with build suggestions that highlight for the
                    matchup when that data is available.
                  </li>
                </ol>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
