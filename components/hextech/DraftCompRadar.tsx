"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DraftCompRadar — "TEAM COMPOSITION STRENGTHS" 6-axis radar (plan §2.2/§3).
// Pure SVG, no chart lib (dataviz skill consulted: a radar is a shape/profile
// read, not a magnitude-across-many-series read, so this deliberately does
// NOT follow the sequential-hue-ramp recipe — it's a single accent-filled
// polygon + an optional dashed comparison outline, which keeps identity on
// STRUCTURE (fill vs outline) rather than on color alone, per the skill's
// "identity is never color-alone" rule). Geometry/copy pure functions live in
// the sibling draftRadarGeom.ts (JSX-free, see that file's header for why).
//
// Data dependency (plan §4/§8): `aggregateEnemyComp` is a pure, static,
// client-safe lookup (lib/draft/compRatings.ts, engo's Stage 0 file) — NOT
// wired through /api/draft/recommend, so this component calls it directly
// rather than waiting on a wire field.
// ─────────────────────────────────────────────────────────────────────────────

import { aggregateEnemyComp, type AggregatedComp } from "@/lib/draft/compRatings";
import {
  RADAR_AXES,
  RADAR_SIZE,
  RADAR_CX,
  RADAR_CY,
  RADAR_RING_FRACTIONS,
  axisPoint,
  buildPolygonPoints,
  buildGridRingPoints,
  estimatedFootnote,
} from "./draftRadarGeom";

interface DraftCompRadarProps {
  /** Enemy champion ids currently entered (order-preserved, ≤5 per
   *  MAX_DRAFT_ENEMIES — draftLiveSync.ts). */
  enemyIds: number[];
  /** The user's own hovered/locked champion — renders a second, dashed
   *  comparison outline when set (plan §5.5), never a second solid fill
   *  (avoids two overlapping fills reading as one muddy blob). */
  hoverChampId: number | null;
}

function polygonFor(ids: number[]): { comp: AggregatedComp } | null {
  if (ids.length === 0) return null;
  return { comp: aggregateEnemyComp(ids) };
}

export default function DraftCompRadar({ enemyIds, hoverChampId }: DraftCompRadarProps) {
  const enemyResult = polygonFor(enemyIds);
  const hoverResult = hoverChampId !== null ? polygonFor([hoverChampId]) : null;

  return (
    <div className="dt-panel p-5">
      <div className="flex items-center justify-between gap-3 mb-1">
        <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-mut)] font-semibold">
          Team composition strengths
        </p>
      </div>
      <p className="text-[10.5px] text-[color:var(--dt-mut)] mb-3">Team profile — curated kit ratings, not a stat.</p>

      {!enemyResult ? (
        <div className="py-10 text-center text-[12px] text-[color:var(--dt-mut)]">
          Add enemies to see their team profile.
        </div>
      ) : (
        <>
          <div className="flex justify-center">
            <svg
              viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
              width={RADAR_SIZE}
              height={RADAR_SIZE}
              role="img"
              // Audit P2-2: the shape IS the information — the label must carry
              // the per-axis VALUES, not just the axis names, or the profile is
              // imperceivable without the SVG (0-3 scale per the curated rubric).
              aria-label={`Enemy team composition profile (0-3 scale): ${RADAR_AXES.map(
                (a) => `${a.label} ${enemyResult.comp[a.key].toFixed(1)}`
              ).join(", ")}${
                hoverResult
                  ? `. Your champion: ${RADAR_AXES.map((a) => `${a.label} ${hoverResult.comp[a.key].toFixed(1)}`).join(", ")}`
                  : ""
              }`}
              className="max-w-full h-auto"
            >
              {/* grid rings */}
              {RADAR_RING_FRACTIONS.map((f) => (
                <polygon key={f} points={buildGridRingPoints(f)} fill="none" stroke="var(--dt-line)" strokeWidth={1} />
              ))}
              {/* spokes */}
              {RADAR_AXES.map((axis) => {
                const i = RADAR_AXES.indexOf(axis);
                const p = axisPoint(i, 1);
                return <line key={axis.key} x1={RADAR_CX} y1={RADAR_CY} x2={p.x} y2={p.y} stroke="var(--dt-line)" strokeWidth={1} />;
              })}
              {/* enemy comp — solid cyan fill, the primary series */}
              <polygon
                points={buildPolygonPoints(enemyResult.comp)}
                fill="var(--dt-cyan)"
                fillOpacity={0.22}
                stroke="var(--dt-cyan)"
                strokeWidth={1.75}
                strokeLinejoin="round"
              />
              {/* your champion — dashed outline only, structural (not color)
                  distinction from the enemy fill per dataviz's identity rule */}
              {hoverResult && (
                <polygon
                  points={buildPolygonPoints(hoverResult.comp)}
                  fill="none"
                  stroke="var(--dt-txt)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  strokeLinejoin="round"
                />
              )}
              {/* axis labels */}
              {RADAR_AXES.map((axis) => {
                const i = RADAR_AXES.indexOf(axis);
                const p = axisPoint(i, 1.22);
                return (
                  <text
                    key={axis.key}
                    x={p.x}
                    y={p.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10.5}
                    fontWeight={600}
                    fill="var(--dt-mut)"
                    style={{ letterSpacing: "0.02em" }}
                  >
                    {axis.label}
                  </text>
                );
              })}
            </svg>
          </div>

          {hoverResult && (
            <div className="flex items-center justify-center gap-4 mt-2 text-[10.5px] text-[color:var(--dt-mut)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--dt-cyan)", opacity: 0.7 }} aria-hidden="true" />
                Enemy team
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-sm border border-dashed"
                  style={{ borderColor: "var(--dt-txt)" }}
                  aria-hidden="true"
                />
                Your pick
              </span>
            </div>
          )}

          {estimatedFootnote(enemyResult.comp, enemyIds.length) && (
            <p className="text-[10px] text-[color:var(--dt-mut)] text-center mt-2">
              {estimatedFootnote(enemyResult.comp, enemyIds.length)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
