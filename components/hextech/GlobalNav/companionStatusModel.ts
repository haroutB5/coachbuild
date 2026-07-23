// Pure model for the rail's companion status card (v0.50.0, plan Decision 3).
// PLAN DEVIATION: the plan named this file `companionStatusCard.ts`, but
// Windows' case-insensitive filesystem collides that with the sibling
// `CompanionStatusCard.tsx` component (tsc TS1149) — renamed to
// `companionStatusModel.ts` (matches the exported function name) instead.
// Reads ONLY real useCompanion() fields — never fabricates a state the
// companion hasn't actually reported. Mirrors /live-setup's own dot-color
// vocabulary (app/live-setup/page.tsx's INDICATOR_DOT: bg-mut grey / bg-teal
// gold / bg-win green) rather than inventing a new palette, so "connected"
// means the same thing in both places.
//
// IMPROVEMENT over the mockup (which shows the card always-green): the
// mockup's card doesn't distinguish "paired but nothing detected yet" from
// "actually live" — this degrades honestly instead, and an unpaired card
// links to /live-setup (the mockup has no such affordance).
export type CompanionTone = "off" | "idle" | "live";

export interface CompanionStatusModel {
  tone: CompanionTone;
  dotClass: string;
  header: string;
  title: string;
  subtitle: string;
  href?: string;
}

export interface CompanionStatusInput {
  session: string | null;
  phase: string | null;
  clientConnected: boolean;
  champSelect: unknown | null;
}

export function companionStatusModel(input: CompanionStatusInput): CompanionStatusModel {
  const { session, phase, clientConnected } = input;

  if (session === null) {
    return {
      tone: "off",
      dotClass: "bg-mut",
      header: "COMPANION · OFF",
      title: "Not paired",
      subtitle: "Set up →",
      href: "/live-setup",
    };
  }

  if (!clientConnected) {
    return {
      tone: "idle",
      dotClass: "bg-teal",
      header: "COMPANION · ON",
      title: "Client not detected",
      subtitle: "Waiting for League client…",
    };
  }

  if (phase === "ChampSelect") {
    return {
      tone: "live",
      dotClass: "bg-win",
      header: "COMPANION · ON",
      title: "In champ select",
      subtitle: "Locking in…",
    };
  }

  if (phase === "InProgress") {
    return {
      tone: "live",
      dotClass: "bg-win",
      header: "COMPANION · ON",
      title: "In game",
      subtitle: "Live",
    };
  }

  return {
    tone: "idle",
    dotClass: "bg-win",
    header: "COMPANION · ON",
    title: "Client detected",
    subtitle: "Waiting for queue…",
  };
}
