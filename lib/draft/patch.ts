// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/patch.ts — patch label/segment resolution + u.gg schema-version
// probing for the "Draft" recommender (see _research/draft-feature-plan.md
// §2). Reuses getLatestPatch() (lib/staticData.ts) as the single source of
// truth for "what's the current patch" — no separate resolution logic here.
// ─────────────────────────────────────────────────────────────────────────────

import { getLatestPatch } from "@/lib/staticData";

/** DB/display label, e.g. "16.14" — this is coachbuild.draft_matchup.patch's
 *  value, NOT u.gg's own URL segment form (see patchSegment below). */
export async function resolveDraftPatchLabel(now?: () => number): Promise<string> {
  const resolved = await getLatestPatch(now);
  return resolved.label;
}

/** "16.14" -> "16_14" (u.gg's matchups/rankings URL segment). Tolerates a
 *  full ddragon-style "16.14.1" label too (only the first two dot-separated
 *  parts are used). */
export function patchSegment(label: string): string {
  const parts = label.split(".");
  return `${parts[0]}_${parts[1]}`;
}

export interface UggSchemaVersion {
  /** URL path segment right after "/lol/", e.g. "1.5". */
  schema: string;
  /** Trailing filename version, e.g. "1.5.0". */
  version: string;
}

/** Hardcoded primary, per counterpick-research.md's live probe (a DIFFERENT
 *  session's dev box — this session's network is blocked from u.gg
 *  entirely, see lib/draft/ugg.ts's header comment, so neither this nor the
 *  fallback list below could be re-verified here). */
const PRIMARY_SCHEMA: UggSchemaVersion = { schema: "1.5", version: "1.5.0" };
/** Probed in order on a 404/failure of the primary — see resolveUggSchema. */
const FALLBACK_SCHEMAS: UggSchemaVersion[] = [
  { schema: "1.5", version: "1.5.1" },
  { schema: "1.6", version: "1.6.0" },
];

const SCHEMA_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let cachedSchema: { value: UggSchemaVersion; resolvedAt: number } | null = null;

/** Test-only: clear the module-level schema cache between test cases. */
export function __resetUggSchemaCacheForTests(): void {
  cachedSchema = null;
}

/**
 * Walks PRIMARY_SCHEMA then FALLBACK_SCHEMAS, calling `probe` on each until
 * one succeeds, and caches the result for SCHEMA_CACHE_TTL_MS. `probe` is
 * injected (real callers pass something that actually fetches a known-stable
 * champion's file and checks the HTTP status/parseability — see
 * lib/draft/ugg.ts) so this function stays network-free and directly
 * testable. If EVERY candidate fails, falls back to the primary anyway (a
 * probe outage is usually transient, not proof the schema moved) rather than
 * throwing — ingest callers still get a URL to try, and will surface the
 * real failure at the actual fetch site instead of here.
 */
export async function resolveUggSchema(
  probe: (schema: UggSchemaVersion) => Promise<boolean>,
  now: () => number = Date.now
): Promise<UggSchemaVersion> {
  const t = now();
  if (cachedSchema && t - cachedSchema.resolvedAt < SCHEMA_CACHE_TTL_MS) {
    return cachedSchema.value;
  }

  const candidates = [PRIMARY_SCHEMA, ...FALLBACK_SCHEMAS];
  for (const candidate of candidates) {
    let ok = false;
    try {
      ok = await probe(candidate);
    } catch {
      ok = false;
    }
    if (ok) {
      cachedSchema = { value: candidate, resolvedAt: t };
      return candidate;
    }
  }

  cachedSchema = { value: PRIMARY_SCHEMA, resolvedAt: t };
  return PRIMARY_SCHEMA;
}
