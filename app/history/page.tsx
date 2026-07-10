"use client";

import { useState } from "react";
import type { ChampionRef } from "@/lib/types";
import TabNav from "@/components/TabNav";
import SegmentedControl from "@/components/SegmentedControl";
import PlayerPicker from "@/components/PlayerPicker";
import ChampionPicker from "@/components/ChampionPicker";
import LanePillRow from "@/components/LanePillRow";
import ProHistoryResults from "@/components/ProHistoryResults";
import type { PlayerRef } from "@/components/proHistory.types";

type Mode = "player" | "champion";

const LANE_LABEL: Record<number, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
  5: "All lanes",
};

function PromptState() {
  return (
    <div className="mt-6 glass-card rounded-2xl p-12 text-center">
      <div className="text-4xl mb-3 opacity-40" aria-hidden="true">
        🔍
      </div>
      <div className="text-txt font-semibold mb-1">
        Search a pro player or champion to see their recent games
      </div>
      <div className="text-mut text-sm">
        Try a name like &ldquo;Faker&rdquo; or a champion like &ldquo;Viktor&rdquo;.
      </div>
    </div>
  );
}

export default function HistoryPage() {
  const [mode, setMode] = useState<Mode>("player");
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const [champ, setChamp] = useState<ChampionRef | null>(null);
  const [lane, setLane] = useState<number>(5);

  const selected = mode === "player" ? player !== null : champ !== null;

  function clearSelection() {
    if (mode === "player") setPlayer(null);
    else setChamp(null);
  }

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1080px] mx-auto px-4 sm:px-6">
        {/* ── Top bar ── */}
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <TabNav />

          <div className="text-center mb-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-balance">
              Pro <span className="text-teal">History</span>
            </h1>
            <p className="text-mut text-sm mt-1">
              Recent games from tracked pros — search a player or champion.
            </p>
          </div>

          {/* Mode toggle */}
          <div className="flex justify-center mb-4">
            <SegmentedControl
              ariaLabel="Search by player or champion"
              value={mode}
              onChange={setMode}
              options={[
                { value: "player", label: "Player" },
                { value: "champion", label: "Champion" },
              ]}
            />
          </div>

          {/* Search controls */}
          <div className="flex flex-wrap items-center justify-center gap-4">
            {mode === "player" ? (
              <PlayerPicker value={player} onChange={setPlayer} />
            ) : (
              <>
                <ChampionPicker value={champ} onChange={setChamp} />
                <LanePillRow value={lane} onChange={setLane} />
              </>
            )}
          </div>
        </header>

        {/* ── Main content ── */}
        {!selected && <PromptState />}

        {selected && (
          <>
            <div className="flex items-center gap-3 mb-4 px-1">
              <p className="text-[13px] text-txt">
                {mode === "player" ? (
                  <>
                    Showing recent games by <span className="font-semibold">{player!.name}</span>
                  </>
                ) : (
                  <>
                    Showing recent games on <span className="font-semibold">{champ!.name}</span>
                    <span className="text-mut"> — {LANE_LABEL[lane]}</span>
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={clearSelection}
                className="ml-auto flex items-center justify-center w-6 h-6 rounded-md text-mut hover:text-txt hover:bg-panel2 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                aria-label="Clear selection"
              >
                ×
              </button>
            </div>

            {mode === "player" ? (
              <ProHistoryResults mode="player" playerId={player!.id} subjectLabel={player!.name} />
            ) : (
              <ProHistoryResults
                mode="champion"
                championId={champ!.id}
                championIcon={champ!.icon}
                role={lane}
                subjectLabel={champ!.name}
              />
            )}
          </>
        )}

        {/* ── Footer ── */}
        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Match data © coachless.gg / lolpros.gg / Riot Games. For personal use.</p>
          <p>Not endorsed by Riot Games.</p>
          <p>
            Pro-play match data from{" "}
            <a
              href="https://lol.fandom.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal hover:underline"
            >
              Leaguepedia
            </a>{" "}
            (CC BY-SA).
          </p>
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
          )}
        </footer>
      </div>
    </div>
  );
}
