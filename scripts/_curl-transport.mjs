// scripts/_curl-transport.mjs — script-side ONLY (never import from lib/).
// Shells out to the system `curl` binary instead of Node's built-in fetch.
//
// WHY: live-verified 2026-07-10 (see lib/prostage/cargo.ts's header + P0
// follow-up comment) — hitting Special:CargoExport from Node's own
// networking stack (global fetch AND the classic https module) got
// Cloudflare-403'd 5/5 times in a sandboxed dev environment, while the
// IDENTICAL query via curl succeeded reliably. This looks like a TLS/JA3
// fingerprint-level bot-detection block that headers can't fix. Since this
// script (unlike app/route code) is free to spawn a subprocess, curl is the
// pragmatic workaround for the script's own CargoExport calls.
//
// Uses execFile (NOT exec) — no shell involved, so the URL (which contains
// `&`, `"`, spaces, etc. from the Cargo WHERE clause) is passed as a single
// argv entry with no shell-quoting/injection surface.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const USER_AGENT = `coachbuild-ingest/${PKG_VERSION}`;

/**
 * A lib/prostage/cargo.ts CargoExportTransport implementation: given a URL,
 * returns the response body as text (curl's stdout), or throws with curl's
 * stderr in the message on a non-zero exit (network failure, DNS failure,
 * timeout, etc.) — same "never silently swallow a failure" contract as the
 * fetch-based default transport.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export function curlTransport(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-sL", "-m", "60", "-H", `User-Agent: ${USER_AGENT}`, url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`curl transport failed (exit ${err.code ?? "?"}): ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Same shape/contract as curlTransport, plus arbitrary extra headers — used
 * by scripts/ingest-draft.mjs for u.gg's stats2 CDN, which REQUIRES
 * `Referer: https://u.gg/` (403s without it; see lib/draft/ugg.ts's header
 * comment). Kept as a separate function rather than adding an optional
 * `headers` param to curlTransport so that function's call shape (and every
 * existing caller/test) stays byte-identical.
 *
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<string>}
 */
export function curlTransportWithHeaders(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
    execFile(
      "curl",
      ["-sL", "-m", "60", "-H", `User-Agent: ${USER_AGENT}`, ...headerArgs, url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`curl transport failed (exit ${err.code ?? "?"}): ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
