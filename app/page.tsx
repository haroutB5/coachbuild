"use client";

import { useState, useEffect, useCallback } from "react";
import type { BuildResponse, ChampionRef, RoleId } from "@/lib/types";
import { ROLE_LABEL } from "@/lib/types";
import ChampionPicker from "@/components/ChampionPicker";
import RoleSelector from "@/components/RoleSelector";
import BuildCard from "@/components/BuildCard";
import ProGamesSection from "@/components/ProGamesSection";
import TabNav from "@/components/TabNav";

function ImgWithFallback({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

// Loading skeleton — mimics the card layout
function LoadingSkeleton() {
  return (
    <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.35)] mt-6 p-5 animate-pulse">
      <div className="h-4 w-1/3 bg-line rounded mb-6" />
      <div className="flex gap-8 mb-6">
        <div className="flex-1 space-y-3">
          <div className="h-3 w-1/4 bg-line rounded" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="w-16 h-16 rounded-full bg-line" />
            ))}
          </div>
        </div>
        <div className="flex-1 space-y-3">
          <div className="h-3 w-1/4 bg-line rounded" />
          <div className="flex gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="w-16 h-16 rounded-full bg-line" />
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="w-14 h-14 rounded-xl bg-line" />
        ))}
      </div>
    </div>
  );
}

// Empty state when API returns no data for a champ+role combo
function EmptyState({ champ, role }: { champ: string; role: string }) {
  return (
    <div className="mt-6 bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl p-10 text-center">
      <div className="text-4xl mb-3 opacity-40">📊</div>
      <div className="text-txt font-semibold mb-1">
        Not enough data for {champ} {role}
      </div>
      <div className="text-mut text-sm">
        Try a different lane, or check{" "}
        <a
          href="https://coachless.gg"
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal hover:underline"
        >
          coachless.gg
        </a>{" "}
        directly.
      </div>
    </div>
  );
}


type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: BuildResponse[] }
  | { status: "empty"; champ: string; role: string }
  | { status: "error"; champ: string; role: string };

// Landing default: load live Viktor Mid so the page shows real data on first
// paint and the lane pills work immediately (no inert sample state).
const DEFAULT_CHAMP: ChampionRef = {
  id: 112,
  key: "Viktor",
  name: "Viktor",
  icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp",
};

export default function HomePage() {
  const [champ, setChamp] = useState<ChampionRef | null>(DEFAULT_CHAMP);
  const [role, setRole] = useState<RoleId>(2);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });

  const loadBuild = useCallback(async (c: ChampionRef, r: RoleId) => {
    setFetchState({ status: "loading" });
    try {
      const res = await fetch(`/api/build?champ=${c.id}&role=${r}`);
      // 404 = not played / not enough data — always show EmptyState, never sample
      if (res.status === 404) {
        setFetchState({ status: "empty", champ: c.name, role: ROLE_LABEL[r] });
        return;
      }
      // 5xx or other non-ok = genuine server error
      if (!res.ok) {
        setFetchState({ status: "error", champ: c.name, role: ROLE_LABEL[r] });
        return;
      }
      const data: BuildResponse[] = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        setFetchState({ status: "empty", champ: c.name, role: ROLE_LABEL[r] });
        return;
      }
      setFetchState({ status: "ok", data });
    } catch {
      setFetchState({ status: "error", champ: c.name, role: ROLE_LABEL[r] });
    }
  }, []);

  // Fetch whenever champ or role changes (skip if no champ chosen yet)
  useEffect(() => {
    if (!champ) return;
    loadBuild(champ, role);
  }, [champ, role, loadBuild]);

  // Display builds: live data only — never show sample on failed fetch
  const displayBuilds: BuildResponse[] | null =
    fetchState.status === "ok" ? fetchState.data : null;

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1080px] mx-auto px-4 sm:px-6">
        {/* ── Top bar ── */}
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <TabNav />
          <div className="flex items-center justify-center gap-4 mb-4">
            {champ && (
              <div className="relative flex-shrink-0">
                <ImgWithFallback
                  src={champ.icon}
                  alt={champ.name}
                  className="w-16 h-16 rounded-xl border-2 border-teal-dim shadow-[0_0_24px_rgba(45,212,191,0.25)] object-cover"
                />
              </div>
            )}
            <div className="text-center">
              <h1 className="text-3xl font-extrabold tracking-tight">
                {champ ? (
                  <>
                    {champ.name}
                    {role !== 5 && (
                      <>
                        {" "}
                        <span className="text-teal">{ROLE_LABEL[role]}</span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-teal">CoachBuild</span>
                )}
              </h1>
              <p className="text-mut text-sm mt-1">
                Highest win-probability runes, items & spells — data from{" "}
                <a
                  href="https://coachless.gg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal hover:underline"
                >
                  coachless.gg
                </a>
              </p>
            </div>
          </div>

          {/* Champion + Role selector row */}
          <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
            <ChampionPicker
              value={champ}
              onChange={(c) => {
                setChamp(c);
                // Reset role to auto when picking a new champ
                setRole(5);
              }}
            />
            <RoleSelector
              value={role}
              onChange={(r) => {
                setRole(r);
              }}
            />
          </div>

          {/* WPA explanation */}
          <p className="text-center text-[12.5px] text-mut mt-4 max-w-[720px] mx-auto">
            <strong className="text-txt">WPA (Win Probability Added)</strong> — coachless.gg&apos;s
            deep-learning measure of how much each choice shifts your win odds, controlling for game
            state. Positive = adds win %. Sample size shown under each pick.
          </p>
        </header>

        {/* ── Main content ── */}
        {fetchState.status === "loading" && <LoadingSkeleton />}

        {fetchState.status === "empty" && (
          <EmptyState champ={fetchState.champ} role={fetchState.role} />
        )}

        {fetchState.status === "error" && (
          <div className="mt-6 bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl p-10 text-center">
            <div className="text-4xl mb-3 opacity-40">⚠️</div>
            <div className="text-txt font-semibold mb-1">
              Couldn&apos;t load — try again
            </div>
            <div className="text-mut text-sm">
              Something went wrong fetching{" "}
              {fetchState.champ} {fetchState.role}. Check your connection and refresh.
            </div>
          </div>
        )}

        {fetchState.status === "ok" && displayBuilds && (
          <>
            {displayBuilds.length > 1 && (
              <p className="text-center text-[12px] text-mut mt-6 -mb-2">
                Top {displayBuilds.length} setups — ranked by confidence-weighted WPA
              </p>
            )}
            {displayBuilds.map((b, i) => (
              <section key={`${b.champion.id}-${b.runes.secondaryTree.id}-${i}`} className="mt-6">
                <div className="flex items-baseline gap-3 mb-2 px-1">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-teal text-[#06231f] font-extrabold text-sm">
                    {b.rank ?? i + 1}
                  </span>
                  <span className="font-bold text-txt">{b.label ?? `Option ${i + 1}`}</span>
                  {b.subtitle && (
                    <span className="text-mut text-[13px]">{b.subtitle}</span>
                  )}
                </div>
                <BuildCard build={b} />
              </section>
            ))}

            {/* Pro Games — recent tracked soloQ games on this champion+role.
                NOTE: displayBuilds[0].role echoes the REQUEST role verbatim
                (lib/recommend.ts does not resolve auto), so this is 5 after
                every champion pick. /api/pros treats 5 as "all lanes". */}
            {champ && (
              <ProGamesSection
                championId={champ.id}
                championName={champ.name}
                role={displayBuilds[0].role}
              />
            )}
          </>
        )}

        {/* ── Footer ── */}
        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Build data and icons © coachless.gg / Riot Games. For personal use.</p>
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
