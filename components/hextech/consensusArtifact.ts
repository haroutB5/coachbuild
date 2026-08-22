// ─────────────────────────────────────────────────────────────────────────────
// consensusArtifact.ts — the per-patch PRECOMPUTED consensus the in-game shop
// export reads INSTEAD of the database.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// On 2026-08-20 the shared Neon Free-plan compute quota was exhausted, Neon
// answered 402, `/api/pros` and `/api/otp` answered 500, and the exported item
// set silently lost its `Pro build` and `OTP build` blocks for nine hours
// (HANDOFF-core-itemset-blocks.md). The cadence bug that burned the quota is
// fixed (33785c7) and the failure is no longer silent — but the export still
// could not survive a database that is simply not there.
//
// It does not need one. Measured against the real code path, both resolvers in
// itemSetsApply.ts fetch up to 200 FULL match rows (jsonb final_items, runes,
// spells, purchase order, the lot) and then reduce them, immediately and
// entirely, to this:
//
//     { items: [{ itemId, share }] , boots: [{ itemId, share }] }
//
// At most 7 items (TOP_ITEMS_LIMIT 6, plus the one folded-in support-quest
// final) and 2 boots — 18 numbers per (champion, role, source). The 200-row
// fetch is pure waste at the network layer: the export needs the OUTPUT of the
// aggregation and never once looks at its input.
//
// So the aggregation moves to the ingest side, runs once per patch
// (scripts/generate-consensus-artifact.mts), and ships as a static JSON file.
// The export then reads a CDN asset. No Postgres in the request path at all,
// which means no quota, no 402, no outage — for the whole class, permanently.
//
// ── Why counts and not shares ───────────────────────────────────────────────
//
// EVERY share in the reduced shape is `count / itemsSampleSize` — one
// expression, `toFrequency` in proConsensus.ts, applied to items, boots,
// starters and support finals alike. Storing the count and the denominator
// instead of the quotient is therefore:
//
//   * EXACT. The reader re-runs the identical IEEE-754 division on the
//     identical operands, so it reproduces the identical double. Storing the
//     quotient as JSON would round-trip too, but only because JSON.stringify
//     emits a shortest-round-trippable repr — this way there is nothing to
//     round-trip.
//   * HALF THE SIZE. Measured on a full-coverage synthetic (865 combos, both
//     sources populated, 7 items + 2 boots each): 213 KB as counts against
//     460 KB as floats. `[3152,127]` is ten bytes; `[3152,0.6580310880829016]`
//     is twenty-five.
//   * DIFFABLE. A count moving 127 -> 131 is a one-token diff. A float moving
//     rewrites eighteen digits.
//
// ── Why ONE reduction function, shared ──────────────────────────────────────
//
// `reduceConsensusModel` below is the ONLY place the fold-sort-project step
// exists. itemSetsApply.ts's live path calls it; the generator calls it. The
// artifact is literally the serialised return value of the same function the
// live path runs, so "the artifact-driven export equals the live-query export"
// is true BY CONSTRUCTION rather than by two implementations agreeing. That is
// deliberate: this file's whole reason for existing is a bug that happened
// because two copies of one query drifted (see PRO_CONSENSUS_LIMIT's comment
// in itemSetsApply.ts, and the v0.70.0 pro-play starvation fix that landed on
// one copy and not the other). One body, two call sites, no drift.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProConsensusModel } from "./proConsensus";
import type { ProConsensusItemsInput } from "./itemSetBody";

/** Bumped whenever the ENTRY encoding changes in a way an older reader would
 *  misinterpret. A reader that does not recognise the number refuses the whole
 *  file and falls back to the live query — never a partial or guessed read,
 *  because a misread entry becomes a wrong shop panel rather than an error. */
export const CONSENSUS_ARTIFACT_SCHEMA = 1;

/** Same-origin static asset. Deliberately NOT patch-suffixed in the path: the
 *  file carries its own `patch` field, so one fixed URL is self-describing,
 *  costs one round trip, and cannot get out of step with a separate manifest
 *  that says which patch is current. Staleness is a comparison, not a lookup. */
export const CONSENSUS_ARTIFACT_PATH = "/consensus/item-set-consensus.json";

/** `[itemId, count]`. Count, not share — see the module header. */
export type ConsensusCountEntry = [number, number];

export interface ConsensusArtifactSource {
  /** `itemsSampleSize`: games in the sample whose `finalItems` was non-empty.
   *  The denominator every share below divides by — NOT `gamesTotal` (see
   *  ProConsensusModel.itemsSampleSize's own doc comment for the 2026-07-25
   *  fix that separated them). */
  n: number;
  /** Items, already folded (the support-quest final's top pick is merged in)
   *  and already sorted share-desc / itemId-asc. Stored in final order so the
   *  reader never re-sorts and so a re-sort can never disagree. */
  i: ConsensusCountEntry[];
  /** Boots, in the model's own count-desc / itemId-asc order. */
  b: ConsensusCountEntry[];
}

/** One (champion, role). `null` for a source means the generator ASKED and the
 *  answer was genuinely nothing — the same quiet outcome the live path calls
 *  `{data: null, failure: null}`. An entry that is ABSENT from `entries`
 *  entirely means the generator never covered it, which is a completely
 *  different fact and is why the two are not collapsed: an absent key falls
 *  back to the live query, an explicit `null` does not. */
export interface ConsensusArtifactEntry {
  pro: ConsensusArtifactSource | null;
  otp: ConsensusArtifactSource | null;
}

export interface ConsensusArtifact {
  schema: number;
  /** `major.minor`, matching `BuildResponse.patch` exactly — the generator
   *  reads it off a real `/api/build` response rather than deriving it, so the
   *  freshness comparison cannot fail on a formatting difference. */
  patch: string;
  generatedAt: string;
  /** The exact query parameters the sample was drawn with. Recorded because
   *  they are the one thing that would silently change what the numbers MEAN
   *  (v0.70.0: limit=100 with no pro-play floor produced a "Pro build" that
   *  was ~96% solo queue), and because a reader can then refuse an artifact
   *  built under different terms rather than serving it as if it matched. */
  query: {
    pro: { limit: number; proMin: number; source: string };
    otp: { limit: number };
  };
  coverage: {
    /** champion-role pairs the generator attempted and resolved. */
    combos: number;
    /** of those, how many carried real pro / OTP data. */
    pro: number;
    otp: number;
  };
  entries: Record<string, ConsensusArtifactEntry>;
}

export function consensusArtifactKey(championId: number, role: number): string {
  return `${championId}|${role}`;
}

// ── The query, defined ONCE ─────────────────────────────────────────────────
//
// These used to be module-private constants in itemSetsApply.ts with a comment
// warning that a second copy of them existed on the Pro Consensus card and that
// changing one meant changing both. That warning was earned: v0.70.0 fixed the
// card to `limit=200&proMin=100` and left this path on `limit=100` with no
// pro-play floor, so the "Pro build" line users got IN THEIR SHOP stayed ~96%
// solo queue for weeks after the card beside it was correct.
//
// The artifact generator is now a THIRD consumer, and a third copy would be a
// third chance at the same bug — worse, because a generator drawing a different
// sample would bake the discrepancy into a file and serve it confidently. So
// the parameters and the URL that carries them live here, and every caller
// builds its request through `consensusRequestPath`. The values are also
// stamped into the artifact's own `query` field, so a reader can see what the
// numbers were drawn under rather than assume.
export const PRO_CONSENSUS_LIMIT = 200;
export const PRO_PLAY_FLOOR = 100;
export const PRO_CONSENSUS_SOURCE = "all";
export const OTP_CONSENSUS_LIMIT = 200;

/** Minimum sample size for an OTP champion-role to count as consensus data.
 *
 *  The OTP player is selected per champion, then that player's games are
 *  bucketed by the role played in each game. Without a floor, one off-role
 *  game becomes a lane build presented as fact. The product rule is `n > 20`:
 *  `n <= 20` is absence, not thin data, so the inclusive minimum is 21 games.
 *  This single value is enforced by `reduceConsensusModel`, which both the
 *  artifact bake and live fallback call. */
export const OTP_CONSENSUS_MIN_GAMES = 21;

export type ConsensusSource = "pro" | "otp";

export const CONSENSUS_ENDPOINT: Record<ConsensusSource, string> = {
  pro: "/api/pros",
  otp: "/api/otp",
};

/** The exact request the live path makes, and the exact request the generator
 *  makes. Root-relative — the browser resolves it against the origin, and the
 *  generator prefixes its `--base`. */
export function consensusRequestPath(source: ConsensusSource, championId: number, role: number): string {
  return source === "pro"
    ? `${CONSENSUS_ENDPOINT.pro}?championId=${championId}&role=${role}&limit=${PRO_CONSENSUS_LIMIT}` +
        `&proMin=${PRO_PLAY_FLOOR}&source=${PRO_CONSENSUS_SOURCE}`
    : `${CONSENSUS_ENDPOINT.otp}?championId=${championId}&role=${role}&limit=${OTP_CONSENSUS_LIMIT}`;
}

/** The `query` block stamped into a freshly generated artifact. */
export function currentConsensusQuery(): ConsensusArtifact["query"] {
  return {
    pro: { limit: PRO_CONSENSUS_LIMIT, proMin: PRO_PLAY_FLOOR, source: PRO_CONSENSUS_SOURCE },
    otp: { limit: OTP_CONSENSUS_LIMIT },
  };
}

/** `"16.13.1"` / `"16.13"` -> `"16.13"`; anything unparseable -> `""`.
 *
 *  Returning `""` rather than the input is what stops a garbage patch string
 *  matching another garbage patch string and passing the freshness check. Two
 *  empties never compare equal here — see `isConsensusArtifactFresh`. */
export function normalizePatchLabel(patch: string | null | undefined): string {
  if (!patch) return "";
  const parts = String(patch).split(".");
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return "";
  return `${major}.${minor}`;
}

/** Fresh = the artifact was generated for the SAME patch the build being
 *  exported was computed on. An unparseable patch on either side is never
 *  fresh, so a bad string degrades to "use the live query", never to "serve
 *  whatever we have and call it current". */
export function isConsensusArtifactFresh(artifactPatch: string, buildPatch: string): boolean {
  const a = normalizePatchLabel(artifactPatch);
  const b = normalizePatchLabel(buildPatch);
  return a !== "" && a === b;
}

// ── The one reduction ───────────────────────────────────────────────────────

/** The ENTIRE database-derived content of one consensus block, in the exact
 *  form the shop export consumes it.
 *
 *  Extracted verbatim from `resolveConsensus` in itemSetsApply.ts. Three rules
 *  it must keep, each of which has its own history:
 *
 *  1. THE EMPTY TEST comes first and matches the live path's exactly:
 *     `items` and `boots` both empty AND no support final. A sample that
 *     aggregated to nothing is genuine absence, not failure — the whole point
 *     of 33785c7 — so it must reduce to `null` here too and be STORED as an
 *     explicit `null`, not omitted.
 *
 *  2. OTP SAMPLES BELOW `OTP_CONSENSUS_MIN_GAMES` are absence. The check uses
 *     `itemsSampleSize`, the exact `n` stored in the artifact and used as every
 *     item's denominator. Pro consensus deliberately does not use this rule.
 *
 *  3. ONLY `supportFinals.top` is folded in, never the alternatives: the five
 *     support-quest finals are mutually exclusive, so a six-item shop line
 *     carrying two of them spends two slots on one choice (live user report,
 *     2026-07-26). Merged and RE-SORTED rather than appended, so
 *     ProConsensusItemsInput's documented share-desc / itemId-asc order still
 *     holds for the merged list. */
export function reduceConsensusModel(
  source: ConsensusSource,
  model: ProConsensusModel
): ConsensusArtifactSource | null {
  if (model.items.length === 0 && model.boots.length === 0 && model.supportFinals === null) {
    return null;
  }
  if (source === "otp" && model.itemsSampleSize < OTP_CONSENSUS_MIN_GAMES) {
    return null;
  }
  const items = [...model.items, ...(model.supportFinals ? [model.supportFinals.top] : [])].sort((a, b) =>
    b.share !== a.share ? b.share - a.share : a.itemId - b.itemId
  );
  return {
    n: model.itemsSampleSize,
    i: items.map((e): ConsensusCountEntry => [e.itemId, e.count]),
    b: model.boots.map((e): ConsensusCountEntry => [e.itemId, e.count]),
  };
}

/** The reduction, rendered as the shape `buildItemSets` takes.
 *
 *  `n > 0 ? count / n : 0` is not a defensive flourish — it is character for
 *  character the expression `toFrequency` uses in proConsensus.ts, and copying
 *  it is what makes this a re-derivation of the same double rather than an
 *  approximation of it. */
export function consensusSourceToInput(
  src: ConsensusArtifactSource | null | undefined
): ProConsensusItemsInput | null {
  if (!src) return null;
  const share = (count: number): number => (src.n > 0 ? count / src.n : 0);
  return {
    items: src.i.map(([itemId, count]) => ({ itemId, share: share(count) })),
    boots: src.b.map(([itemId, count]) => ({ itemId, share: share(count) })),
  };
}

// ── Parse / serialise ───────────────────────────────────────────────────────

function parseCountEntries(raw: unknown): ConsensusCountEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ConsensusCountEntry[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [id, count] = pair;
    if (!Number.isFinite(id) || !Number.isFinite(count)) return null;
    out.push([Number(id), Number(count)]);
  }
  return out;
}

function parseSource(raw: unknown): ConsensusArtifactSource | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!Number.isFinite(o.n)) return undefined;
  const i = parseCountEntries(o.i);
  const b = parseCountEntries(o.b);
  if (i === null || b === null) return undefined;
  return { n: Number(o.n), i, b };
}

/** Fails CLOSED. Any shape it does not fully recognise returns `null`, and a
 *  `null` here means the export uses the live query — the same behaviour as no
 *  artifact at all. This is the safe direction: a partially-understood
 *  artifact would serve a WRONG shop panel confidently, where a refused one
 *  just costs a database round trip. */
export function parseConsensusArtifact(raw: unknown): ConsensusArtifact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== CONSENSUS_ARTIFACT_SCHEMA) return null;
  if (typeof o.patch !== "string" || normalizePatchLabel(o.patch) === "") return null;
  if (typeof o.generatedAt !== "string") return null;
  if (!o.entries || typeof o.entries !== "object") return null;

  const q = o.query as Record<string, Record<string, unknown>> | undefined;
  if (!q?.pro || !q?.otp) return null;
  if (!Number.isFinite(q.pro.limit) || !Number.isFinite(q.pro.proMin) || typeof q.pro.source !== "string") return null;
  if (!Number.isFinite(q.otp.limit)) return null;

  const entries: Record<string, ConsensusArtifactEntry> = {};
  for (const [key, value] of Object.entries(o.entries as Record<string, unknown>)) {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const pro = parseSource(v.pro ?? null);
    const otp = parseSource(v.otp ?? null);
    if (pro === undefined || otp === undefined) return null;
    entries[key] = { pro, otp };
  }

  const cov = (o.coverage ?? {}) as Record<string, unknown>;
  return {
    schema: CONSENSUS_ARTIFACT_SCHEMA,
    patch: o.patch,
    generatedAt: o.generatedAt,
    query: {
      pro: { limit: Number(q.pro.limit), proMin: Number(q.pro.proMin), source: String(q.pro.source) },
      otp: { limit: Number(q.otp.limit) },
    },
    coverage: {
      combos: Number.isFinite(cov.combos) ? Number(cov.combos) : Object.keys(entries).length,
      pro: Number.isFinite(cov.pro) ? Number(cov.pro) : 0,
      otp: Number.isFinite(cov.otp) ? Number(cov.otp) : 0,
    },
    entries,
  };
}

/** Deterministic, ONE LINE PER (champion, role), keys in numeric champion then
 *  role order.
 *
 *  Not cosmetic. This file is committed, so its diff is the only review
 *  surface a regenerated artifact ever gets: line-per-combo means `git diff`
 *  says "Syndra Mid's pro line changed" instead of "the artifact changed".
 *  Deterministic ordering means a regeneration with identical data produces an
 *  identical file and therefore an EMPTY diff, which is what makes a
 *  non-empty one worth reading. */
export function serializeConsensusArtifact(artifact: ConsensusArtifact): string {
  const keys = Object.keys(artifact.entries).sort((a, b) => {
    const [ac, ar] = a.split("|").map(Number);
    const [bc, br] = b.split("|").map(Number);
    return ac !== bc ? ac - bc : ar - br;
  });
  const lines = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(artifact.entries[k])}`);
  return (
    "{\n" +
    `"schema": ${artifact.schema},\n` +
    `"patch": ${JSON.stringify(artifact.patch)},\n` +
    `"generatedAt": ${JSON.stringify(artifact.generatedAt)},\n` +
    `"query": ${JSON.stringify(artifact.query)},\n` +
    `"coverage": ${JSON.stringify(artifact.coverage)},\n` +
    `"entries": {\n` +
    lines.join(",\n") +
    "\n}\n}\n"
  );
}

// ── Loading it in the browser ───────────────────────────────────────────────

export type ConsensusArtifactLoad =
  | { artifact: ConsensusArtifact; reason: null }
  /** `reason` is one line, already safe to append to a log verbatim. It is the
   *  answer to "why did we go to the database" and it exists so a missing
   *  artifact cannot be a silent condition. */
  | { artifact: null; reason: string };

let cached: Promise<ConsensusArtifactLoad> | null = null;

/** Memoised for the page lifetime, hit or miss.
 *
 *  Caching the MISS matters as much as caching the hit: the champ-select
 *  auto-export opens a fresh tab per game, so "page lifetime" is one champ
 *  select, and an un-cached miss would cost a 404 on both the pro and the OTP
 *  resolution inside a 30-second window. A new page load retries from scratch,
 *  which is the right retry granularity for a file that only ever changes on a
 *  deploy.
 *
 *  Never throws. Every exit is a `ConsensusArtifactLoad`. */
export function loadConsensusArtifact(): Promise<ConsensusArtifactLoad> {
  if (cached) return cached;
  cached = (async (): Promise<ConsensusArtifactLoad> => {
    try {
      const res = await fetch(CONSENSUS_ARTIFACT_PATH);
      if (!res.ok) {
        const status = typeof res.status === "number" ? res.status : 0;
        return {
          artifact: null,
          reason: `precomputed consensus artifact ${CONSENSUS_ARTIFACT_PATH} not served (HTTP ${status})`,
        };
      }
      const parsed = parseConsensusArtifact(await res.json());
      if (!parsed) {
        return {
          artifact: null,
          reason: `precomputed consensus artifact ${CONSENSUS_ARTIFACT_PATH} did not parse at schema ${CONSENSUS_ARTIFACT_SCHEMA}`,
        };
      }
      return { artifact: parsed, reason: null };
    } catch (err) {
      return {
        artifact: null,
        reason:
          `precomputed consensus artifact ${CONSENSUS_ARTIFACT_PATH} was unreachable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  })();
  return cached;
}

export function __resetConsensusArtifactCacheForTests(): void {
  cached = null;
}
