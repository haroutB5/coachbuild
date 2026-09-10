"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import {
  MAX_LANE_NOTE_LENGTH, RANKED_QUEUE_LABEL, ROLE_LABEL, roleLabel,
  type LaneScoreResult, type LaneScoreSubmission, type PendingLaneScore, type RoleId,
} from "@/components/live/laneScoresClient";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const POLL_MS = 5000;

interface Draft { matchId: string; score: number | null; opponent: number | null; role: RoleId | null; note: string }
const EMPTY_DRAFT: Draft = { matchId: "", score: null, opponent: null, role: null, note: "" };

function champName(id: number, champIcons: Map<number, ChampionIconEntry>, fallback?: string | null): string {
  return champIcons.get(id)?.name ?? fallback ?? `Champion #${id}`;
}

function ChampionTile({ id, name, champIcons }: { id: number; name: string; champIcons: Map<number, ChampionIconEntry> }) {
  return <span className="h-8 w-8 shrink-0 overflow-hidden rounded">
    <IconWithFallback src={champIcons.get(id)?.icon ?? ""} alt={name} fallbackGlyph={name} size={32}
      className="h-full w-full object-cover" />
  </span>;
}

/**
 * "How did your lane go?" — the post-game scoring card.
 *
 * Renders NOTHING (null) unless the companion reports a pending ranked game,
 * so it never reserves space in champ select. The 1-10 ends are labelled on
 * the card itself (not in a tooltip) because these scores are compared across
 * months and an unlabelled scale drifts.
 *
 * When the companion could not determine the lane opponent the card refuses to
 * guess: it says so plainly and makes the user pick from the five enemy
 * champions before a score can be saved. Skip stays available either way.
 */
export default function LaneScoreCard({ champIcons, loadPending, submitScore, skipScore, onResolved }: {
  champIcons: Map<number, ChampionIconEntry>;
  loadPending: (signal: AbortSignal) => Promise<PendingLaneScore | null>;
  submitScore: (submission: LaneScoreSubmission, signal?: AbortSignal) => Promise<LaneScoreResult>;
  skipScore: (matchId: string, signal?: AbortSignal) => Promise<LaneScoreResult>;
  onResolved?: () => void;
}) {
  const [pending, setPending] = useState<PendingLaneScore | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Match ids already resolved in this session. The poll must not resurrect a
   *  card the user just cleared while the companion's write settles. */
  const resolved = useRef<Set<string>>(new Set());
  const submitting = useRef(false);

  const apply = useCallback((next: PendingLaneScore | null) => {
    const incoming = next && resolved.current.has(next.matchId) ? null : next;
    setPending(prev => (prev && incoming && prev.matchId === incoming.matchId ? prev : incoming));
    setDraft(prev => (incoming && prev.matchId === incoming.matchId
      ? prev
      : { ...EMPTY_DRAFT, matchId: incoming?.matchId ?? "" }));
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const next = await loadPending(controller.signal);
        if (!stopped && !submitting.current) apply(next);
      } catch {
        /* companion not up yet, or the endpoint is unavailable — the card
           simply stays hidden; there is nothing honest to show. */
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [loadPending, apply]);

  if (!pending) return null;

  const needsOpponent = pending.opponentChampionId === null;
  const opponentId = pending.opponentChampionId ?? draft.opponent;
  const myName = champName(pending.myChampionId, champIcons, pending.myChampionName);
  const opponentName = opponentId === null ? null : champName(opponentId, champIcons, pending.opponentChampionName);
  const role = roleLabel(pending.roleId);
  const needsRole = role === null;
  const queue = RANKED_QUEUE_LABEL[pending.queueId] ?? null;
  const canSubmit = !busy && draft.score !== null && (!needsOpponent || draft.opponent !== null)
    && (!needsRole || draft.role !== null);

  function finish(result: LaneScoreResult, matchId: string) {
    if (result.ok) {
      resolved.current.add(matchId);
      setPending(null);
      setDraft(EMPTY_DRAFT);
      setError(null);
      onResolved?.();
      return;
    }
    setError(result.message);
  }

  async function handleSave() {
    if (!pending || !canSubmit || draft.score === null || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      finish(await submitScore({
        matchId: pending.matchId, score: draft.score,
        roleId: needsRole ? draft.role : null,
        opponentChampionId: needsOpponent ? draft.opponent : null,
        note: draft.note,
      }), pending.matchId);
    } catch {
      setError("CoachBuild could not reach the companion, so the score was not saved. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!pending || busy || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      finish(await skipScore(pending.matchId), pending.matchId);
    } catch {
      setError("CoachBuild could not reach the companion, so the game was not skipped. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <section aria-label="Score your last ranked lane" className="rounded-lg bg-panel p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-txt">How did your lane go?</h2>
        <p className="mt-1 text-xs text-mut">
          Your own record, stored on this PC only.{queue ? ` · ${queue}` : ""}{role ? ` · ${role}` : ""}
        </p>
      </div>
      <button type="button" onClick={handleSkip} disabled={busy}
        className="rounded border border-line px-3 py-1.5 text-xs font-semibold text-mut disabled:opacity-50">
        Skip this game
      </button>
    </div>

    <div className="mt-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <ChampionTile id={pending.myChampionId} name={myName} champIcons={champIcons} />
        <span className="text-sm"><span className="block font-semibold text-txt">{myName}</span>
          <span className="block text-[11px] uppercase tracking-wide text-mut">You</span></span>
      </div>
      <span aria-hidden="true" className="text-xs font-semibold text-mut">vs</span>
      {opponentId === null
        ? <span className="text-sm text-mut">Opponent not identified</span>
        : <div className="flex items-center gap-2">
            <ChampionTile id={opponentId} name={opponentName ?? ""} champIcons={champIcons} />
            <span className="text-sm"><span className="block font-semibold text-txt">{opponentName}</span>
              <span className="block text-[11px] uppercase tracking-wide text-mut">Opponent</span></span>
          </div>}
    </div>

    {needsOpponent && <div className="mt-4 rounded-lg bg-panel2 p-3">
      <p className="text-sm text-txt">We couldn&apos;t tell who you laned against.</p>
      <p className="mt-1 text-xs text-mut">
        The League client did not give usable position data for this game, so nothing is pre-selected. Pick your lane
        opponent from the enemy team, or skip the game.
      </p>
      <div role="group" aria-label="Pick your lane opponent" className="mt-3 flex flex-wrap gap-2">
        {pending.enemyChampionIds.map(id => {
          const name = champName(id, champIcons);
          const selected = draft.opponent === id;
          return <button key={id} type="button" disabled={busy} aria-pressed={selected} aria-label={name} title={name}
            onClick={() => setDraft(prev => ({ ...prev, opponent: selected ? null : id }))}
            className={`h-9 w-9 overflow-hidden rounded ring-2 ${selected ? "ring-accent" : "ring-transparent"}`}>
            <IconWithFallback src={champIcons.get(id)?.icon ?? ""} alt="" fallbackGlyph={name} size={32}
              className="h-full w-full object-cover" />
          </button>;
        })}
      </div>
    </div>}

    {needsRole && <label className="mt-4 block text-sm text-txt">
      Which role did you play?
      <select aria-label="Your role" value={draft.role ?? ""} disabled={busy}
        onChange={event => setDraft(prev => ({ ...prev, role: event.target.value === "" ? null : Number(event.target.value) as RoleId }))}
        className="mt-1 block rounded bg-panel2 p-2 text-sm text-txt">
        <option value="">Choose your role</option>
        {Object.entries(ROLE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>}

    <div role="group" aria-label="Lane score from 1 to 10" className="mt-4 flex flex-wrap gap-1.5">
      {SCORES.map(value => {
        const selected = draft.score === value;
        return <button key={value} type="button" disabled={busy} aria-pressed={selected} aria-label={`Score ${value} out of 10`}
          onClick={() => setDraft(prev => ({ ...prev, score: selected ? null : value }))}
          className={`h-9 w-9 rounded font-semibold tabular-nums ${selected ? "bg-accent text-bg" : "bg-panel2 text-txt"}`}>
          {value}
        </button>;
      })}
    </div>
    <div className="mt-1.5 flex justify-between text-[11px] text-mut">
      <span>1 = unplayable</span><span>10 = free lane</span>
    </div>

    <label className="mt-4 block">
      <span className="text-xs text-mut">Note (optional)</span>
      <textarea value={draft.note} maxLength={MAX_LANE_NOTE_LENGTH} rows={2} disabled={busy}
        onChange={event => setDraft(prev => ({ ...prev, note: event.target.value }))}
        placeholder="What decided the lane?"
        className="mt-1 w-full rounded bg-panel2 p-2 text-sm text-txt placeholder:text-mut" />
      <span className="block text-right text-[11px] tabular-nums text-mut">
        {draft.note.length}/{MAX_LANE_NOTE_LENGTH}
      </span>
    </label>

    {needsOpponent && draft.opponent === null &&
      <p className="mt-2 text-xs text-mut">Pick the opponent above to save a score. Skip works without picking.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}

    <div className="mt-3 flex items-center gap-2">
      <button type="button" onClick={handleSave} disabled={!canSubmit}
        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50">
        {busy ? "Saving…" : "Save score"}
      </button>
      {draft.score !== null && <span className="text-xs text-mut">Saving {draft.score}/10</span>}
    </div>
  </section>;
}
