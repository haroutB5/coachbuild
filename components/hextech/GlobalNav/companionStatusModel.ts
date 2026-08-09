// Pure model for the rail's companion status card. It deliberately keeps the
// provider's five-state vocabulary visible in the copy: unpaired,
// paired-no-client, client-detected, champ-select, and in-game. `statusFresh`
// is a hard gate; no cached phase can turn the card green after liveness has
// expired.
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
  /** False when the last successful /status poll is stale or absent. */
  statusFresh?: boolean;
}

export function companionStatusModel(input: CompanionStatusInput): CompanionStatusModel {
  const { session, phase, clientConnected, statusFresh = true } = input;

  if (session === null) {
    return {
      tone: "off",
      dotClass: "bg-mut",
      header: "COMPANION",
      title: "Not paired",
      subtitle: "Set up →",
      href: "/live-setup",
    };
  }

  if (!statusFresh) {
    return {
      tone: "off",
      dotClass: "bg-mut",
      header: "COMPANION",
      title: "Not responding",
      subtitle: "Check it's running →",
      href: "/live-setup",
    };
  }

  if (!clientConnected) {
    return {
      tone: "idle",
      dotClass: "bg-mut",
      header: "COMPANION",
      title: "Client not detected",
      subtitle: "Waiting for League client…",
    };
  }

  if (phase === "ChampSelect") {
    return {
      tone: "live",
      dotClass: "bg-win",
      header: "COMPANION LIVE",
      title: "In champ select",
      subtitle: "Locking in…",
    };
  }

  if (phase === "InProgress") {
    return {
      tone: "live",
      dotClass: "bg-win",
      header: "COMPANION LIVE",
      title: "In game",
      subtitle: "Live",
    };
  }

  return {
    tone: "idle",
    dotClass: "bg-win",
    header: "COMPANION READY",
    title: "Client detected",
    subtitle: "Waiting for queue…",
  };
}
