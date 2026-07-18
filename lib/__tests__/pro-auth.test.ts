/**
 * Tests for lib/pro/auth.ts's isAuthorized bearer-token guard.
 * P3(c) fix (2026-07-17 Fable review): the comparison is now constant-time
 * (sha256-both-sides + crypto.timingSafeEqual) instead of `===`, which
 * short-circuits on the first mismatched byte — a timing side-channel for a
 * bearer-secret check. These tests cover correctness (the behavioral
 * contract must be unchanged), not timing itself (not practically
 * observable in a unit test).
 */
import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { isAuthorized } from "../pro/auth";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/ingest/matches", { headers });
}

describe("isAuthorized", () => {
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it("authorizes a correct Bearer header", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorized(req({ authorization: "Bearer wrong" }))).toBe(false);
  });

  it("rejects a wrong secret that's a different LENGTH than the real one (constant-time path, not a length-mismatch throw)", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorized(req({ authorization: "Bearer x" }))).toBe(false);
    expect(isAuthorized(req({ authorization: "Bearer way-way-way-too-long-of-a-guess" }))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorized(req())).toBe(false);
  });

  it("rejects a missing 'Bearer ' prefix", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorized(req({ authorization: "s3cret" }))).toBe(false);
  });

  it("never authorizes when CRON_SECRET is unset (fails closed), even against an empty header", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorized(req({ authorization: "Bearer " }))).toBe(false);
    expect(isAuthorized(req())).toBe(false);
  });

  it("is case-sensitive on the secret value", () => {
    process.env.CRON_SECRET = "S3cret";
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }))).toBe(false);
  });
});
