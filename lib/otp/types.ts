import type { ProGame } from "../pro/types";

/** One tracked one-trick behind an OTP sample. Surfaced so the card's footer
 *  can state exactly WHO it aggregated rather than asserting "one-tricks" and
 *  leaving the user to trust it. */
export interface OtpPlayerSummary {
  name: string;
  region: string;
  /** op.gg's games-on-this-champion count at last discovery. */
  championPlays: number;
  /** e.g. "CHALLENGER". Null when op.gg didn't report one — never guessed. */
  tier: string | null;
  /** Games from THIS player inside the returned sample. */
  gamesInSample: number;
}

/** THE CONTRACT — GET /api/otp response.
 *
 *  `games` are real Riot solo-queue matches, so they carry `source: "soloq"`
 *  and slot into the existing ProGame consumers unchanged. purchaseOrder and
 *  skillOrder are always [] — the ingest deliberately skips the match-v5
 *  timeline call (see migration 0017 / lib/otp/ingest.ts), the same
 *  structural gap prostage rows already have. */
export interface OtpResponse {
  games: ProGame[];
  players: OtpPlayerSummary[];
  /** True when the champion has tracked one-tricks but no ingested games yet
   *  — a "come back shortly" state, distinct from "we track nobody for this
   *  champion." The UI must not present the two the same way. */
  pending: boolean;
}
