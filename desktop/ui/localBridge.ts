import { getStoredPort, getStoredSession } from "@/components/live/companionClient";

export async function localBridgeFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const port = getStoredPort();
  const session = getStoredSession();
  if (!port || !session) throw new Error("Companion connection unavailable");
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (url.origin !== `http://127.0.0.1:${port}`) throw new Error("Invalid bridge destination");
  url.searchParams.set("session", session);
  return fetch(url, { signal: signal ?? AbortSignal.timeout(20000) });
}
