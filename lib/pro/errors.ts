// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/errors.ts — typed errors so routes/scripts can map to the right
// status code / message without string matching.
// ─────────────────────────────────────────────────────────────────────────────

export class RiotUnavailableError extends Error {
  constructor(message = "RIOT_API_KEY not configured") {
    super(message);
    this.name = "RiotUnavailableError";
  }
}

export class DbUnavailableError extends Error {
  constructor(message = "DATABASE_URL not configured") {
    super(message);
    this.name = "DbUnavailableError";
  }
}
