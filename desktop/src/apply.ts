// ─────────────────────────────────────────────────────────────────────────────
// apply.ts — rune-page and item-set writes.
//
// This file is TRANSPORT ONLY. Every decision about what may be written lives
// in ../../lib/lcu/applySafety.ts, shared with the web repo and pinned by 31
// unit tests in the normal `npm test` gate. That split is deliberate: the
// PowerShell companion earned those rules through ten live-reported bugs, and
// re-deriving them by hand in a second implementation is exactly how they come
// back. If you are tempted to add a condition here, add it there instead.
// ─────────────────────────────────────────────────────────────────────────────
import {
  decideRuneApply,
  isValidItemSetsPayload,
  mergeItemSets,
  type ItemSet,
  type ItemSetsDocument,
  type LcuRunePage,
  type RuneApplyBody,
  type RuneApplyMode,
} from "../../lib/lcu/applySafety";
import { lcuRequest, type LcuCredentials } from "./lcu";

export type ApplyRunesResult =
  | { ok: true; selected: boolean; verified: boolean; mismatch: string[] }
  | { ok: false; reason: string; hint?: string };

export type ApplyItemSetsResult = { ok: true; count: number } | { ok: false; reason: string; hint?: string };

/** Bug #1013 (RiotGames/developer-relations): a DELETE on an isDeletable page
 *  can falsely report failure. Fail SOFT — a failed cleanup delete must never
 *  abort the write we were actually asked to do. */
const deleteQuietly = async (credentials: LcuCredentials, pageId: number): Promise<void> => {
  await lcuRequest(credentials, "DELETE", `/lol-perks/v1/pages/${pageId}`);
};

const readOwnedPageCount = async (credentials: LcuCredentials): Promise<number | null> => {
  const inventory = await lcuRequest<{ ownedPageCount?: number }>(credentials, "GET", "/lol-perks/v1/inventory");
  const count = inventory.body?.ownedPageCount;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
};

export const applyRunes = async (
  credentials: LcuCredentials,
  body: RuneApplyBody,
  mode: RuneApplyMode,
): Promise<ApplyRunesResult> => {
  const pagesResponse = await lcuRequest<LcuRunePage[]>(credentials, "GET", "/lol-perks/v1/pages");
  if (!pagesResponse.ok) {
    return { ok: false, reason: `http-${pagesResponse.status}`, hint: "League client refused to list rune pages — is the client open?" };
  }
  const pages = Array.isArray(pagesResponse.body) ? pagesResponse.body : [];
  const currentPage = await lcuRequest<{ id?: number }>(credentials, "GET", "/lol-perks/v1/currentpage");

  const action = decideRuneApply({
    body,
    pages,
    ownedPageCount: await readOwnedPageCount(credentials),
    currentPageId: typeof currentPage.body?.id === "number" ? currentPage.body.id : null,
    mode,
  });

  if (action.kind === "reject") {
    return {
      ok: false,
      reason: action.reason,
      hint:
        action.reason === "slots-full"
          ? "No free rune page and none of your pages are ours to replace — free a slot and try again."
          : "Refused: that write is not a CoachBuild page.",
    };
  }

  for (const pageId of action.deleteFirst) {
    await deleteQuietly(credentials, pageId);
  }

  let pageId: number | null = null;

  if (action.kind === "edit") {
    // Edit in place. Never delete-then-create: the LCU refuses to delete the
    // page that is currently selected, and overwriting our own page is exactly
    // as consented as creating it was.
    const put = await lcuRequest<{ id?: number }>(credentials, "PUT", `/lol-perks/v1/pages/${action.pageId}`, {
      ...body,
      id: action.pageId,
    });
    if (!put.ok) return { ok: false, reason: `http-${put.status}`, hint: "The client rejected the rune-page edit." };
    pageId = action.pageId;
  } else {
    if (action.kind === "replace-current" && action.currentPageId != null) {
      await deleteQuietly(credentials, action.currentPageId);
    }
    const post = await lcuRequest<{ id?: number }>(credentials, "POST", "/lol-perks/v1/pages", body);
    if (!post.ok) {
      return { ok: false, reason: `http-${post.status}`, hint: "The client rejected the new rune page." };
    }
    pageId = typeof post.body?.id === "number" ? post.body.id : null;
  }

  // Select it, then read back and compare. Both can fail while the page still
  // exists, so they are reported honestly rather than folded into ok:false —
  // the page WAS written, and saying otherwise would be a lie the user acts on.
  let selected = false;
  if (pageId != null) {
    const select = await lcuRequest(credentials, "PUT", "/lol-perks/v1/currentpage", pageId);
    selected = select.ok;
  }

  const readback = await lcuRequest<{ selectedPerkIds?: number[] }>(credentials, "GET", "/lol-perks/v1/currentpage");
  const written = readback.body?.selectedPerkIds ?? [];
  const mismatch = body.selectedPerkIds.filter((perk, index) => written[index] !== perk).map(String);

  return { ok: true, selected, verified: mismatch.length === 0, mismatch };
};

export const applyItemSets = async (
  credentials: LcuCredentials,
  championId: number,
  sets: ItemSet[],
  replacePrefix?: string | null,
): Promise<ApplyItemSetsResult> => {
  if (!isValidItemSetsPayload(sets, replacePrefix)) {
    return { ok: false, reason: "bad-payload", hint: "Refused: those item sets are not ours to write." };
  }

  const summoner = await lcuRequest<{ summonerId?: number }>(credentials, "GET", "/lol-summoner/v1/current-summoner");
  const summonerId = summoner.body?.summonerId;
  if (!summonerId) {
    return { ok: false, reason: "no-summoner", hint: "League client not fully signed in yet." };
  }

  const existing = await lcuRequest<ItemSetsDocument>(credentials, "GET", `/lol-item-sets/v1/item-sets/${summonerId}/sets`);
  if (!existing.ok) {
    return { ok: false, reason: `http-${existing.status}`, hint: "Could not read your existing item sets." };
  }

  // championId is carried for the caller's own bookkeeping/logging; the merge
  // itself is champion-agnostic by design (the prune boundary is the generic
  // CoachBuild prefix, which is what bounds the payload at O(1)).
  void championId;

  const merged = mergeItemSets(existing.body, sets);
  const put = await lcuRequest(credentials, "PUT", `/lol-item-sets/v1/item-sets/${summonerId}/sets`, merged);
  if (!put.ok) {
    return {
      ok: false,
      reason: `http-${put.status}`,
      hint:
        put.status === 413
          ? "The client rejected the write as too large — this should not happen; please report it."
          : "The client refused the item-set write.",
    };
  }

  return { ok: true, count: sets.length };
};
