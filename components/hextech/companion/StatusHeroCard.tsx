export interface StatusHeroCardProps {
  clientConnected: boolean;
  /** Raw LCU gameflow phase, or null when the companion has no fresh read. */
  phase: string | null;
  champSelectChampionName?: string | null;
  champSelectRoleLabel?: string | null;
  scriptVersion: string | null;
  lastPollAt: string | null;
  /** Hard freshness gate: stale status cannot keep the hero green. */
  statusFresh?: boolean;
}

const LOBBY_PHASES = new Set(["Lobby", "Matchmaking", "ReadyCheck"]);
const IN_GAME_PHASES = new Set(["GameStart", "InProgress", "WaitingForStats", "EndOfGame"]);

const RAIL_NODES = [
  { rank: 1, label: "Client" },
  { rank: 2, label: "Lobby" },
  { rank: 3, label: "Champ Select" },
  { rank: 4, label: "In Game" },
] as const;

function phaseRank(phase: string | null, clientConnected: boolean): number {
  if (!clientConnected) return 0;
  if (!phase || phase === "None") return 1;
  if (LOBBY_PHASES.has(phase)) return 2;
  if (phase === "ChampSelect") return 3;
  if (IN_GAME_PHASES.has(phase)) return 4;
  return 1;
}

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString(undefined, { hour12: false });
}

function headlineFor(
  clientConnected: boolean,
  phase: string | null,
  championName: string | null | undefined,
  role: string | null | undefined,
  statusFresh: boolean,
  hasPollEvidence: boolean
) {
  if (!statusFresh && hasPollEvidence) {
    return {
      title: "Companion not responding",
      sub: "Check that it is running, then test the connection again.",
    };
  }
  if (!statusFresh || !clientConnected) {
    return {
      title: "Not connected yet",
      sub: "Install the desktop app below, then open your League client.",
    };
  }
  if (phase === "ChampSelect") {
    const selection = championName ? ` · ${championName}${role ? `, ${role}` : ""}` : "";
    return {
      title: `Connected · following champ select${selection}`,
      sub: "Runes and item sets stage for your pick and apply only when you ask them to.",
    };
  }
  if (phase && IN_GAME_PHASES.has(phase)) {
    return {
      title: "Connected · in game",
      sub: "The overlay is focused on the next legal ability point from your own live read.",
    };
  }
  if (phase && LOBBY_PHASES.has(phase)) {
    return {
      title: "Connected · in lobby",
      sub: "Waiting for champ select to start.",
    };
  }
  return {
    title: "Connected · League client detected",
    sub: "Waiting for a lobby or champ select to begin.",
  };
}

export default function StatusHeroCard({
  clientConnected,
  phase,
  champSelectChampionName,
  champSelectRoleLabel,
  scriptVersion,
  lastPollAt,
  statusFresh = true,
}: StatusHeroCardProps) {
  const genuinelyConnected = statusFresh && clientConnected;
  const headline = headlineFor(
    genuinelyConnected,
    statusFresh ? phase : null,
    champSelectChampionName,
    champSelectRoleLabel,
    statusFresh,
    Boolean(scriptVersion || lastPollAt)
  );
  const currentRank = phaseRank(statusFresh ? phase : null, genuinelyConnected);
  const hasMetadata = Boolean(scriptVersion || lastPollAt);

  return (
    <section
      className="rounded-[10px] p-5 sm:p-6"
      style={
        genuinelyConnected
          ? {
              background: "linear-gradient(150deg, rgba(70,199,155,.10), rgba(35,37,50,.90))",
              boxShadow: "inset 0 0 0 1px rgba(70,199,155,.24)",
            }
          : {
              background: "linear-gradient(150deg, rgba(233,233,237,.04), rgba(27,29,42,.96))",
              boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)",
            }
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full ${
              genuinelyConnected ? "animate-pulse bg-good" : "bg-txt/[0.20]"
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-txt">{headline.title}</h2>
            <p className="mt-1 max-w-[54ch] text-[12.5px] leading-relaxed text-mut">{headline.sub}</p>
          </div>
        </div>
        {hasMetadata && (
          <dl className="shrink-0 text-right text-[10px] font-medium uppercase leading-relaxed tracking-[0.06em] text-mut tabular-nums">
            <div>
              <dt className="sr-only">Script version</dt>
              <dd>Script {scriptVersion ? `v${scriptVersion}` : "—"}</dd>
            </div>
            <div>
              <dt className="sr-only">Last poll</dt>
              <dd>Last poll {formatClock(lastPollAt)}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="mt-5 border-t border-txt/[0.08] pt-4">
        <div className="flex w-full items-start">
          {RAIL_NODES.map((node, index) => {
            const state = node.rank < currentRank ? "complete" : node.rank === currentRank ? "active" : "pending";
            const complete = state === "complete";
            const active = state === "active";
            return (
              <div key={node.label} className={`flex items-start ${index < RAIL_NODES.length - 1 ? "min-w-0 flex-1" : "shrink-0"}`}>
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <span
                    className={`h-[15px] w-[15px] rounded-full ${
                      complete
                        ? "border-2 border-good bg-good/20"
                        : active
                          ? "border-2 border-accent bg-accent/20 shadow-[0_0_10px_2px_rgba(145,132,217,.55)]"
                          : "border border-txt/[0.18] bg-transparent"
                    }`}
                    aria-hidden="true"
                  />
                  <span
                    className={`whitespace-nowrap text-[9px] font-medium uppercase tracking-[0.10em] ${
                      complete ? "text-good" : active ? "font-semibold text-accent-400" : "text-txt/[0.32]"
                    }`}
                  >
                    {node.label}
                  </span>
                </div>
                {index < RAIL_NODES.length - 1 && (
                  <span
                    className={`mx-2 mt-[7px] h-px min-w-3 flex-1 ${
                      complete ? "bg-good/[0.48]" : active ? "bg-gradient-to-r from-accent/[0.50] to-txt/[0.08]" : "bg-txt/[0.08]"
                    }`}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
