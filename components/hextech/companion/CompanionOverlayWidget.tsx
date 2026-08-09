import type { ReactNode } from "react";

export type OverlayAbility = "Q" | "W" | "E" | "R";
export type OverlayState = "next" | "ultimate" | "refusal";
export type OverlayScale = "base" | "compact";

export interface CompanionOverlayWidgetProps {
  championName: string;
  level: number | null;
  state: OverlayState;
  ability?: OverlayAbility | null;
  abilityName?: string | null;
  fromRank?: number | null;
  toRank?: number | null;
  scale?: OverlayScale;
  /** The green dot is reserved for a fresh, genuinely live reading. */
  liveSignal?: boolean;
  refusalLabel?: string;
  className?: string;
}

const ABILITIES: readonly OverlayAbility[] = ["Q", "W", "E", "R"];

function StateTile({
  ability,
  state,
  compact,
}: {
  ability: OverlayAbility | null;
  state: OverlayState;
  compact: boolean;
}) {
  const isUltimate = state === "ultimate";
  const isRefusal = state === "refusal";
  const radius = compact ? "rounded-[10px]" : "rounded-[9px]";

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center ${radius} font-semibold leading-none ${
        compact ? "h-16 w-16 text-[28px]" : "h-[46px] w-[46px] text-[20px]"
      } ${
        isUltimate
          ? "bg-accent text-[#191a28]"
          : isRefusal
            ? "border border-txt/[0.14] bg-txt/[0.04] text-txt/[0.50]"
            : "border border-accent/[0.55] text-accent-200"
      }`}
      style={
        !isUltimate && !isRefusal
          ? {
              background: "linear-gradient(150deg, #4a4380, #25243c)",
              boxShadow: "0 0 20px rgba(145,132,217,.3)",
            }
          : undefined
      }
    >
      {isRefusal ? "—" : ability ?? "—"}
    </span>
  );
}

function RankTransition({
  state,
  fromRank,
  toRank,
  compact,
}: {
  state: OverlayState;
  fromRank?: number | null;
  toRank?: number | null;
  compact: boolean;
}) {
  if (state === "refusal") {
    return <span className="text-txt/[0.48]">No safe recommendation</span>;
  }

  if (fromRank == null || toRank == null) {
    return <span className="text-accent-400">Awaiting rank read</span>;
  }

  return (
    <span className={`tabular-nums text-accent-400 ${compact ? "text-[17px]" : "text-[12px]"}`}>
      {fromRank} <span className="mx-1 text-accent-400/[0.75]" aria-hidden="true">→</span> {toRank}
    </span>
  );
}

function WidgetFooter({
  ability,
  state,
  compact,
}: {
  ability: OverlayAbility | null;
  state: OverlayState;
  compact: boolean;
}) {
  const radius = compact ? "rounded-[8px]" : "rounded-[7px]";
  return (
    <div className={`grid grid-cols-4 ${compact ? "gap-2" : "gap-1.5"}`} aria-hidden="true">
      {ABILITIES.map((entry) => {
        const active = state !== "refusal" && entry === ability;
        const ultimate = active && state === "ultimate";
        return (
          <span
            key={entry}
            className={`flex items-center justify-center ${radius} font-semibold ${
              compact ? "h-9 text-[15px]" : "h-[22px] text-[11px]"
            } ${
              ultimate
                ? "bg-accent text-[#191a28]"
                : active
                  ? "border border-accent bg-accent/[0.30] text-accent-200"
                  : "border border-txt/[0.06] bg-txt/[0.05] text-txt/[0.45]"
            }`}
          >
            {entry}
          </span>
        );
      })}
    </div>
  );
}

export default function CompanionOverlayWidget({
  championName,
  level,
  state,
  ability = null,
  abilityName,
  fromRank,
  toRank,
  scale = "base",
  liveSignal = false,
  refusalLabel,
  className = "",
}: CompanionOverlayWidgetProps) {
  const compact = scale === "compact";
  const title =
    state === "refusal" ? refusalLabel ?? "Refuses past level 15" : abilityName ?? "Next ability";
  const label = `CoachBuild overlay for ${championName}: ${title}`;

  return (
    <section
      aria-label={label}
      className={`text-txt ${compact ? "w-full max-w-[420px] rounded-[14px] p-5" : "w-[250px] rounded-[10px] p-3"} ${className}`}
      style={{
        background: "rgba(18,20,31,.88)",
        boxShadow: "0 0 0 1px rgba(145,132,217,.3), 0 10px 30px rgba(0,0,0,.55)",
      }}
    >
      <header className={`flex items-center justify-between gap-3 ${compact ? "mb-5" : "mb-3"}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`shrink-0 rounded-full ${compact ? "h-2 w-2" : "h-[5px] w-[5px]"} ${
              liveSignal ? "animate-pulse bg-good" : "bg-txt/[0.26]"
            }`}
            aria-hidden="true"
          />
          <span className={`truncate font-medium uppercase tracking-[0.14em] text-txt/[0.44] ${compact ? "text-[11px]" : "text-[8.5px]"}`}>
            CoachBuild · {championName}
          </span>
        </div>
        <span className={`shrink-0 tabular-nums font-medium text-txt/[0.44] ${compact ? "text-[12px]" : "text-[10px]"}`}>
          LV {level ?? "—"}
        </span>
      </header>

      <div className={`flex items-center ${compact ? "mb-5 gap-4" : "mb-3 gap-3"}`}>
        <StateTile ability={ability} state={state} compact={compact} />
        <div className="min-w-0">
          <p className={`truncate font-semibold text-txt ${compact ? "text-[17px]" : "text-[13px]"}`}>
            {title}
          </p>
          <RankTransition state={state} fromRank={fromRank} toRank={toRank} compact={compact} />
        </div>
      </div>

      <WidgetFooter ability={ability} state={state} compact={compact} />
    </section>
  );
}

export function OverlayWaiting({ message, scale = "compact" }: { message: ReactNode; scale?: OverlayScale }) {
  const compact = scale === "compact";
  return (
    <section
      role="status"
      className={`text-txt ${compact ? "w-full max-w-[420px] rounded-[14px] p-5" : "w-[250px] rounded-[10px] p-3"}`}
      style={{
        background: "rgba(18,20,31,.88)",
        boxShadow: "0 0 0 1px rgba(233,233,237,.10), 0 10px 30px rgba(0,0,0,.55)",
      }}
    >
      <div className={`flex items-center gap-2 uppercase tracking-[0.14em] text-txt/[0.44] ${compact ? "text-[11px]" : "text-[8.5px]"}`}>
        <span className={`shrink-0 rounded-full bg-txt/[0.24] ${compact ? "h-2 w-2" : "h-[5px] w-[5px]"}`} aria-hidden="true" />
        CoachBuild overlay
      </div>
      <p className={`mt-4 font-medium text-txt/[0.72] ${compact ? "text-[16px]" : "text-[12px]"}`}>{message}</p>
    </section>
  );
}
