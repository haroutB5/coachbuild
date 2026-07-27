// ─────────────────────────────────────────────────────────────────────────────
// opgg.ts — THE single choke point for op.gg's MCP API.
//
// Mirrors how lib/coachless.ts isolates that provider: every outbound call to
// this host goes through this module, so the blast radius of the provider
// changing shape (or disappearing) is one file.
//
// ── THIS ENDPOINT IS UNDOCUMENTED. Read this before touching anything. ──────
// `POST https://mcp-api.op.gg/mcp` is a JSON-RPC 2.0 / MCP streamable-HTTP
// endpoint. No auth, no key, no published schema, no stated rate limit, and
// no terms covering programmatic use. Everything below was established by
// live probing on 2026-07-27, not from documentation. That has consequences
// which are deliberately baked into the design:
//
//  1. FAIL TO NULL, NEVER TO WRONG. Every failure mode — transport error,
//     JSON-RPC error, missing field, unexpected shape, unparseable number —
//     returns `null`, which the route serves as a normal 200-with-null so the
//     UI simply omits the skill-order card. There is no path here that
//     produces a partial or inferred order. A missing card is a fine outcome;
//     a plausible-but-wrong levelling order is not.
//
//  2. THE RESPONSE IS SELF-DESCRIBING, SO WE ASSERT THE SCHEMA RATHER THAN
//     ASSUME POSITIONS. The payload is a pseudo-class text dump prefixed by
//     its own class definitions, e.g.
//         class Skills: order,play,win,pick_rate
//         ...
//         Skills(["W","Q","E",...],71667,41408,0.57)
//     THE FIELD ORDER IS NOT STABLE. Adding `desired_output_fields` to the
//     request re-emits the very same data as
//         class Skills: order,pick_rate,play,win
//         Skills(["W","Q","E",...],0.57,71667,41408)
//     — verified live, both forms, same champion, same minute. Hard-coding
//     positional indices would therefore silently read pick_rate 0.57 as
//     `play` and 71667 as `win`: a wrong answer that still renders. So the
//     parser reads the `class Skills:` header and maps fields BY NAME, and
//     refuses (null) if the declared field SET is not exactly what we expect.
//     If op.gg reshapes the payload, we lose the card — we never mis-parse it.
//
//  3. THE ADVERTISED INPUT ENUM IS WIDER THAN WHAT WORKS. The tool schema
//     declares position ∈ {all,none,top,mid,jungle,adc,support}, but `all`
//     and `none` are rejected upstream with
//     `{"position":["The selected position is invalid."]}` (all 172 champions,
//     verified). Only the five real lanes work — hence RoleId 5 ("auto") maps
//     to null here rather than to "all". Do not "fix" that by trusting the
//     enum.
//
//  4. BE A POLITE GUEST. One request per champion+role, aggressively cached
//     (see CACHE_TTL_SECONDS), and `desired_output_fields` trims the response
//     from ~5.8 kB to ~1.0 kB by asking only for the skills fields.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionKit, RoleId } from "./types";
import { fetchWithTimeout } from "./fetchTimeout";
import {
  buildSkillOrderModel,
  isAbility,
  type Ability,
  type SkillOrderModel,
  type SkillOrderSource,
} from "./skillOrderModel";

const OPGG_MCP_URL = "https://mcp-api.op.gg/mcp";

/**
 * How long a skill-order response stays cached.
 *
 * Skill orders are a patch-scale quantity — they move when Riot changes a
 * kit, not hour to hour — so the honest lower bound on TTL is "long". The
 * ceiling is what stops us serving LAST patch's order for days after a new
 * one lands: patches are ~2 weeks apart and arrive on no schedule we track
 * here, so a multi-day TTL would do exactly that. 6 h bounds staleness to a
 * quarter of a day while still collapsing essentially all real traffic (any
 * champion+role worth showing is requested far more than 4x/day).
 *
 * It is also deliberately the SAME 6 h that lib/coachless.ts uses. Both feeds
 * render on one Builds page, and two halves of the same page ageing at
 * different rates is a worse failure than either TTL being individually
 * suboptimal.
 *
 * No in-process single-flight cache here (unlike lib/patchMoversCache.ts):
 * this path makes ONE upstream call per request, not ~400, and Next's fetch
 * data cache already dedupes it. Machinery that isn't earning its keep is
 * just more surface to get wrong.
 */
export const CACHE_TTL_SECONDS = 21_600;

/** op.gg lane ids. `all`/`none` are advertised but rejected — see note 3. */
export type OpggPosition = "top" | "jungle" | "mid" | "adc" | "support";

/**
 * RoleId → op.gg position.
 *
 * Role 5 is the app's "auto/primary" pseudo-role and has NO op.gg equivalent:
 * the obvious candidate (`all`) is advertised in the tool schema but rejected
 * by the server for every champion. Returning null (→ no card) is honest;
 * silently substituting a lane would attribute one lane's skill order to a
 * request that didn't ask for it.
 */
export function opggPosition(role: RoleId): OpggPosition | null {
  switch (role) {
    case 0:
      return "top";
    case 1:
      return "jungle";
    case 2:
      return "mid";
    case 3:
      return "adc";
    case 4:
      return "support";
    default:
      return null;
  }
}

/**
 * Riot champion key (ChampionRef.key, e.g. "MissFortune") → op.gg's
 * UPPER_SNAKE_CASE champion argument (e.g. "MISS_FORTUNE").
 *
 * Reusing the app's EXISTING champion metadata (lib/staticData.ts's
 * getChampionById) rather than shipping a second champion table — a parallel
 * mapping table is exactly the thing that rots silently when a champion is
 * released (repo gotcha (y) is the same failure mode for item ids).
 *
 * VERIFIED 2026-07-27: op.gg's own `lol_list_champions` was diffed against
 * ddragon 16.14.1 by numeric id — all 172 champions op.gg knows about carry a
 * `key` byte-identical to Riot's, 0 mismatches. The camelCase→UPPER_SNAKE
 * transform was then probed live against every champion whose key-derived
 * name differs from their display-name-derived one — Nunu, MonkeyKing,
 * KogMaw, RekSai, Renata. op.gg accepts BOTH forms for all five (MONKEY_KING
 * and WUKONG both resolve to Wukong), so the key-derived transform alone
 * covers the roster and no special-case table is needed.
 *
 * ROSTER LAG IS A REAL, EXPECTED NULL. ddragon 16.14.1 lists 173 champions,
 * op.gg 172: champion 805 (Locke) is absent from op.gg entirely — the same
 * new-champion lag lib/staticData.ts's ddragon gap-fill exists to paper over
 * for icons. Here it needs no special handling: an unknown champion returns a
 * JSON-RPC error, which becomes null, which becomes no card. A newly released
 * champion silently having no skill-order card until op.gg ingests them is
 * the correct behaviour, not a bug to chase.
 */
export function opggChampionName(riotKey: string): string {
  return riotKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase();
}

// ── Response parsing ─────────────────────────────────────────────────────────

/** Field sets we require, BY NAME. A payload declaring anything else is
 *  treated as "shape changed" → null, never best-effort. */
const REQUIRED_SKILLS_FIELDS = ["order", "play", "win", "pick_rate"] as const;

function parseClassHeader(text: string): Map<string, string[]> {
  const classes = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^class (\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    classes.set(
      m[1],
      m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return classes;
}

function sameFieldSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = new Set(actual);
  return expected.every((f) => a.has(f));
}

/** Split a call's argument list on TOP-LEVEL commas only, respecting nested
 *  parens/brackets and quoted strings. */
export function splitTopLevelArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim());
}

/** Locate `Name(...)` and return its balanced inner text plus offsets.
 *  `Name` must not be preceded by an identifier character, so looking for
 *  `Skills(` can never match the tail of some other identifier. */
export function extractCall(
  text: string,
  name: string,
  from = 0
): { inner: string; start: number } | null {
  const needle = `${name}(`;
  let idx = text.indexOf(needle, from);
  while (idx > 0 && /[A-Za-z0-9_]/.test(text[idx - 1])) {
    idx = text.indexOf(needle, idx + 1);
  }
  if (idx < 0) return null;

  let depth = 0;
  let inString = false;
  for (let i = idx + needle.length - 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(idx + needle.length, i), start: idx };
    }
  }
  return null;
}

function parseQuotedList(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const body = t.slice(1, -1).trim();
  if (!body) return [];
  const out: string[] = [];
  for (const part of splitTopLevelArgs(body)) {
    const m = /^"(.*)"$/.exec(part.trim());
    if (!m) return null;
    out.push(m[1]);
  }
  return out;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the aggregate skill-order values out of a `lol_get_champion_analysis`
 * text payload. Exported for tests — this is where a provider reshape gets
 * caught, so it is unit-tested against real captured payloads in BOTH known
 * field orderings.
 *
 * Returns null on ANY deviation from the expected shape.
 */
export function parseSkillsFromAnalysis(text: string): SkillOrderSource | null {
  if (typeof text !== "string" || !text.length) return null;

  const classes = parseClassHeader(text);
  const skillsFields = classes.get("Skills");
  // Schema gate: the declared field SET must be exactly what we understand.
  // (The ORDER is free — that is the whole point; see module note 2.)
  if (!skillsFields || !sameFieldSet(skillsFields, REQUIRED_SKILLS_FIELDS)) return null;

  // Body only — never let a `class ...` header line be parsed as a call.
  const headerEnd = text.indexOf("\n\n");
  const body = headerEnd >= 0 ? text.slice(headerEnd + 2) : text;

  const skills = extractCall(body, "Skills");
  if (!skills) return null;

  // Structural assertion: the top-level `skills` field precedes
  // `skill_masteries`, whose `builds` list contains further Skills(...)
  // entries. If that ever inverts we would be reading a VARIANT order as the
  // primary recommendation — a wrong answer that renders fine. Refuse instead.
  const masteries = extractCall(body, "SkillMasteries");
  if (masteries && masteries.start < skills.start) return null;

  const args = splitTopLevelArgs(skills.inner);
  if (args.length !== skillsFields.length) return null;
  const field = (name: string): string | undefined => {
    const i = skillsFields.indexOf(name);
    return i < 0 ? undefined : args[i];
  };

  const rawOrder = field("order");
  if (rawOrder == null) return null;
  const orderStrings = parseQuotedList(rawOrder);
  if (!orderStrings || !orderStrings.length || !orderStrings.every(isAbility)) return null;

  const play = parseNumber(field("play"));
  const win = parseNumber(field("win"));
  const pickRate = parseNumber(field("pick_rate"));
  if (play == null || play <= 0) return null;
  if (win == null || win < 0 || win > play) return null;

  // Priority ("max order") — optional. Its absence costs us nothing: the
  // model derives a priority from the observed path instead.
  let priorityIds: Ability[] | undefined;
  const masteriesFields = classes.get("SkillMasteries");
  if (masteries && masteriesFields?.includes("ids")) {
    const mArgs = splitTopLevelArgs(masteries.inner);
    if (mArgs.length === masteriesFields.length) {
      const rawIds = mArgs[masteriesFields.indexOf("ids")];
      const ids = parseQuotedList(rawIds ?? "");
      if (ids && ids.length && ids.every(isAbility)) priorityIds = ids as Ability[];
    }
  }

  return {
    order: orderStrings as Ability[],
    priorityIds,
    play,
    win,
    pickRate,
  };
}

// ── Transport ────────────────────────────────────────────────────────────────

/** Injectable transport so the fetch/parse/degrade logic is unit-testable
 *  without a network call — the convention every external-feed module in this
 *  repo already follows (see CLAUDE.md "Test conventions"). */
export type OpggTransport = (body: unknown) => Promise<unknown>;

const defaultTransport: OpggTransport = async (body) => {
  const res = await fetchWithTimeout(OPGG_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The endpoint is MCP streamable-HTTP; it negotiates down to plain JSON
      // for us, but the SSE type must still be advertised or it 406s.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    next: { revalidate: CACHE_TTL_SECONDS },
  });
  if (!res.ok) throw new Error(`op.gg mcp → ${res.status} ${res.statusText}`);
  const raw = await res.text();
  return parseEnvelope(raw);
};

/** Accept either a plain JSON body or an SSE frame, since the endpoint may
 *  serve either depending on how it reads our Accept header. */
function parseEnvelope(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  if (!dataLines.length) throw new Error("op.gg mcp: unrecognised response framing");
  return JSON.parse(dataLines[dataLines.length - 1]);
}

/** Dig `result.content[0].text` out of a JSON-RPC envelope, or null. Note a
 *  JSON-RPC-level `error` still arrives over HTTP 200 (an unknown champion
 *  returns `{"error":{"code":-32603,"message":"Unknown champion provided."}}`),
 *  so the HTTP status alone is NOT a success signal. */
export function extractEnvelopeText(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== "object") return null;
  const e = envelope as { error?: unknown; result?: { content?: unknown } };
  if (e.error) return null;
  const content = e.result?.content;
  if (!Array.isArray(content) || !content.length) return null;
  const first = content[0] as { text?: unknown };
  return typeof first?.text === "string" ? first.text : null;
}

export interface SkillOrderRequest {
  /** op.gg UPPER_SNAKE_CASE champion name. */
  champion: string;
  position: OpggPosition;
}

/** Build the JSON-RPC request. `desired_output_fields` restricts the payload
 *  to the skills data (~1.0 kB instead of ~5.8 kB). */
export function buildSkillOrderRpc(req: SkillOrderRequest): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "lol_get_champion_analysis",
      arguments: {
        champion: req.champion,
        position: req.position,
        game_mode: "ranked",
        desired_output_fields: [
          "champion",
          "data.skills.{order[],pick_rate,play,win}",
          "data.skill_masteries.{ids[],pick_rate,play,win}",
        ],
      },
    },
  };
}

/**
 * Fetch the recommended skill order for a champion+role.
 *
 * Returns null — never throws — for every "we don't have this" case:
 * unsupported role, unknown champion, upstream error/timeout, JSON-RPC error,
 * or any shape we don't recognise. Callers render nothing on null.
 */
export async function fetchSkillOrder(
  championKey: string,
  role: RoleId,
  transport: OpggTransport = defaultTransport,
  /** This champion's real rank rules (lib/championKit.ts). Appended rather
   *  than inserted so every existing 2- and 3-arg call site is unchanged.
   *  `undefined` = standard model, the pre-existing behaviour; `null` =
   *  known-non-standard champion whose caps could not be resolved, carried
   *  through to the model so live consumers refuse instead of guessing. */
  kit?: ChampionKit | null
): Promise<SkillOrderModel | null> {
  const position = opggPosition(role);
  if (!position) return null;

  const champion = opggChampionName(championKey);
  if (!champion) return null;

  try {
    const envelope = await transport(buildSkillOrderRpc({ champion, position }));
    const text = extractEnvelopeText(envelope);
    if (!text) return null;
    const source = parseSkillsFromAnalysis(text);
    if (!source) return null;
    return buildSkillOrderModel(source, kit);
  } catch (err) {
    // Degrade to "no card". Logged server-side only — never surfaced.
    console.error("[opgg] skill-order fetch failed:", err);
    return null;
  }
}
