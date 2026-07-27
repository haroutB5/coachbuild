// ─────────────────────────────────────────────────────────────────────────────
// lib/recentChampions.ts — "whatever you've looked at lately" for the Builds
// empty state (app/page.tsx). Separate from lib/lastChampion.ts (which only
// ever remembers ONE champion — the thing app/page.tsx restores on mount) —
// this keeps a short, deduped, newest-first LIST so the empty state can show
// a few real recently-viewed champions, not just the one currently showing.
//
// Deliberately localStorage, not the DB: per-device UI continuity only, same
// posture as lastChampion.ts. Every export SSR-guards on
// `typeof window === "undefined"` and never throws — a corrupt/absent value
// just means "no recent champions", which the caller renders as an honestly
// empty (hidden) section, never a fabricated one.
// ─────────────────────────────────────────────────────────────────────────────

import type { LaneId } from "@/components/hextech/heroContracts";

const KEY = "coachbuild:recentChampions:v1";
/** Small on purpose — this is a quick-jump strip, not a history log. */
export const MAX_RECENT_CHAMPIONS = 6;

export interface RecentChampionEntry {
  championId: number;
  /** The lane last viewed for this champion — used so tapping the entry
   *  lands on the same build the user was actually looking at. */
  lane: LaneId;
}

function isEntryShape(v: unknown): v is RecentChampionEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.championId === "number" && Number.isFinite(o.championId) && typeof o.lane === "string";
}

/** Newest-first. Never throws — corrupted JSON/shape degrades to []. */
export function readRecentChampions(): RecentChampionEntry[] {
  if (typeof window === "undefined") return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEntryShape);
}

function write(list: RecentChampionEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota/private-mode — continuity is a nicety, never worth an error.
  }
}

/**
 * Records a real view: moves `championId` to the front (deduped — one entry
 * per champion, always carrying its MOST RECENT lane) and caps the list at
 * MAX_RECENT_CHAMPIONS. Called on every settled selection app/page.tsx makes
 * (search, deep link, live-follow, restore) — see that file's persist effect.
 */
export function pushRecentChampion(championId: number, lane: LaneId): void {
  if (typeof window === "undefined") return;
  const current = readRecentChampions().filter((e) => e.championId !== championId);
  const next = [{ championId, lane }, ...current].slice(0, MAX_RECENT_CHAMPIONS);
  write(next);
}
