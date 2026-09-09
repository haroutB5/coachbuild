import { getStoredPort, getStoredSession } from "@/components/live/companionClient";

/**
 * Single sink for loopback-bridge calls from the packaged UI. The companion
 * gates every endpoint on Origin + `?session=`, so the session is appended
 * here rather than at each call site.
 *
 * `init` is optional and additive so the original `(path, signal)` call shape
 * keeps working: pass a method/body through it for POSTs. An explicit
 * `signal` argument always wins over `init.signal`, and when neither is given
 * the 20s timeout still applies — a bridge call must never hang forever.
 */
export async function localBridgeFetch(path: string, signal?: AbortSignal, init?: RequestInit): Promise<Response> {
  const port = getStoredPort();
  const session = getStoredSession();
  if (!port || !session) throw new Error("Companion connection unavailable");
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (url.origin !== `http://127.0.0.1:${port}`) throw new Error("Invalid bridge destination");
  url.searchParams.set("session", session);
  return fetch(url, { ...init, signal: signal ?? init?.signal ?? AbortSignal.timeout(20000) });
}

/** POST JSON to the bridge. Kept next to the GET path so the session/origin
 *  handling can never drift between the two. */
export async function localBridgePostJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return localBridgeFetch(path, signal, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
