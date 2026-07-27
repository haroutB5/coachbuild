// Node-side client for Riot's local Live Client Data API
// (https://127.0.0.1:2999/liveclientdata/*). Runs in Electron's MAIN process.
//
// Riot serves a SELF-SIGNED certificate on this loopback endpoint (same fact the
// Overwolf build's js/liveClientHttp.js and public/companion.ps1's
// Initialize-TlsShim were both built around). The bypass here is SCOPED, per the
// repo's hard rule on this: a dedicated `https.Agent` with `rejectUnauthorized:
// false`, constructed once, used ONLY by the two functions below, and NEVER
// applied globally (no `process.env.NODE_TLS_REJECT_UNAUTHORIZED`, no blanket
// `app.on('certificate-error')` override touching Electron's BrowserWindow
// navigation). A BrowserWindow-level certificate-error handler was the other
// option the brief allowed, but this Agent approach is strictly narrower: it
// never touches Electron's own TLS validation for anything a BrowserWindow
// might ever load, only these two literal Node `https.get` call sites.
//
// UNVERIFIED end-to-end: this has never actually been pointed at a running
// League client from this file (no game running while this was written). The
// endpoints, field names, and self-signed-cert behavior are taken from the
// real capture at _capture/live-client-raw-20260727-140136.jsonl (captured by a
// DIFFERENT tool, `public/companion.ps1`'s TLS-shimmed path) and from Riot's
// published API shape -- not from this exact code path having been exercised.
// See HANDOFF-engy.md.

const https = require('https');

const HOST = '127.0.0.1';
const PORT = 2999;
const REQUEST_TIMEOUT_MS = 2000;

// Scoped bypass -- see file header. Never export or reuse this Agent for any
// other host.
const loopbackAgent = new https.Agent({ rejectUnauthorized: false });

function fetchLiveClientJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: HOST,
        port: PORT,
        path: urlPath,
        agent: loopbackAgent,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`fetchLiveClientJson(${urlPath}): failed to parse JSON -- ${err.message}`));
            }
          } else {
            reject(new Error(`fetchLiveClientJson(${urlPath}): HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`fetchLiveClientJson(${urlPath}): timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    // ECONNREFUSED lands here -- this is the NORMAL "no game running" case, not
    // a real error. Callers (main.js) are expected to treat every rejection
    // from this function as "no reading this tick," never surface it to the
    // user, and use it as the sole signal for game-running detection (there is
    // no separate "is League running" check -- a successful call to
    // /activeplayer IS the definition of "in game" here).
    req.on('error', reject);
  });
}

function fetchActivePlayer() {
  return fetchLiveClientJson('/liveclientdata/activeplayer');
}

function fetchPlayerList() {
  return fetchLiveClientJson('/liveclientdata/playerlist');
}

module.exports = {
  fetchActivePlayer,
  fetchPlayerList,
};
