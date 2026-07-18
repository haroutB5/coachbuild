// ─────────────────────────────────────────────────────────────────────────────
// optimizedPath.ts — pure view-model for Feature 2 (sequential item
// optimizer). Decides what CoreBuildOrderCard.tsx should render for
// `items.optimizedPath` per the engine handoff's contract:
//   - absent / empty                                  -> render nothing
//   - identical (same ids, same order) to the existing
//     reliable core path (first/second/third)          -> a tiny confirmation
//     note, not a duplicate strip
//   - otherwise                                        -> the full conditioned
//     "optimized order" strip
// Split out as a pure .ts module (no JSX) so it's unit-testable per this
// repo's test convention — see StatBadge.tsx's header comment.
// ─────────────────────────────────────────────────────────────────────────────
import type { ItemsBlock, Pick as PickType } from "@/lib/types";

export type OptimizedPathView =
  | { kind: "none" }
  | { kind: "confirmed" }
  | { kind: "path"; path: PickType[] };

function samePath(a: PickType[], b: PickType[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.id === b[i]?.id);
}

/** `items.optimizedPath` is compared against the same-length PREFIX of the
 *  reliable core order (first, second, third) — the optimizer's chain is
 *  never longer than 3 (engine contract), so this only ever compares 2 or 3
 *  entries. */
export function resolveOptimizedPathView(items: ItemsBlock): OptimizedPathView {
  const path = items.optimizedPath;
  if (!path || path.length === 0) return { kind: "none" };
  const corePrefix = [items.first, items.second, items.third].slice(0, path.length);
  if (samePath(path, corePrefix)) return { kind: "confirmed" };
  return { kind: "path", path };
}
