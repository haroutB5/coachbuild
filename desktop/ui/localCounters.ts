import { loadDdragon } from "@/lib/ddragonClient";
import { rankUggCounters, UGG_LANES } from "@/lib/ugg/counters";
import type { DraftCountersParams, DraftCountersResponse } from "@/components/live/draftCounters";

interface NativeCounterReply { id: string; type: string; rows?: unknown; patch?: string; sourceUrl?: string; error?: string }
interface NativeWebView {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<NativeCounterReply>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<NativeCounterReply>) => void): void;
}

function readNativeCounters(slug: string, lane: string, enemy: number, signal?: AbortSignal): Promise<NativeCounterReply> {
  const webview = (window as Window & { chrome?: { webview?: NativeWebView } }).chrome?.webview;
  if (!webview) return Promise.reject(new Error("Open Draft in CoachBuild Desktop to load u.gg counters"));
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = (error?: Error, reply?: NativeCounterReply) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      webview.removeEventListener("message", receive);
      if (error) reject(error); else resolve(reply!);
    };
    const abort = () => { webview.postMessage({ type: "ugg-counters-cancel", id }); finish(new DOMException("Aborted", "AbortError")); };
    const receive = (event: MessageEvent<NativeCounterReply>) => {
      const reply = event.data;
      if (reply?.type !== "ugg-counters-result" || reply.id !== id) return;
      finish(reply.error ? new Error(reply.error) : undefined, reply);
    };
    const timer = setTimeout(() => { webview.postMessage({ type: "ugg-counters-cancel", id }); finish(new Error("u.gg counters timed out")); }, 35000);
    webview.addEventListener("message", receive);
    signal?.addEventListener("abort", abort, { once: true });
    webview.postMessage({ type: "ugg-counters", id, slug, lane, enemy });
  });
}

const cache = new Map<string, { expires: number; data: DraftCountersResponse }>();
export async function loadLocalCounters(params: DraftCountersParams, signal?: AbortSignal): Promise<DraftCountersResponse> {
  const { version, champions } = await loadDdragon();
  const enemy = champions.find(c => c.id === params.enemy);
  const lane = UGG_LANES[params.lane];
  if (!enemy || !lane) throw new Error("Invalid counter selection");
  const slug = enemy.key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = `${enemy.id}:${lane}:${version}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  const reply = await readNativeCounters(slug, lane, enemy.id, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!reply.patch || !reply.sourceUrl) throw new Error("u.gg source metadata missing");
  const data: DraftCountersResponse = {
    enemy: { id: enemy.id, name: enemy.name, slug }, lane: params.lane,
    patch: reply.patch, sourceUrl: reply.sourceUrl, fetchedAt: new Date().toISOString(),
    ...rankUggCounters(reply.rows, champions),
  };
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 3600000, data });
  return data;
}
