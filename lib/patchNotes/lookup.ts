// ─────────────────────────────────────────────────────────────────────────────
// lib/patchNotes/lookup.ts — pure accessor over the curated PATCH_NOTES table
// (lib/patchNotes/notes.ts). Split out so lib/patchMovers.ts's orchestrator
// depends on a one-function surface, and so this is directly unit-testable
// without importing the (growing) curated dataset's shape into every caller.
// ─────────────────────────────────────────────────────────────────────────────

import { PATCH_NOTES } from "./notes";

/** null = no curated entry for this (patch, championId) pair — renders "—" in
 *  the UI. This is the honest default for "not verified," never a guess. */
export function getPatchNote(patch: string, championId: number): string | null {
  return PATCH_NOTES[patch]?.[championId] ?? null;
}
