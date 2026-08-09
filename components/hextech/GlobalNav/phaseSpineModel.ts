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
  /** Phases genuinely observed earlier in this companion session. The
   * current phase is counted as observed by this model when the poll is
   * fresh and the League client is connected. */
  observedPhases?: readonly string[];
}

export interface PhaseSpineModel {
  currentIndex: number | null;
  states: PhaseSpineState[];
}

function currentIndex(input: PhaseSpineInput): number | null {
  if (!input.statusFresh || !input.clientConnected) return null;

  // A phase is only an observation when it comes from a fresh poll with the
  // League client connected. `None` is the companion's idle/lobby phase;
  // null and unknown values do not establish any spine node.
  if (input.phase === "None" || input.phase === "Lobby") return 0;
  if (input.phase === "ChampSelect") return 1;
  if (input.phase === "InProgress") return 2;
  if (input.phase === "PostGame" || input.phase === "GameEnd") return 3;
  return null;
}

export function phaseSpineModel(input: PhaseSpineInput): PhaseSpineModel {
  const index = currentIndex(input);

  if (index === null) {
    return { currentIndex: null, states: PHASE_SPINE_STEPS.map(() => "pending") };
  }

  const observedSteps = new Set<number>();
  for (const phase of input.observedPhases ?? []) {
    const observedIndex = currentIndex({ ...input, phase });
    if (observedIndex !== null) observedSteps.add(observedIndex);
  }
  observedSteps.add(index);

  return {
    currentIndex: index,
    states: PHASE_SPINE_STEPS.map((_, step) =>
      step === index ? "active" : observedSteps.has(step) ? "complete" : "pending"
    ),
  };
}
