"use client";

// TopBar's global "⚡ APPLY RUNES" action — resolves the LIVE champ-select
// champion+role straight from useCompanion() (never from whatever champion
// happens to be showing on the current page), fetches that champion's
// recommended build, and pushes it through the EXACT SAME apply pipeline
// RunesSummonersCard's "Apply runes" button already uses
// (companionClient.applyRunes + runeApplyBody.ts's buildRuneApplyBody) — the
// LCU 4KB budget + suppression logic those modules own is untouched here.
//
// Disabled whenever there's no session, no live champ select, or the
// champ-select champion hasn't resolved a role yet (no role -> no lane -> no
// /api/build query to make). This is a convenience shortcut for "apply
// whatever champ select currently shows," not a replacement for the
// per-card Apply buttons on the Builds page (which apply whatever build the
// user is actively LOOKING at, live or not).
import { useEffect, useState } from "react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import { hasSession, getStoredSession, getStoredPort, applyRunes } from "@/components/live/companionClient";
import { buildRuneApplyBody } from "../runeApplyBody";
import type { BuildResponse } from "@/lib/types";

type UiState = "idle" | "applying" | "success" | "error";

export default function ApplyRunesButton() {
  const companion = useCompanion();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<UiState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setReady(hasSession());
  }, [companion.session]);

  const championId = resolveCurrentChampSelectChampionId(companion.champSelect);
  const roleId = resolveChampSelectRoleId(companion.champSelect);
  const liveReady = companion.phase === "ChampSelect" && championId !== null && roleId !== undefined;
  const disabled = !ready || !liveReady || state === "applying";

  async function handleClick() {
    if (!liveReady || championId === null || roleId === undefined) return;
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState("error");
      setMessage("Companion not connected — open /live-setup.");
      window.setTimeout(() => setState("idle"), 3500);
      return;
    }

    setState("applying");
    try {
      const res = await fetch(`/api/build?champ=${championId}&role=${roleId}`);
      if (!res.ok) throw new Error(`build ${res.status}`);
      const data: BuildResponse[] = await res.json();
      const build = Array.isArray(data) ? data[0] : undefined;
      if (!build) throw new Error("no build data");

      const body = buildRuneApplyBody(build.champion.name, build.roleLabel, build.runes);
      const result = await applyRunes(port, session, body, "manual");
      if (result.ok) {
        setState("success");
        setMessage(result.selected && result.verified ? "Applied in-client." : "Saved — open the client to select it.");
      } else {
        setState("error");
        setMessage(result.hint ?? "Apply failed — try again.");
      }
    } catch {
      setState("error");
      setMessage("Couldn't load a build for this champion/lane.");
    }
    window.setTimeout(() => {
      setState("idle");
      setMessage(null);
    }, 3500);
  }

  const label = state === "applying" ? "Applying…" : state === "success" ? "Applied" : state === "error" ? "Failed" : "Apply runes";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={message ?? (liveReady ? "Apply this champion's recommended runes" : "Waiting for champ select…")}
      aria-label="Apply runes for the current champ-select champion"
      className={`flex-shrink-0 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.05em] rounded-lg px-3 py-2 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar ${
        disabled ? "bg-panel2 text-mut cursor-not-allowed" : "bg-teal text-bg hover:bg-teal-hover"
      }`}
    >
      <span aria-hidden="true">⚡</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
