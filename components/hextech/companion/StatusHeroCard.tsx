"use client";

// ─────────────────────────────────────────────────────────────────────────────
// StatusHeroCard — /live-setup's gold-bordered hero (mockup 2.png): status
// dot + honest current-phase headline, SCRIPT/LAST POLL metadata top-right,
// and a 4-node "Client -> Lobby -> Champ Select -> In Game" progress rail.
//
// Deliberately takes already-resolved primitives (phase/clientConnected/
// version/lastPollAt/champion name+role), not a raw ProbeState/CompanionStatus
// object — keeps this component decoupled from companionClient.ts's wire
// shape so it renders the exact same way whether fed from the page's own
// passive poll or (if that ever changes) a different source.
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusHeroCardProps {
  clientConnected: boolean;
  /** Raw LCU gameflow phase string ("None" | "Lobby" | "Matchmaking" |
   *  "ReadyCheck" | "ChampSelect" | "GameStart" | "InProgress" |
   *  "WaitingForStats" | "EndOfGame"), or null when nothing has been
   *  reported yet. */
  phase: string | null;
  /** Already-resolved champion display name for a live champ-select, or null
   *  when in ChampSelect but nothing has resolved yet (an honest "picking"
   *  state, never a fabricated name). */
  champSelectChampionName?: string | null;
  champSelectRoleLabel?: string | null;
  /** Companion script version (CompanionStatus.version), or null before the
   *  first successful poll. */
  scriptVersion: string | null;
  /** ISO timestamp of the most recent successful poll, or null before the
   *  first one. */
  lastPollAt: string | null;
}

const LOBBY_PHASES = new Set(["Lobby", "Matchmaking", "ReadyCheck"]);
const IN_GAME_PHASES = new Set(["GameStart", "InProgress", "WaitingForStats", "EndOfGame"]);

/** 0 = not even connected, 1 = client only, 2 = lobby, 3 = champ select,
 *  4 = in game. An unrecognized phase string (future LCU phase this app
 *  doesn't know about yet) conservatively stays at 1 rather than guessing
 *  it means "further along." */
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour12: false });
}

interface Headline {
  title: string;
  sub: string;
  /** Reuses the same off/partial/connected dot vocabulary /live-setup's
   *  pre-redesign indicator already used (bg-mut/bg-teal/bg-win) — not the
   *  good/bad tokens, which are reserved for WPA/winrate signal only. */
  dot: "off" | "live" | "connected";
}

function headlineFor(
  clientConnected: boolean,
  phase: string | null,
  championName: string | null | undefined,
  role: string | null | undefined
): Headline {
  if (!clientConnected) {
    return {
      title: "Not connected yet",
      sub: "Run the install command below, then open your League client.",
      dot: "off",
    };
  }
  if (phase === "ChampSelect") {
    if (championName) {
      const suffix = role ? `, ${role}` : "";
      return {
        title: `Champ select detected — ${championName}${suffix}`,
        sub: "Runes and item sets are staged. They apply the moment you lock in.",
        dot: "live",
      };
    }
    return {
      title: "Champ select detected — picking…",
      sub: "Runes and item sets will stage the moment a champion resolves.",
      dot: "live",
    };
  }
  if (phase && IN_GAME_PHASES.has(phase)) {
    return {
      title: "In game",
      sub: "The companion is tracking this match — check Builds for a live enemy read.",
      dot: "connected",
    };
  }
  if (phase && LOBBY_PHASES.has(phase)) {
    return {
      title: "In lobby",
      sub: "Connected and waiting for champ select to start.",
      dot: "connected",
    };
  }
  return {
    title: "League client detected",
    sub: "Waiting for a lobby or champ select to begin.",
    dot: "connected",
  };
}

const DOT_CLASS: Record<Headline["dot"], string> = {
  off: "bg-mut",
  live: "bg-teal animate-pulse",
  connected: "bg-win",
};

const RAIL_NODES: { rank: number; label: string }[] = [
  { rank: 1, label: "Client" },
  { rank: 2, label: "Lobby" },
  { rank: 3, label: "Champ Select" },
  { rank: 4, label: "In Game" },
];

export default function StatusHeroCard({
  clientConnected,
  phase,
  champSelectChampionName,
  champSelectRoleLabel,
  scriptVersion,
  lastPollAt,
}: StatusHeroCardProps) {
  const headline = headlineFor(clientConnected, phase, champSelectChampionName, champSelectRoleLabel);
  const currentRank = phaseRank(phase, clientConnected);

  return (
    <section className="bg-panel border border-line-gold rounded-xl p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${DOT_CLASS[headline.dot]}`} aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-[16px] sm:text-[17px] font-bold text-txt tracking-[-0.01em]">{headline.title}</h2>
            <p className="text-[12.5px] text-mut mt-1 leading-relaxed max-w-[48ch]">{headline.sub}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0 text-[10.5px] text-mut uppercase tracking-[0.06em] leading-relaxed tabular-nums">
          <p>Script {scriptVersion ? `v${scriptVersion}` : "—"}</p>
          <p>Last poll {formatClock(lastPollAt)}</p>
        </div>
      </div>

      <div className="flex items-start w-full mt-5 pt-4 border-t border-line/60">
        {RAIL_NODES.map((node, i) => {
          const state = node.rank < currentRank ? "done" : node.rank === currentRank ? "current" : "future";
          const dotCls =
            state === "done" ? "bg-win" : state === "current" ? "bg-teal" : "bg-panel2 border border-line";
          const labelCls =
            state === "future" ? "text-mut/60" : state === "current" ? "text-teal font-semibold" : "text-txt/80";
          return (
            <div key={node.label} className={`flex items-center ${i < RAIL_NODES.length - 1 ? "flex-1" : "flex-shrink-0"}`}>
              <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                <span className={`w-2.5 h-2.5 rounded-full ${dotCls}`} aria-hidden="true" />
                <span className={`text-[9.5px] sm:text-[10px] uppercase tracking-[0.05em] whitespace-nowrap ${labelCls}`}>
                  {node.label}
                </span>
              </div>
              {i < RAIL_NODES.length - 1 && (
                <span
                  className={`h-px flex-1 mx-2 mb-4 ${node.rank < currentRank ? "bg-win/50" : "bg-line"}`}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
