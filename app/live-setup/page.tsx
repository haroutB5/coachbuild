"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /live-setup — install + pair the desktop companion (plan §2a). Reads
// window.location.search directly (not useSearchParams) — no Suspense
// boundary needed, and consistent with app/page.tsx's own deliberate
// router-param avoidance for this feature (see that file's design note).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  getStoredSession,
  setStoredSession,
  probeCompanion,
  getAutoItemSetsEnabled,
  setAutoItemSetsEnabled,
  getAutoRunesEnabled,
  setAutoRunesEnabled,
  getCompanionErrorLog,
  clearCompanionErrorLog,
  type ProbeState,
  type CompanionErrorLogEntry,
} from "@/components/live/companionClient";

// Best-effort install commands per the companion's documented flag contract
// (live-companion-plan.md §1: "-Install flag -> Startup-folder .lnk...
// target powershell.exe ... -Command 'irm <ScriptUrl> | iex'"). The
// persistent variant uses the standard PowerShell idiom for passing an
// argument through a piped-script invocation — verify against engy's actual
// companion.ps1 param binding once merged (flagged in HANDOFF-fronty.md).
const INSTALL_ONE_LINER = "irm https://coachbuild.vercel.app/companion.ps1 | iex";
const INSTALL_PERSISTENT =
  '& ([scriptblock]::Create((irm https://coachbuild.vercel.app/companion.ps1))) -Install';

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

function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard API unavailable/denied (insecure context, permission) —
         the code block below is still selectable/copyable by hand. */
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10.5px] tracking-[0.1em] uppercase text-mut font-semibold">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-pre bg-black/30 border border-line rounded-lg px-3 py-2 text-[12px] text-txt">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover rounded-lg px-3 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function LiveSetupPage() {
  const [session, setSession] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<ProbeState | null>(null);
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

  // Mount-only: capture ?session= from a companion-opened link, else fall
  // back to whatever's already stored from a previous pairing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("session");
    if (fromUrl) {
      setStoredSession(fromUrl);
      setSession(fromUrl);
    } else {
      setSession(getStoredSession());
    }
    setAutoItemSets(getAutoItemSetsEnabled());
    setAutoRunes(getAutoRunesEnabled());
    setAutoHydrated(true);
    setErrorLog(getCompanionErrorLog());
  }, []);

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
    setProbeState(state);
    setProbing(false);
  }, [session]);

  const indicator = indicatorFor(probeState);

  return (
    <main className="min-h-screen px-4 sm:px-6 lg:px-8 py-10">
      <div className="max-w-[640px] mx-auto space-y-6">
        <header>
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-2">
            CoachBuild Live
          </p>
          <h1 className="text-2xl font-semibold text-txt tracking-[-0.02em]">
            Connect the desktop companion
          </h1>
          <p className="text-[13px] text-mut mt-2 leading-relaxed">
            A small PowerShell script that watches your League client for champ select and live
            games — no install, no login, no ads. Everything runs on your PC; CoachBuild only ever
            reads champion picks, roles, and item builds — never summoner names, cooldowns, or
            ability timers.
          </p>
          <p className="mt-2">
            <Link href="/" className="text-[12px] text-teal hover:underline">
              &larr; Back to Builds
            </Link>
          </p>
        </header>

        <section className="bg-panel border border-line rounded-xl p-5 space-y-5">
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Install</p>
          <CopyableCommand label="Run now (this session)" command={INSTALL_ONE_LINER} />
          <CopyableCommand label="Run now + auto-start on login" command={INSTALL_PERSISTENT} />
          <p className="text-[11px] text-mut leading-relaxed">
            Paste into PowerShell (Win+X &rarr; Terminal). Runs entirely in memory — nothing is
            written to disk unless you use the auto-start variant, which only adds a Startup
            shortcut (no admin rights needed).
          </p>
        </section>

        <section className="bg-panel border border-line rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">
              Connection
            </p>
            <span className="flex items-center gap-1.5 text-[11px] text-mut">
              <span className={`w-2 h-2 rounded-full ${INDICATOR_DOT[indicator]}`} aria-hidden="true" />
              {INDICATOR_LABEL[indicator]}
            </span>
          </div>

          <p className="text-[12px] text-mut leading-relaxed">
            Your browser will ask to allow CoachBuild to reach a local app on this PC (Chrome&apos;s
            Local Network Access permission) — this is expected the first time. Click{" "}
            <strong className="text-txt">Allow</strong>.
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
              No pairing session yet — open this page from the companion&apos;s tray menu, or from a
              champ-select auto-open link, first.
            </p>
          )}

          {probeState?.kind === "connected" && (
            <>
              <dl className="grid grid-cols-3 gap-3 text-[11px]">
                <div>
                  <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Version</dt>
                  <dd className="text-txt font-medium tabular-nums">{probeState.status.version}</dd>
                </div>
                <div>
                  <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Phase</dt>
                  <dd className="text-txt font-medium">{probeState.status.phase}</dd>
                </div>
                <div>
                  <dt className="text-mut uppercase tracking-[0.08em] text-[9.5px]">Client</dt>
                  <dd className="text-txt font-medium">
                    {probeState.status.clientConnected ? "Connected" : "Not detected"}
                  </dd>
                </div>
              </dl>

              {/* Diagnosability (v1.2.0-1.2.2) — lets us debug a "nothing
                  opens" report remotely from ONE screenshot, without a
                  screen-share: the most recent deep-link this companion
                  opened THIS launch, a live champ-select resolution
                  snapshot while phase is ChampSelect, the last poll-loop
                  heartbeat (the single most telling field — if this is
                  missing or stale, the real-mode loop itself is dead), and
                  the most recent unexpected failure message (e.g. an LCU
                  call dying at the TLS handshake). Subtle by design — this
                  is a debugging aid, not a feature most users need day to
                  day. */}
              {(probeState.status.lastOpen ||
                probeState.status.champSelect ||
                probeState.status.lastPollAt ||
                probeState.status.lastError) && (
                <div className="text-[10px] text-mut/70 space-y-0.5 pt-1 border-t border-line/50">
                  {probeState.status.lastPollAt && (
                    <p>Last poll: {new Date(probeState.status.lastPollAt).toLocaleTimeString()}</p>
                  )}
                  {probeState.status.lastOpen && (
                    <p>
                      Last opened: champion #{probeState.status.lastOpen.championId}, role{" "}
                      {probeState.status.lastOpen.roleId ?? "auto"} at{" "}
                      {new Date(probeState.status.lastOpen.at).toLocaleTimeString()}
                    </p>
                  )}
                  {probeState.status.champSelect && (
                    <p>
                      Champ select: cell #{probeState.status.champSelect.localPlayerCellId}, champion{" "}
                      {probeState.status.champSelect.cellChampionId ??
                        probeState.status.champSelect.pickIntent ??
                        probeState.status.champSelect.actionChampionId ??
                        "none yet"}
                      , role {probeState.status.champSelect.roleId ?? "auto"}
                    </p>
                  )}
                  {probeState.status.lastError && (
                    <p className="text-bad/80">Last error: {probeState.status.lastError}</p>
                  )}
                </div>
              )}
            </>
          )}

          {probeState?.kind === "lna-denied" && (
            <div className="text-[11.5px] text-bad space-y-1">
              <p>
                Blocked by your browser.
              </p>
              <p>
                <span className="font-semibold">Chrome / Edge:</span> click the lock icon in the
                address bar &rarr; Site settings &rarr; allow &quot;Local network access&quot;, then test again.
              </p>
              <p>
                <span className="font-semibold">Brave:</span> open{" "}
                <code className="text-[10.5px]">brave://settings/content/localhostAccess</code> and add{" "}
                <code className="text-[10.5px]">https://coachbuild.vercel.app</code> under
                &quot;Allowed to access localhost&quot; (Brave blocks silently instead of prompting), then reload
                and test again.
              </p>
              <p className="text-mut">
                This can also appear when the companion simply isn&apos;t running — check the system
                tray first before changing browser settings.
              </p>
            </div>
          )}

          {probeState?.kind === "no-companion" && (
            <p className="text-[11.5px] text-mut">
              Couldn&apos;t reach the companion. Make sure it&apos;s running (check your system tray)
              and try again.
            </p>
          )}
        </section>

        <section className="bg-panel border border-line rounded-xl p-5 space-y-3">
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Automation</p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoHydrated && autoItemSets}
              onChange={(e) => handleAutoItemSetsToggle(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-teal cursor-pointer"
            />
            <span>
              <span className="block text-[12.5px] text-txt font-medium">
                Auto-add item builds on champ select
              </span>
              <span className="block text-[11px] text-mut leading-relaxed mt-0.5">
                When you enter champ select, up to 3 item builds (Core, Optimized, Pro) are added to
                your in-client shop automatically — no click needed. This is a passive shop
                suggestion, same as Blitz/u.gg&apos;s auto-import; it never acts in the game for you.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoHydrated && autoRunes}
              onChange={(e) => handleAutoRunesToggle(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-teal cursor-pointer"
            />
            <span>
              <span className="block text-[12.5px] text-txt font-medium">Auto-apply runes on champ select</span>
              <span className="block text-[11px] text-mut leading-relaxed mt-0.5">
                Applies your recommended rune page automatically as you pick — <strong className="text-txt">your
                own pages are never touched automatically</strong>: it only ever replaces a page CoachBuild
                itself created before, or uses one of your free rune-page slots. If neither is available,
                nothing is touched and you&apos;ll get a quiet notice to click{" "}
                <strong className="text-txt">Apply runes</strong> instead, which can replace the current page
                (that&apos;s a real click, so that&apos;s always allowed).
              </span>
            </span>
          </label>
        </section>

        {errorLog.length > 0 && (
          <section className="bg-panel border border-line rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">
                Recent errors
              </p>
              <button
                type="button"
                onClick={handleClearErrorLog}
                className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mut hover:text-txt transition-colors"
              >
                Clear
              </button>
            </div>
            <p className="text-[11px] text-mut leading-relaxed">
              The last few times an &quot;Apply runes&quot; or &quot;Add item builds&quot; write failed on this
              device -- kept here so you can share it (a screenshot works) without needing PowerShell
              access to the companion&apos;s own log.
            </p>
            <ul className="space-y-1.5 text-[11px]">
              {[...errorLog]
                .reverse()
                .slice(0, 5)
                .map((entry, i) => (
                  <li key={`${entry.ts}-${i}`} className="border-t border-line/50 pt-1.5 first:border-t-0 first:pt-0">
                    <p className="text-mut/70 text-[10px]">
                      {new Date(entry.ts).toLocaleString()} &middot; {entry.kind}
                    </p>
                    <p className="text-bad/80">{entry.detail}</p>
                  </li>
                ))}
            </ul>
          </section>
        )}

        <section className="bg-panel border border-line rounded-xl p-5 space-y-3">
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">
            5-minute self-test
          </p>
          <ol className="space-y-2.5 text-[12.5px] text-txt list-decimal list-inside">
            <li>Run the one-liner above — a tray icon appears, no console window.</li>
            <li>
              Click <strong>Test connection</strong> above &rarr; allow the browser prompt &rarr;
              version and client status show above.
            </li>
            <li>
              Enter champ select in League — the Builds page opens automatically for your pick +
              role; changing your hover updates it; re-picking the same champion does not reopen it.
            </li>
            <li>
              On the Builds page, click <strong>Apply runes</strong> &rarr; your in-client rune page
              is replaced with &quot;CoachBuild &lt;champ&gt; &lt;role&gt;&quot; (a failed delete
              prompts you to remove the old page manually, then retry).
            </li>
            <li>
              Once the game starts, a live panel appears showing the enemy champions and roles —
              never names or timers — with build suggestions that highlight for the matchup when that data is available.
            </li>
          </ol>
        </section>
      </div>
    </main>
  );
}
