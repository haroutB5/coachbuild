// ─────────────────────────────────────────────────────────────────────────────
// draftRadarGeom.ts — pure SVG geometry + copy for DraftCompRadar.tsx. Split
// out of the .tsx component (plain .ts, no JSX) because this repo's vitest
// config can't parse JSX inside a .tsx module from a .ts test importer (see
// components/__tests__/patchMoversFormat.test.ts / hextech/patchMoversFormat.ts
// for the established convention this file follows) — confirmed live: the
// same functions defined inline inside DraftCompRadar.tsx failed to import
// with "Failed to parse source for import analysis... invalid JS syntax"
// the moment the component file gained a JSX return.
// ─────────────────────────────────────────────────────────────────────────────

import type { AggregatedComp, CompRatingVector } from "@/lib/draft/compRatings";

export const RADAR_SIZE = 260;
export const RADAR_CX = RADAR_SIZE / 2;
export const RADAR_CY = RADAR_SIZE / 2;
export const RADAR_RADIUS = 92;
const MAX_VALUE = 3;
export const RADAR_RING_FRACTIONS = [1 / 3, 2 / 3, 1];

export const RADAR_AXES: { key: keyof CompRatingVector; label: string }[] = [
  { key: "cc", label: "CC" },
  { key: "damage", label: "Damage" },
  { key: "tankiness", label: "Tankiness" },
  { key: "mobility", label: "Mobility" },
  { key: "utility", label: "Utility" },
  { key: "engage", label: "Engage" },
];

/** Polar point for axis `index` of 6 (0 = top, clockwise) at `valueFraction`
 *  (0..1, clamped) of `radius` from (`cx`,`cy`). Exported/pure so the exact
 *  geometry is unit-testable without an SVG/DOM harness. */
export function axisPoint(
  index: number,
  valueFraction: number,
  cx = RADAR_CX,
  cy = RADAR_CY,
  radius = RADAR_RADIUS
): { x: number; y: number } {
  const angle = (Math.PI * 2 * index) / RADAR_AXES.length - Math.PI / 2;
  const r = Math.max(0, Math.min(1, valueFraction)) * radius;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** SVG `points` attribute string for a full 6-axis polygon from a rating
 *  vector (each axis 0..MAX_VALUE, defaulted to 0 for a missing key rather
 *  than throwing on a partial object). */
export function buildPolygonPoints(vector: CompRatingVector, cx = RADAR_CX, cy = RADAR_CY, radius = RADAR_RADIUS): string {
  return RADAR_AXES.map((axis, i) => {
    const raw = vector[axis.key] ?? 0;
    const p = axisPoint(i, raw / MAX_VALUE, cx, cy, radius);
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join(" ");
}

/** Background grid ring (one of RADAR_RING_FRACTIONS) as an SVG points
 *  string — a plain hexagon at that fraction of `radius`, recessive/muted
 *  per the dataviz skill's "thin marks, recessive grid" rule. */
export function buildGridRingPoints(ringFraction: number, cx = RADAR_CX, cy = RADAR_CY, radius = RADAR_RADIUS): string {
  return RADAR_AXES.map((_axis, i) => {
    const p = axisPoint(i, ringFraction, cx, cy, radius);
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join(" ");
}

/** Footnote copy for a fallback-derived (non-curated) share of the aggregate
 *  — null when everything resolved from the curated map (nothing to caveat)
 *  or when nothing resolved at all (avoid a "0 of 0" footnote). */
export function estimatedFootnote(aggregated: AggregatedComp, totalResolved: number): string | null {
  if (aggregated.estimatedCount <= 0 || totalResolved <= 0) return null;
  const noun = aggregated.estimatedCount === 1 ? "champion" : "champions";
  return `Some ratings estimated (${aggregated.estimatedCount} of ${totalResolved} ${noun}).`;
}
