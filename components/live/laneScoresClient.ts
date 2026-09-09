import { LANE_ORDER, LANE_LABEL } from "@/components/hextech/heroContracts";
import { localBridgeFetch, localBridgePostJson } from "@/desktop/ui/localBridge";

/** RoleId 0-4, the same encoding LANE_TO_ROLE_ID produces. */
export type RoleId = 0 | 1 | 2 | 3 | 4;

/** Derived from the lane contracts rather than re-typed, so a lane rename can
 *  never leave two disagreeing label tables behind. */
export const ROLE_LABEL: Record<RoleId, string> = {
  0: LANE_LABEL[LANE_ORDER[0]],
  1: LANE_LABEL[LANE_ORDER[1]],
  2: LANE_LABEL[LANE_ORDER[2]],
  3: LANE_LABEL[LANE_ORDER[3]],
  4: LANE_LABEL[LANE_ORDER[4]],
};

export function roleLabel(roleId: number | null | undefined): string | null {
  return roleId === 0 || roleId === 1 || roleId === 2 || roleId === 3 || roleId === 4 ? ROLE_LABEL[roleId] : null;
}

/** The only queues that ever produce a pending lane score (ranked solo/flex).
 *  The companion enforces this too — this copy exists so the card can label
 *  the queue without inventing a name for a value that cannot occur. */
export const RANKED_QUEUE_LABEL: Record<number, string> = { 420: "Ranked Solo/Duo", 440: "Ranked Flex" };

export interface PendingLaneScore {
  matchId: string;
  playedAt: string;
  queueId: number;
  myChampionId: number;
  myChampionName: string;
  /** null when the client gave no usable position data. */
  roleId: number | null;
  /** null when the lane opponent could not be determined. The card must then
   *  ask the user instead of guessing. */
  opponentChampionId: number | null;
  opponentChampionName: string | null;
  enemyChampionIds: number[];
  positionSource: string | null;
  capturedAt: string;
}

export interface LaneScoreSubmission {
  matchId: string;
  score: number;
  /** Required when the pending record carried a null opponent. */
  opponentChampionId?: number | null;
  note?: string;
}

export type LaneScoreFailureReason =
  | "unknown-match" | "already-scored" | "bad-score"
  | "opponent-required" | "bad-opponent" | "bad-request";

export type LaneScoreResult = { ok: true } | { ok: false; reason: string; message: string };

/** Plain-words rendering of the contract's reason codes. Anything unexpected
 *  falls through to a generic line rather than showing the raw code. */
export function laneScoreFailureMessage(reason: string): string {
  switch (reason as LaneScoreFailureReason) {
    case "unknown-match": return "CoachBuild no longer has that game on file, so the score was not saved.";
    case "already-scored": return "That game has already been scored.";
    case "bad-score": return "The score has to be a whole number from 1 to 10.";
    case "opponent-required": return "Pick the champion you laned against before saving.";
    case "bad-opponent": return "That champion was not on the enemy team in this game.";
    case "bad-request": return "CoachBuild could not read that submission.";
    default: return "The score was not saved.";
  }
}

export const MAX_LANE_NOTE_LENGTH = 280;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePending(raw: unknown): PendingLaneScore | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const matchId = asString(r.matchId);
  const myChampionId = asNumber(r.myChampionId);
  if (!matchId || myChampionId === null) return null;
  const enemies = Array.isArray(r.enemyChampionIds)
    ? r.enemyChampionIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
    : [];
  return {
    matchId,
    playedAt: asString(r.playedAt) ?? "",
    queueId: asNumber(r.queueId) ?? 0,
    myChampionId,
    myChampionName: asString(r.myChampionName) ?? `Champion #${myChampionId}`,
    roleId: asNumber(r.roleId),
    opponentChampionId: asNumber(r.opponentChampionId),
    opponentChampionName: asString(r.opponentChampionName),
    enemyChampionIds: enemies,
    positionSource: asString(r.positionSource),
    capturedAt: asString(r.capturedAt) ?? "",
  };
}

/** GET /lane-scores/pending — resolves to null when there is nothing to score. */
export async function fetchPendingLaneScore(signal?: AbortSignal): Promise<PendingLaneScore | null> {
  const response = await localBridgeFetch("/lane-scores/pending", signal);
  if (!response.ok) throw new Error(`Pending lane score request failed (${response.status})`);
  const body = (await response.json()) as { pending?: unknown };
  return parsePending(body?.pending);
}

/** POST /lane-scores (score). Never throws on `ok:false` — that is a visible,
 *  non-destructive card error, not an exception. */
export async function submitLaneScore(submission: LaneScoreSubmission, signal?: AbortSignal): Promise<LaneScoreResult> {
  const payload: Record<string, unknown> = { matchId: submission.matchId, score: submission.score };
  if (typeof submission.opponentChampionId === "number") payload.opponentChampionId = submission.opponentChampionId;
  const note = submission.note?.trim();
  if (note) payload.note = note.slice(0, MAX_LANE_NOTE_LENGTH);
  return postLaneScore(payload, signal);
}

/** POST /lane-scores (skip). */
export async function skipLaneScore(matchId: string, signal?: AbortSignal): Promise<LaneScoreResult> {
  return postLaneScore({ matchId, skip: true }, signal);
}

async function postLaneScore(payload: Record<string, unknown>, signal?: AbortSignal): Promise<LaneScoreResult> {
  const response = await localBridgePostJson("/lane-scores", payload, signal);
  if (!response.ok) return { ok: false, reason: "http-error", message: `CoachBuild could not save the score (HTTP ${response.status}).` };
  const body = (await response.json()) as { ok?: unknown; reason?: unknown };
  if (body?.ok === true) return { ok: true };
  const reason = asString(body?.reason) ?? "bad-request";
  return { ok: false, reason, message: laneScoreFailureMessage(reason) };
}

export interface LaneRecommendationRow {
  championId: number;
  championName: string;
  games: number;
  mean: number;
  lastPlayedAt: string | null;
}

export interface LaneRecommendations {
  enemyChampionId: number;
  roleId: number;
  totalGames: number;
  best: LaneRecommendationRow[];
  worst: LaneRecommendationRow[];
}

function parseRows(raw: unknown): LaneRecommendationRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: LaneRecommendationRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const championId = asNumber(r.championId);
    const games = asNumber(r.games);
    const mean = asNumber(r.mean);
    if (championId === null || games === null || mean === null) continue;
    rows.push({
      championId,
      championName: asString(r.championName) ?? `Champion #${championId}`,
      games,
      mean,
      lastPlayedAt: asString(r.lastPlayedAt),
    });
  }
  return rows;
}

/** GET /lane-scores/recommendations?enemy=&role= */
export async function fetchLaneRecommendations(enemy: number, role: number, signal?: AbortSignal): Promise<LaneRecommendations> {
  const response = await localBridgeFetch(`/lane-scores/recommendations?enemy=${encodeURIComponent(enemy)}&role=${encodeURIComponent(role)}`, signal);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(asString(body?.error) ?? `Lane recommendations request failed (${response.status})`);
  return {
    enemyChampionId: asNumber(body?.enemyChampionId) ?? enemy,
    roleId: asNumber(body?.roleId) ?? role,
    totalGames: asNumber(body?.totalGames) ?? 0,
    best: parseRows(body?.best),
    worst: parseRows(body?.worst),
  };
}
