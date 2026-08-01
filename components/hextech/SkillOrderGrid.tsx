import SkillGrid from "@/components/SkillGrid";
import {
  LOW_SAMPLE_THRESHOLD,
  buildRecommendedSkillGrid,
  formatPriorityString,
  hasDerivedTail,
  inferredTailRange,
  type SkillOrderModel,
} from "./skillOrder";

interface SkillOrderGridProps {
  model: SkillOrderModel;
  /** Exact denominator/copy for this surface, without any rounding here. */
  sampleLabel: string;
  /** Builds explains an incomplete recommendation as champion uncertainty;
   *  recorded surfaces explain a level that no sampled timeline reached. */
  missingLevelsContext?: "champion" | "recorded sample";
}

/**
 * The shared skill-order presentation: priority headline, 4×18 grid,
 * provenance disclosures, and the surface-owned sample label. It knows nothing
 * about champions or where the model came from; callers own fetching and the
 * denominator wording.
 */
export default function SkillOrderGrid({ model, sampleLabel, missingLevelsContext = "champion" }: SkillOrderGridProps) {
  const lowSample = model.sampleSize < LOW_SAMPLE_THRESHOLD;
  const grid = buildRecommendedSkillGrid(model);
  const derivedTail = hasDerivedTail(model);
  const inferred = inferredTailRange(model);
  const knownLevels = model.order.length + (model.inferredTail?.length ?? 0);
  const incompleteGrid = knownLevels < 18;

  return (
    <>
      <p
        className="text-[20px] font-semibold tracking-[-0.01em] text-txt mb-4"
        aria-label={`Skill priority: ${model.priority.join(", then ")}`}
      >
        {formatPriorityString(model.priority)}
      </p>

      <SkillGrid grid={grid} className="max-w-[560px]" />

      {inferred && (
        <p className="text-[10.5px] text-gold/70 mt-3 flex items-start gap-1">
          <span aria-hidden="true">⚠</span>
          <span>
            The source publishes levels 1–{model.order.length} only, and this champion&apos;s last
            points can&apos;t be worked out from them. Level{inferred.from === inferred.to ? " " : "s "}
            <span className="tabular-nums">
              {inferred.from === inferred.to ? inferred.from : `${inferred.from}–${inferred.to}`}
            </span>{" "}
            {inferred.from === inferred.to ? "is" : "are"} inferred from{" "}
            {model.inferredBasis === "published"
              ? "the champion's published max order"
              : "the levelling path above"}{" "}
            (dashed) — a best guess, not recorded data.
          </span>
        </p>
      )}

      {incompleteGrid && (
        <p className="text-[10.5px] text-gold/70 mt-3 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          <span className="tabular-nums">
            Levels {knownLevels + 1}–18 are unknown {missingLevelsContext === "champion" ? "for this champion" : "in this recorded sample"} and left blank.
          </span>
        </p>
      )}

      {derivedTail && (
        <p className="text-[10.5px] text-mut/70 mt-3">
          {model.completionBasis === "published"
            ? "Outlined levels are derived from this champion's published max order, not recorded"
            : model.completionBasis === "derived"
              ? "Outlined levels are derived from this champion's levelling path, not recorded"
              : "Outlined levels are derived, not recorded"}
          {" — the source publishes levels 1–15 only."}
        </p>
      )}

      {lowSample && (
        <p className="text-[10.5px] text-gold/70 mt-2 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Low sample size — treat this order with caution.
        </p>
      )}

      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line tabular-nums">
        From {sampleLabel}
      </p>
    </>
  );
}
