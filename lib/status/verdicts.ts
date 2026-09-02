// ─────────────────────────────────────────────────────────────────────────────
// lib/status/verdicts.ts — the PURE half of /status: facts in, a verdict out.
//
// Every function here takes plain values (a patch label, a timestamp, a row
// count) and returns a `StatusCheck`. Nothing here touches the network, the
// database or the clock; `now` is always an argument. That is what makes the
// thresholds testable as thresholds — a check that "fails when the draft
// tables are empty" is asserted by handing it zero, not by emptying a table.
//
// WHY THE PAGE EXISTS (competitor backlog 7b). On 2026-08-23 the Draft page
// served blank champ-select counters for three days: the draft tables were
// empty after a Neon rebuild and `/api/draft/recommend` answered a
// correct-looking `{ pending: true, meta: { patch: null } }`. Nothing on any
// surface said so. Every check below is a signal that has failed silently at
// least once, or the one that will next.
//
// VERDICT VOCABULARY, and it is deliberately three-valued:
//   pass  the fact is what a healthy deployment shows.
//   warn  worth a look, nothing a user sees is broken yet.
//   fail  a user-visible surface is broken or about to be.
// An EXPECTED transient is a `pass` with its reason in the detail, never a
// `warn`: the consensus artifact sits one patch behind the live patch for the
// hours between a Riot patch and the 15:00 re-bake, and paging for that is how
// a reader learns to skip the page (HANDOFF 2026-08-29 §1, and urgot's
// scripts/check-coachbuild-live.sh, which this page deliberately does NOT
// duplicate — it exposes the facts; the digest owns the alerting).
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifyConsensusArtifactFreshness,
  patchDriftSteps,
  CONSENSUS_MAX_STALE_MINORS,
} from "@/components/hextech/consensusArtifact";
import { SERVING_PATCH_MIN_CHAMPS } from "@/lib/draft/servingPatch";

export type Verdict = "pass" | "warn" | "fail";

export interface StatusCheck {
  /** Stable machine id, e.g. `build-patch`. Never renamed casually: a monitor
   *  keys on it. */
  id: string;
  label: string;
  verdict: Verdict;
  /** One sentence, human-readable, with the number in it. */
  detail: string;
  /** The timestamp the fact is ABOUT (an ingest, a bake), ISO, or null when
   *  the fact has no timestamp of its own. */
  at: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Age thresholds, in hours. Named so the page and the tests read the same
 *  numbers, and so the reasoning sits next to the value.
 *
 *  ARTIFACT: `CoachBuildConsensusRebake` runs daily at 15:00 local and only
 *  commits + deploys when the artifact CHANGED, so an unchanged day legitimately
 *  ages it by 24h. Warn after three missed days, fail after a week — by then
 *  the export is on a sample a whole patch old.
 *
 *  MATCHES: `CoachBuildMatchIngest` runs every 6h; pros play daily. A quiet
 *  36h is a slow weekend, 48h is worth a look, a week means the task is dead. */
export const ARTIFACT_WARN_HOURS = 72;
export const ARTIFACT_FAIL_HOURS = 24 * 7;
export const MATCHES_WARN_HOURS = 48;
export const MATCHES_FAIL_HOURS = 24 * 7;
/** Draft ingest runs Mon + Thu (~45 min walk); 8 days is one missed run. */
export const DRAFT_WARN_HOURS = 24 * 8;

export function ageHours(at: string | null | undefined, now: number): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return (now - t) / HOUR_MS;
}

function fmtAge(hours: number | null): string {
  if (hours === null) return "unknown age";
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${hours.toFixed(1)} h ago`;
  return `${(hours / 24).toFixed(1)} days ago`;
}

// ── 1. The patch /api/build resolves ────────────────────────────────────────

export interface LivePatchFact {
  label: string;
  /** False when `getLatestPatch` fell back (ddragon unreachable or every
   *  coachless probe failed) — the label is the last known-good or the static
   *  16.11 default, not a confirmed resolution. */
  ok: boolean;
}

export function judgeLivePatch(fact: LivePatchFact | null): StatusCheck {
  const id = "build-patch";
  const label = "/api/build patch";
  if (!fact) return { id, label, verdict: "fail", detail: "patch resolution threw; builds cannot be computed", at: null };
  if (!fact.ok) {
    return {
      id,
      label,
      verdict: "warn",
      detail: `${fact.label}, from FALLBACK: ddragon or every coachless probe failed, so this is the last known-good patch, not a confirmed one`,
      at: null,
    };
  }
  return { id, label, verdict: "pass", detail: `${fact.label}, resolved against coachless`, at: null };
}

// ── 2. Consensus artifact: patch drift, then age ────────────────────────────

export function judgeArtifactPatch(artifactPatch: string | null, livePatch: string | null): StatusCheck {
  const id = "artifact-patch";
  const label = "Consensus artifact patch";
  if (!artifactPatch) {
    return { id, label, verdict: "fail", detail: "artifact missing or unparseable; every shop export is querying Neon", at: null };
  }
  if (!livePatch) {
    return { id, label, verdict: "warn", detail: `${artifactPatch}; live patch unknown, drift not measurable`, at: null };
  }
  const freshness = classifyConsensusArtifactFreshness(artifactPatch, livePatch);
  const drift = patchDriftSteps(artifactPatch, livePatch);
  if (freshness === "fresh") {
    return { id, label, verdict: "pass", detail: `${artifactPatch}, same as live; shop export off the database`, at: null };
  }
  if (freshness === "stale") {
    // EXPECTED. The export serves it labelled; the daily re-bake accepts a
    // single forward step unattended. This is a pass with its reason, not a
    // warn — see the header.
    return {
      id,
      label,
      verdict: "pass",
      detail: `${artifactPatch} vs live ${livePatch}, drift ${drift} (EXPECTED between a Riot patch and the next 15:00 re-bake; served labelled, bound is ${CONSENSUS_MAX_STALE_MINORS})`,
      at: null,
    };
  }
  return {
    id,
    label,
    verdict: "fail",
    detail:
      drift === null
        ? `${artifactPatch} vs live ${livePatch}: unparseable or artifact NEWER than live; export has reverted to the database`
        : `${artifactPatch} vs live ${livePatch}, drift ${drift} exceeds the served bound of ${CONSENSUS_MAX_STALE_MINORS}; export has reverted to the database`,
    at: null,
  };
}

export function judgeArtifactAge(generatedAt: string | null, now: number): StatusCheck {
  const id = "artifact-age";
  const label = "Consensus artifact age";
  const h = ageHours(generatedAt, now);
  if (h === null) return { id, label, verdict: "fail", detail: "no generatedAt on the artifact", at: generatedAt ?? null };
  if (h > ARTIFACT_FAIL_HOURS) {
    return { id, label, verdict: "fail", detail: `baked ${fmtAge(h)}; the daily re-bake has not shipped in a week`, at: generatedAt };
  }
  if (h > ARTIFACT_WARN_HOURS) {
    return { id, label, verdict: "warn", detail: `baked ${fmtAge(h)}; three daily re-bakes without a change or a deploy`, at: generatedAt };
  }
  return { id, label, verdict: "pass", detail: `baked ${fmtAge(h)}`, at: generatedAt };
}

// ── 3. Neon ──────────────────────────────────────────────────────────────────

export function judgeDb(fact: { ok: true; latencyMs: number } | { ok: false; error: string }): StatusCheck {
  const id = "neon";
  const label = "Neon reachable";
  if (!fact.ok) return { id, label, verdict: "fail", detail: fact.error, at: null };
  return { id, label, verdict: "pass", detail: `SELECT 1 in ${fact.latencyMs} ms`, at: null };
}

export function judgeMatchesIngest(latestCreatedAt: string | null, now: number, dbOk: boolean): StatusCheck {
  const id = "matches-ingest";
  const label = "Latest pro match ingested";
  if (!dbOk) return { id, label, verdict: "fail", detail: "not checked: database unreachable", at: null };
  const h = ageHours(latestCreatedAt, now);
  if (h === null) return { id, label, verdict: "fail", detail: "pro_matches is EMPTY", at: null };
  if (h > MATCHES_FAIL_HOURS) {
    return { id, label, verdict: "fail", detail: `${fmtAge(h)}; CoachBuildMatchIngest (every 6h) has not landed a match in a week`, at: latestCreatedAt };
  }
  if (h > MATCHES_WARN_HOURS) {
    return { id, label, verdict: "warn", detail: `${fmtAge(h)}; CoachBuildMatchIngest runs every 6h`, at: latestCreatedAt };
  }
  return { id, label, verdict: "pass", detail: fmtAge(h), at: latestCreatedAt };
}

// ── 4. Draft tables: the 2026-08-23 incident ────────────────────────────────

export interface DraftFact {
  /** `resolveServingPatch` — null is exactly the `patch: null` tell. */
  servingPatch: string | null;
  /** Distinct champions in the SERVED tier for that patch. */
  champs: number;
  latestIngestedAt: string | null;
  /** `coachbuild.ingest_health` row for `draft`, or null when never recorded. */
  ingestOk: boolean | null;
  ingestLastError: string | null;
}

export function judgeDraft(fact: DraftFact | null, now: number, dbOk: boolean): StatusCheck {
  const id = "draft-tables";
  const label = "Draft tables";
  if (!dbOk || !fact) return { id, label, verdict: "fail", detail: "not checked: database unreachable", at: null };
  if (!fact.servingPatch || fact.champs === 0) {
    // THE incident. /draft and the champ-select counters are blank right now.
    return {
      id,
      label,
      verdict: "fail",
      detail: `EMPTY for the served tier: /api/draft/recommend is answering patch:null. Start-ScheduledTask CoachBuildDraftIngest (~45 min)`,
      at: null,
    };
  }
  const h = ageHours(fact.latestIngestedAt, now);
  const ingestNote =
    fact.ingestOk === false
      ? `; last ingest run reported an error (${(fact.ingestLastError ?? "unknown").slice(0, 80)}) but the data below is being served`
      : "";
  if (fact.champs < SERVING_PATCH_MIN_CHAMPS) {
    return {
      id,
      label,
      verdict: "warn",
      detail: `serving ${fact.servingPatch} with only ${fact.champs} champions (bar is ${SERVING_PATCH_MIN_CHAMPS}); mid-ingest or a killed walk${ingestNote}`,
      at: fact.latestIngestedAt,
    };
  }
  if (h !== null && h > DRAFT_WARN_HOURS) {
    return {
      id,
      label,
      verdict: "warn",
      detail: `serving ${fact.servingPatch}, ${fact.champs} champions, last ingested ${fmtAge(h)} (runs Mon + Thu)${ingestNote}`,
      at: fact.latestIngestedAt,
    };
  }
  return {
    id,
    label,
    verdict: fact.ingestOk === false ? "warn" : "pass",
    detail: `serving ${fact.servingPatch}, ${fact.champs} champions, last ingested ${fmtAge(h)}${ingestNote}`,
    at: fact.latestIngestedAt,
  };
}

// ── 5. Coverage ──────────────────────────────────────────────────────────────

export function judgeCoverage(coverage: { combos: number; pro: number; otp: number } | null): StatusCheck {
  const id = "consensus-coverage";
  const label = "Pro / OTP coverage";
  if (!coverage) return { id, label, verdict: "fail", detail: "no artifact to read coverage from", at: null };
  if (coverage.pro === 0 || coverage.otp === 0) {
    return {
      id,
      label,
      verdict: "fail",
      detail: `pro ${coverage.pro}, otp ${coverage.otp} of ${coverage.combos} champion-roles; a zero means the bake ran against an empty table`,
      at: null,
    };
  }
  return {
    id,
    label,
    verdict: "pass",
    detail: `pro ${coverage.pro}, otp ${coverage.otp} of ${coverage.combos} champion-roles carry consensus data`,
    at: null,
  };
}

// ── 6. The last-known-good store behind /api/build (0.122.0) ────────────────

export function judgeRuntimeCache(backend: "runtime-cache" | "in-memory"): StatusCheck {
  const id = "runtime-cache";
  const label = "Last-known-good store";
  if (backend === "runtime-cache") {
    return { id, label, verdict: "pass", detail: "Vercel Runtime Cache; cached builds and the last-good patch survive a cold function", at: null };
  }
  // Locally this is the expected reading. On a deployed Function it means the
  // platform did not inject its cache and /api/build's fallback copies die
  // with each instance — degraded, not broken, so a warn.
  return { id, label, verdict: "warn", detail: "in-memory only; fallback copies die with the instance (expected outside Vercel)", at: null };
}

// ── Roll-up ──────────────────────────────────────────────────────────────────

const RANK: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };

export function overallVerdict(checks: readonly StatusCheck[]): Verdict {
  let worst: Verdict = "pass";
  for (const c of checks) if (RANK[c.verdict] > RANK[worst]) worst = c.verdict;
  return worst;
}
