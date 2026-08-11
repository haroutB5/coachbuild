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
import { useState, useSyncExternalStore } from "react";
import { Lightning } from "@phosphor-icons/react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import { hasSession, getStoredSession, getStoredPort, applyRunes } from "@/components/live/companionClient";
import { buildRuneApplyBody } from "../runeApplyBody";
import { readStoredRankBracketId } from "@/components/hextech/rankBracketStorage";
import { rankQueryParam } from "@/lib/rankBrackets";
import type { BuildResponse } from "@/lib/types";

type UiState = "idle" | "applying" | "success" | "error";

const subscribeToSession = () => () => {};

export default function ApplyRunesButton() {
  const companion = useCompanion();
  const ready = useSyncExternalStore(subscribeToSession, hasSession, () => false);
  const [state, setState] = useState<UiState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const championId = resolveCurrentChampSelectChampionId(companion.champSelect);
  const roleId = resolveChampSelectRoleId(companion.champSelect);
  const liveReady = companion.statusFresh && companion.phase === "ChampSelect" && championId !== null && roleId !== undefined;
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
      // P1-2 fix (2026-07-25 audit): this fetch used to always take the
      // no-rank (High-Elo) default, while AutoExporter.fetchBuildFor honors
      // the user's persisted rank bracket — both then call
      // buildRuneApplyBody with no pageSuffix, so this button and the
      // auto-exporter target the IDENTICAL LCU page title and the companion
      // PUTs in place on that exact-title match. Result: tapping this button
      // silently overwrote the bracket-correct page AutoExporter just wrote
      // with a High-Elo build, while still reporting "Applied in-client."
      // Two lines, copied verbatim from AutoExporter.fetchBuildFor so both
      // call sites can never drift apart again.
      const rank = readStoredRankBracketId();
      // Always appended — see rankQueryParam in lib/rankBrackets.ts (CDN cache key).
      const rankParam = rankQueryParam(rank);
      const res = await fetch(`/api/build?champ=${championId}&role=${roleId}${rankParam}`);
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

  // Desktop-only (`hidden lg:flex`, the same `lg` breakpoint DesktopRail/
  // MobileTabBar already split on) on every route — not a route-based rule.
  // companionClient.ts's applyRunes() PUTs to http://127.0.0.1:<port>, a
  // same-machine bridge to the League client. On a phone 127.0.0.1 is the
  // phone itself, where no League client will ever be running, so this
  // button can never succeed there — it would just be permanently-dead UI
  // occupying prime top-bar space on every mobile route.
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={message ?? (liveReady ? "Apply this champion's recommended runes" : "Waiting for champ select…")}
      aria-label="Apply runes for the current champ-select champion"
      className={`hidden h-[34px] flex-shrink-0 items-center gap-1.5 rounded-[8px] px-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:flex ${
        disabled
          ? "cursor-not-allowed text-accent-400/45 shadow-[inset_0_0_0_1px_rgba(145,132,217,0.35)]"
          : "text-accent-400 shadow-[inset_0_0_0_1px_var(--color-accent)] hover:bg-accent/[0.14] active:bg-accent/[0.22]"
      }`}
    >
      <Lightning aria-hidden="true" size={14} weight="light" />
      <span>{label}</span>
    </button>
  );
}
