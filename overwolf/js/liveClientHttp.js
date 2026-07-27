// Promise wrapper around overwolf.web.sendHttpRequest, used ONLY to reach Riot's local
// Live Client Data REST API (https://127.0.0.1:<port>/liveclientdata/*) for data GEP's
// live_client_data feature does not carry: the full player list (needed to resolve the
// local player's champion name -- see gameState.js's header comment for why).
//
// overwolf.web.sendHttpRequest exists specifically to bypass the self-signed loopback
// certificate League's local API serves ("Send an https request to localhost/127.0.0.1
// while by-passing a valid certificate verification" -- Overwolf's own docs wording).
// It requires the "Web" permission, declared in manifest.json.
//
// The port is NEVER hardcoded (2999 is the common default but not guaranteed) -- callers
// must pass the `port` value read off the live_client_data GEP blob for this game session.

function sendHttpRequest(url) {
  return new Promise((resolve, reject) => {
    if (typeof overwolf === 'undefined' || !overwolf.web || !overwolf.web.sendHttpRequest) {
      reject(new Error('overwolf.web.sendHttpRequest unavailable (Web permission missing?)'));
      return;
    }
    overwolf.web.sendHttpRequest(url, 'GET', {}, null, (response) => {
      if (!response) {
        reject(new Error(`sendHttpRequest(${url}) returned no response`));
        return;
      }
      // Observed shape: { status: 200, success: true, headers, content: "<body text>" }.
      // Guard loosely -- this endpoint is never available outside a live game and was
      // never exercised end-to-end in this build environment (no League client here).
      if (response.success === false || (typeof response.status === 'number' && response.status >= 400)) {
        reject(new Error(`sendHttpRequest(${url}) HTTP ${response.status}`));
        return;
      }
      resolve(response.content);
    });
  });
}

/**
 * Fetch and JSON-parse /liveclientdata/playerlist from the local Live Client Data API.
 * Returns the parsed array, or throws on any network/parse failure -- callers should
 * treat a rejection as "no reading this tick," not as a fatal error (the endpoint is
 * only up while a match is actually in progress).
 *
 * @param {number} port - from live_client_data.port (GEP), never hardcoded.
 */
export async function fetchPlayerList(port) {
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`fetchPlayerList: invalid port (${port})`);
  }
  const body = await sendHttpRequest(`https://127.0.0.1:${port}/liveclientdata/playerlist`);
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  if (!Array.isArray(parsed)) {
    throw new Error('fetchPlayerList: response was not an array');
  }
  return parsed;
}
