// Pure phase-spine shaping. CompanionProvider reports the wire phases
// `None`, `ChampSelect`, and `InProgress` today; the PostGame alias is kept
// here so the shell is ready for the dedicated post-game surface without
// inventing a second state model.

export const PHASE_SPINE_STEPS = ["LOBBY", "CHAMP SELECT", "IN GAME", "POST GAME"] as const;

export type PhaseSpineStep = (typeof PHASE_SPINE_STEPS)[number];
export type PhaseSpineState = "complete" | "active" | "pending";

export interface PhaseSpineInput {
  phase: string | null;
  clientConnected: boolean;
  /** True only while the latest /status response is within the shared
   * companion freshness window. */
  statusFresh: boolean;
}

export interface PhaseSpineModel {
  currentIndex: number | null;
  states: PhaseSpineState[];
}

function currentIndex(input: PhaseSpineInput): number | null {
  if (!input.statusFresh) return null;

  // A fresh poll is enough to establish the lobby, but game phases also need
  // the companion to say the League client is connected. This mirrors the
  // status card's refusal to render a live state from a cached phase alone.
  if (!input.clientConnected) return 0;
  if (input.phase === "ChampSelect") return 1;
  if (input.phase === "InProgress") return 2;
  if (input.phase === "PostGame" || input.phase === "GameEnd") return 3;
  return 0;
}

export function phaseSpineModel(input: PhaseSpineInput): PhaseSpineModel {
  const index = currentIndex(input);

  if (index === null) {
    return { currentIndex: null, states: PHASE_SPINE_STEPS.map(() => "pending") };
  }

  return {
    currentIndex: index,
    states: PHASE_SPINE_STEPS.map((_, step) => (step < index ? "complete" : step === index ? "active" : "pending")),
  };
}
