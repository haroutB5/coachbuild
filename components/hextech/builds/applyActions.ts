// ─────────────────────────────────────────────────────────────────────────────
// applyActions.ts — the ONE implementation of the Builds page's two real
// companion actions, plus the one state machine every button that runs them
// shares.
//
// Three buttons run these now:
//   · ChampionHero's IMPORT BUILD / APPLY RUNES pair (BuildVisuals'
//     BuildActionButtons)
//   · the Runes card's own "Apply runes" (BuildVisuals' ApplyRunesButton)
//   · ItemBuildCard's "Add to client"
//
// Before 2026-08-11 the hero pair were `scrollIntoView` calls wearing action
// labels, and the other two each carried their own copy of the same
// read-session / build-body / call-companion / map-the-result sequence. Adding
// a third copy for the hero was not an option, so the sequence moved here and
// the two existing buttons were converted to call it. If a fourth surface ever
// needs one of these actions, it calls this file — it does not copy it.
//
// WHAT IS *NOT* HERE. No fetch of /api/build. Both actions take an
// already-resolved BuildResponse, which is why nothing in this file touches
// `rank=` (lib/rankBrackets.ts's rankQueryParam) — there is exactly one
// /api/build call site on this page and it stays in BuildTabContent.
//
// EVERY EXTERNAL DEPENDENCY IS INJECTABLE, for one specific reason: this repo's
// vitest harness runs in `node` with no jsdom and no localStorage, and the
// success path of both actions cannot be observed in a browser without a paired
// League client. Injection is what lets a test assert that the EXACT
// buildRuneApplyBody payload reaches applyRunes, which is the part a human at a
// laptop with no League client running cannot see.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import { buildRuneApplyBody } from "@/components/hextech/runeApplyBody";
import { applyItemSetsForBuild } from "@/components/hextech/itemSetsApply";
import {
  applyRunes,
  getStoredPort,
  getStoredSession,
  type CompanionPort,
} from "@/components/live/companionClient";

/** Both actions answer the same question — did it work, and what do I tell the
 *  user — so they share one result shape. */
export type ApplyOutcome = { ok: true; message: string } | { ok: false; message: string };

export const NOT_PAIRED_MESSAGE = "Companion not connected — open /live-setup and reconnect.";

export interface ApplyDeps {
  getSession?: () => string | null;
  getPort?: () => CompanionPort | null;
  applyRunesImpl?: typeof applyRunes;
  applyItemSetsImpl?: typeof applyItemSetsForBuild;
}

function readCredentials(deps: ApplyDeps): { session: string; port: CompanionPort } | null {
  const session = (deps.getSession ?? getStoredSession)();
  const port = (deps.getPort ?? getStoredPort)();
  if (!session || port === null) return null;
  return { session, port };
}

/** Apply the rune page of the build the user is LOOKING AT.
 *
 *  Deliberately not GlobalNav/ApplyRunesButton.tsx's action, which resolves the
 *  LIVE champ-select champion from useCompanion() and fetches ITS build. That
 *  one is a champ-select shortcut and can target a different champion than the
 *  page shows; the hero button sits beside this champion's name and must mean
 *  this champion. Both still funnel into the same buildRuneApplyBody +
 *  companionClient.applyRunes pair, so the LCU payload contract has one owner.
 *
 *  `mode: "manual"` on purpose — a click is consent, which is what lets it
 *  overwrite a page the companion itself last wrote (see wiki/gotchas.md, the
 *  rune-overwrite guard in the companion's Invoke-ApplyRunes STEP 2). */
export async function applyRunesForBuild(build: BuildResponse, deps: ApplyDeps = {}): Promise<ApplyOutcome> {
  const creds = readCredentials(deps);
  if (!creds) return { ok: false, message: NOT_PAIRED_MESSAGE };

  let body: ReturnType<typeof buildRuneApplyBody>;
  try {
    // Throws rather than truncating on a malformed rune block — see
    // buildRuneApplyBody. A caught error here is the "the rune page cannot be
    // built" case the hero button must report instead of appearing to work.
    body = buildRuneApplyBody(build.champion.name, build.roleLabel, build.runes);
  } catch {
    return { ok: false, message: "Couldn't build a rune page from this build — try refreshing." };
  }

  const result = await (deps.applyRunesImpl ?? applyRunes)(creds.port, creds.session, body, "manual");
  if (!result.ok) {
    return { ok: false, message: result.hint ?? "Apply failed — try again, or set runes manually in-client." };
  }
  // A 2xx is not on its own a full success: the companion returns ok:true once
  // the page EXISTS, but the post-create selection PUT can still fail to stick.
  // Those two deserve different sentences.
  return {
    ok: true,
    message: result.selected && result.verified ? "Applied in-client." : "Saved as a rune page — open the client to select it.",
  };
}

/** Write this build into the League client as an item set — the action
 *  ItemBuildCard's "Add to client" already performed, unchanged. Everything
 *  downstream (pro/OTP consensus resolution, itemSetBody's block assembly, the
 *  champ-scoped replacePrefix) stays inside applyItemSetsForBuild. */
export async function importItemBuild(
  params: { champ: ChampionRef; lane: LaneId; build: BuildResponse },
  deps: ApplyDeps = {}
): Promise<ApplyOutcome> {
  const creds = readCredentials(deps);
  if (!creds) return { ok: false, message: NOT_PAIRED_MESSAGE };

  const result = await (deps.applyItemSetsImpl ?? applyItemSetsForBuild)({
    champ: params.champ,
    lane: params.lane,
    roleLabel: params.build.roleLabel,
    build: params.build,
    port: creds.port,
    session: creds.session,
  });
  return result.ok
    ? { ok: true, message: "Item build added — check your shop in game." }
    : { ok: false, message: result.hint ?? "Couldn't add item builds — try again, or add them manually in-client." };
}

// ── Can these actions run at all? ────────────────────────────────────────────

/** Why both actions are unavailable, or null when they can run.
 *
 *  THIS IS THE DEFECT'S ACTUAL FIX. A button that needs a paired companion and
 *  a resolved build, rendered live on a page that has neither, is the "dead
 *  control that claims to work" shape — and on a lane with no build data
 *  (Viktor SUPPORT) the old hero buttons did literally nothing at all. A
 *  consumer that gets a non-null string here must disable both buttons AND show
 *  the string; a tooltip alone does not count, because a disabled button does
 *  not reliably fire the hover that shows one.
 *
 *  Pairing is checked FIRST even on a lane with no build, because it is the one
 *  the user can act on from anywhere and it blocks both actions on every lane. */
export function applyBlockReason(input: {
  companionPaired: boolean;
  build: "loading" | "ready" | "unavailable";
  championName: string;
  laneLabel: string;
}): string | null {
  if (!input.companionPaired) return "Pair the CoachBuild companion (open Live setup) to import builds or apply runes.";
  if (input.build === "loading") return "Loading this build…";
  if (input.build === "unavailable") {
    return `No build data for ${input.championName} ${input.laneLabel} — there is nothing to import or apply.`;
  }
  return null;
}

// ── The shared state machine ─────────────────────────────────────────────────

export type ApplyPhase =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** How long a success/error message stays before the button returns to idle.
 *  3500ms, matching ItemBuildCard's and BuildVisuals' existing timers. */
export const APPLY_RESET_MS = 3500;

/** The label a control shows for a phase. `error -> "Retry"` is the existing
 *  convention (ItemBuildCard's AddToClientButton) and is kept: the button is
 *  still armed after a failure, and the message beside it says what failed. */
export function applyLabel(phase: ApplyPhase, labels: { idle: string; busy: string; done: string }): string {
  switch (phase.status) {
    case "applying":
      return labels.busy;
    case "success":
      return labels.done;
    case "error":
      return "Retry";
    default:
      return labels.idle;
  }
}

/** idle -> applying -> success|error -> (3.5s) -> idle, with the run guarded
 *  against double-fire and the timer cleared on unmount. Every button that runs
 *  one of the actions above uses this rather than its own copy. */
export function useApplyAction(): { phase: ApplyPhase; run: (action: () => Promise<ApplyOutcome>) => void } {
  const [phase, setPhase] = useState<ApplyPhase>({ status: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback((action: () => Promise<ApplyOutcome>) => {
    if (busy.current) return;
    busy.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    setPhase({ status: "applying" });
    void action()
      .then((outcome) => {
        if (!mounted.current) return;
        setPhase(outcome.ok ? { status: "success", message: outcome.message } : { status: "error", message: outcome.message });
      })
      .catch(() => {
        // Neither action rejects (both map failure into an ApplyOutcome), but a
        // silent hang here would leave the button stuck on "Applying…" forever,
        // which is the same lie in a new costume.
        if (mounted.current) setPhase({ status: "error", message: "Something went wrong — try again." });
      })
      .finally(() => {
        busy.current = false;
        if (!mounted.current) return;
        timer.current = setTimeout(() => {
          if (mounted.current) setPhase({ status: "idle" });
        }, APPLY_RESET_MS);
      });
  }, []);

  return { phase, run };
}
