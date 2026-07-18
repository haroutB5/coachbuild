// ─────────────────────────────────────────────────────────────────────────────
// patchMoversFormat.ts — pure display helpers for /movers (Feature 4:
// GET /api/patch-movers). Split out from MoverRow.tsx / app/movers/page.tsx so
// the delta sign/direction/formatting logic is unit-testable per this repo's
// test convention (vitest 4's oxc transform can't parse JSX outside its
// default scope — see StatBadge.tsx's header comment).
// ─────────────────────────────────────────────────────────────────────────────
import type { PatchMover } from "@/lib/patchMovers";

export type DeltaDirection = "up" | "down" | "flat";

export function deltaDirection(delta: number): DeltaDirection {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/** up = the app's one accent (teal/gold, a genuine WPA improvement), down =
 *  a MUTED red distinct from StatBadge's sharper `text-bad` (a swing row
 *  reads "this pick got worse across patches," a softer signal than "this
 *  pick is currently bad") — per the brief's "up = teal, down = muted red"
 *  spec. `flat` (delta === 0) never actually fires — computeMoversForChamp
 *  only emits a row when the two patches' WPA genuinely differ — but is
 *  handled so this function is total. */
export function deltaClass(delta: number): string {
  const dir = deltaDirection(delta);
  if (dir === "up") return "text-teal";
  if (dir === "down") return "text-bad/75";
  return "text-mut";
}

export function deltaArrow(delta: number): string {
  const dir = deltaDirection(delta);
  if (dir === "up") return "↑"; // ↑
  if (dir === "down") return "↓"; // ↓
  return "→"; // →
}

export function deltaText(delta: number): string {
  return (delta > 0 ? "+" : "") + delta.toFixed(2);
}

export function wpaSwingText(prevWpa: number, currWpa: number): string {
  return `${prevWpa.toFixed(2)} → ${currWpa.toFixed(2)}`;
}

export function patchHeaderText(patch: string, prevPatch: string): string {
  return `${patch} vs ${prevPatch}`;
}

export function moverKindLabel(kind: PatchMover["kind"]): string {
  return kind === "keystone" ? "Keystone" : "Item";
}
