// ─────────────────────────────────────────────────────────────────────────────
// rankBracketStorage.ts — SSR-safe localStorage persistence for the rank
// bracket selector (Feature 3, see BuildTabContent.tsx). Mirrors lib/
// favorites.ts's own `typeof window === "undefined"` guard pattern (that
// file's header comment explains why: never crash a server render or a
// vitest node-env run that hasn't stubbed `window`).
//
// Deliberately its own tiny module (not inlined in BuildTabContent.tsx) so
// the read/write logic — including the "unknown stored id falls back to
// default" validation — is unit-testable from a plain .ts file per this
// repo's test convention (vitest 4's oxc transform can't parse JSX outside
// its default scope, see StatBadge.tsx's header comment).
// ─────────────────────────────────────────────────────────────────────────────
import { RANK_BRACKETS, DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";

export const RANK_BRACKET_STORAGE_KEY = "coachbuild:rankBracket:v1";

/** Reads the stored rank-bracket id, validated against the current
 *  RANK_BRACKETS list. Returns the default bracket's id when: no `window`
 *  (SSR / node test env), nothing stored yet, storage is inaccessible
 *  (private-mode quota errors), or the stored value no longer names a real
 *  bracket (e.g. the module's bracket list changed underneath an old
 *  stored value) — never throws, never returns an unknown id. */
export function readStoredRankBracketId(): string {
  if (typeof window === "undefined") return DEFAULT_RANK_BRACKET.id;
  try {
    const raw = window.localStorage.getItem(RANK_BRACKET_STORAGE_KEY);
    if (!raw) return DEFAULT_RANK_BRACKET.id;
    return RANK_BRACKETS.some((b) => b.id === raw) ? raw : DEFAULT_RANK_BRACKET.id;
  } catch {
    return DEFAULT_RANK_BRACKET.id;
  }
}

/** Persists the chosen bracket id. No-op (never throws) when `window` is
 *  absent or storage write fails — persistence is a nicety here, never
 *  load-bearing for the selector itself (React state is the source of
 *  truth for the current render; see BuildTabContent.tsx). */
export function writeStoredRankBracketId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RANK_BRACKET_STORAGE_KEY, id);
  } catch {
    /* ignore quota/private-mode errors */
  }
}
