import type { getSql } from "@/lib/pro/db";
import { isAccountsRequestError, parseAccountsBody } from "@/lib/mystats/accountRequest";

type Sql = NonNullable<ReturnType<typeof getSql>>;

export const DIAGNOSTICS_BODY_MAX_BYTES = 256 * 1024;
export const DIAGNOSTICS_KEEP_COUNT = 5;
export const DIAGNOSTICS_SOURCE = "companion" as const;

export interface DiagnosticsIdentity {
  gameName: string;
  tagLine: string;
}

export interface DiagnosticsRequest extends DiagnosticsIdentity {
  body: string;
  source: typeof DIAGNOSTICS_SOURCE;
}

export interface DiagnosticsError {
  error: string;
}

export function isDiagnosticsError<T>(value: T | DiagnosticsError): value is DiagnosticsError {
  return typeof (value as DiagnosticsError).error === "string";
}

/**
 * Validates a Riot-ID identity through the same detect contract used by the
 * accounts and rank-sample endpoints. There is deliberately no puuid path: the
 * companion only has the League client's local UUID, not Riot's encrypted key.
 */
export function parseDiagnosticsIdentity(gameName: unknown, tagLine: unknown): DiagnosticsIdentity | DiagnosticsError {
  const parsed = parseAccountsBody({ mode: "detect", gameName, tagLine });
  if (isAccountsRequestError(parsed)) return { error: parsed.error };
  if (parsed.mode !== "detect") return { error: "gameName and tagLine are required" };
  return { gameName: parsed.gameName, tagLine: parsed.tagLine };
}

/** PURE request validation. Size is measured in UTF-8 bytes, as stored. */
export function parseDiagnosticsBody(value: unknown): DiagnosticsRequest | DiagnosticsError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "body must be a JSON object" };
  }
  const raw = value as Record<string, unknown>;

  const identity = parseDiagnosticsIdentity(raw.gameName, raw.tagLine);
  if (isDiagnosticsError(identity)) return identity;

  if (typeof raw.body !== "string") return { error: "body must be a string" };
  const bodyBytes = Buffer.byteLength(raw.body, "utf8");
  if (bodyBytes > DIAGNOSTICS_BODY_MAX_BYTES) {
    return { error: `body must be <= ${DIAGNOSTICS_BODY_MAX_BYTES} UTF-8 bytes` };
  }

  if (raw.source !== DIAGNOSTICS_SOURCE) {
    return { error: `source must be "${DIAGNOSTICS_SOURCE}"` };
  }

  return { ...identity, body: raw.body, source: DIAGNOSTICS_SOURCE };
}

/** `n` is human-facing and therefore one-based: 1 is the latest upload. */
export function parseDiagnosticsOrdinal(value: string | null): number | DiagnosticsError {
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value)) {
    return { error: `n must be an integer between 1 and ${DIAGNOSTICS_KEEP_COUNT}` };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > DIAGNOSTICS_KEEP_COUNT) {
    return { error: `n must be an integer between 1 and ${DIAGNOSTICS_KEEP_COUNT}` };
  }
  return n;
}

export interface DiagnosticsWrite {
  puuid: string;
  body: string;
  source: typeof DIAGNOSTICS_SOURCE;
}

export interface DiagnosticsWriteResult {
  uploadedAt: string | null;
  pruned: number;
}

/**
 * Inserts and prunes in one statement. The inserted CTE is UNIONed into the
 * retention candidates explicitly because data-modifying CTEs share a snapshot:
 * selecting only from the base table would not see the new row and would leave
 * six uploads after inserting into an account that already had five.
 */
export async function insertDiagnostics(sql: Sql, upload: DiagnosticsWrite): Promise<DiagnosticsWriteResult> {
  const rows = (await sql`
    WITH inserted AS (
      INSERT INTO coachbuild.my_diagnostics (puuid, body, source)
      VALUES (${upload.puuid}, ${upload.body}, ${upload.source})
      RETURNING ctid, uploaded_at
    ),
    candidates AS (
      SELECT ctid, uploaded_at, false AS just_inserted
      FROM coachbuild.my_diagnostics
      WHERE puuid = ${upload.puuid}
      UNION ALL
      SELECT ctid, uploaded_at, true AS just_inserted
      FROM inserted
    ),
    overflow AS (
      SELECT ctid
      FROM candidates
      ORDER BY uploaded_at DESC, just_inserted DESC, ctid DESC
      OFFSET ${DIAGNOSTICS_KEEP_COUNT}
    ),
    removed AS (
      DELETE FROM coachbuild.my_diagnostics d
      USING overflow o
      WHERE d.ctid = o.ctid
      RETURNING 1 AS one
    )
    SELECT
      (SELECT uploaded_at FROM inserted LIMIT 1) AS uploaded_at,
      (SELECT count(*) FROM removed)::int AS pruned
  `) as unknown as { uploaded_at: string | null; pruned: number | null }[];

  const row = rows[0];
  return { uploadedAt: row?.uploaded_at ?? null, pruned: row?.pruned ?? 0 };
}

export interface DiagnosticsUpload {
  body: string;
  source: string;
  uploadedAt: string;
}

export async function getDiagnostics(sql: Sql, puuid: string, n: number): Promise<DiagnosticsUpload | null> {
  const rows = (await sql`
    SELECT body, source, uploaded_at
    FROM coachbuild.my_diagnostics
    WHERE puuid = ${puuid}
    ORDER BY uploaded_at DESC
    OFFSET ${n - 1}
    LIMIT 1
  `) as unknown as { body: string; source: string; uploaded_at: string }[];
  const row = rows[0];
  if (!row) return null;
  return { body: row.body, source: row.source, uploadedAt: row.uploaded_at };
}
