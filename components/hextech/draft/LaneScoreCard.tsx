"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, Check, Clock } from "@phosphor-icons/react";
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

/**
 * "Previous game" review panel — the post-game scoring card re-skinned as a
 * right-side overlay. Opens only via the header pill (never auto-opens) and
 * closes with Escape, the close button, or after Save score / Skip game.
 *
 * Data flow is unchanged: polls fetchPendingLaneScore, saves via submitScore,
 * skips via skipScore. Renders NOTHING (null) unless `open` — and when open
 * with nothing pending, shows the header plus an explicit empty line.
 *
 * When the companion could not determine the lane opponent the card refuses to
 * guess: it says so plainly and makes the user pick from the five enemy
 * champions before a score can be saved. Skip stays available either way.
 */
export default function LaneScoreCard({ champIcons, loadPending, submitScore, skipScore, onResolved, open, onClose, onPendingChange }: {
  champIcons: Map<number, ChampionIconEntry>;
  loadPending: (signal: AbortSignal) => Promise<PendingLaneScore | null>;
  submitScore: (submission: LaneScoreSubmission, signal?: AbortSignal) => Promise<LaneScoreResult>;
  skipScore: (matchId: string, signal?: AbortSignal) => Promise<LaneScoreResult>;
  onResolved?: () => void;
  open: boolean;
  onClose: () => void;
  onPendingChange?: (hasPending: boolean) => void;
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

  useEffect(() => {
    onPendingChange?.(pending !== null);
  }, [pending, onPendingChange]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needsOpponent = pending !== null && pending.opponentChampionId === null;
  const opponentId = pending === null ? null : (pending.opponentChampionId ?? draft.opponent);
  const myName = pending === null ? "" : champName(pending.myChampionId, champIcons, pending.myChampionName);
  const opponentName = opponentId === null || pending === null
    ? null
    : champName(opponentId, champIcons, pending.opponentChampionName);
  const role = pending === null ? null : roleLabel(pending.roleId);
  const needsRole = pending !== null && role === null;
  const queue = pending === null ? null : (RANKED_QUEUE_LABEL[pending.queueId] ?? "Ranked");
  const canSubmit = pending !== null && !busy && draft.score !== null
    && (!needsOpponent || draft.opponent !== null)
    && (!needsRole || draft.role !== null);

  function finish(result: LaneScoreResult, matchId: string) {
    if (result.ok) {
      resolved.current.add(matchId);
      setPending(null);
      setDraft(EMPTY_DRAFT);
      setError(null);
      onResolved?.();
      onClose();
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

  return (
    <div className="d25-panelroot">
      <div className="d25-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Previous game"
        className="d25-panel"
      >
        <div className="d25-panel-head">
          <Clock size={26} color="#E8EEF5" aria-hidden="true" />
          <h2 className="d25-panel-title">Previous game</h2>
          <span className="d25-qpill">{queue ?? "Ranked"}<CaretDown size={14} aria-hidden="true" /></span>
          <button type="button" onClick={onClose} aria-label="Close previous game panel" className="d25-panel-close">×</button>
        </div>

        {pending === null ? (
          <p className="d25-panel-empty">No ranked game waiting to be scored.</p>
        ) : (
          <div aria-label="Score your last ranked lane">
            <h3 className="d25-panel-h">How did your lane go?</h3>
            <div className="d25-matchup">
              <div className="d25-matchside">
                <IconWithFallback
                  src={champIcons.get(pending.myChampionId)?.icon ?? ""}
                  alt={myName}
                  fallbackGlyph={myName}
                  size={76}
                  className="d25-matchimg"
                />
                <span className="d25-matchname">{myName}</span>
                <span className="d25-matchsub">You · {role ?? "Unknown role"}</span>
              </div>
              <span aria-hidden="true" className="d25-vs">VS</span>
              <div className="d25-matchside">
                {opponentId === null ? (
                  <>
                    <span className="d25-matchimg d25-matchimg-empty" aria-hidden="true">?</span>
                    <span className="d25-matchname">Unknown</span>
                    <span className="d25-matchsub">Pick below</span>
                  </>
                ) : (
                  <>
                    <IconWithFallback
                      src={champIcons.get(opponentId)?.icon ?? ""}
                      alt={opponentName ?? ""}
                      fallbackGlyph={opponentName ?? ""}
                      size={76}
                      className="d25-matchimg"
                    />
                    <span className="d25-matchname">{opponentName}</span>
                    <span className="d25-matchsub">Opponent</span>
                  </>
                )}
              </div>
            </div>

            <hr className="d25-hr" />

            <h3 className="d25-panel-h">Lane opponent</h3>
            {needsOpponent && (
              <p className="d25-panel-note">
                We couldn&apos;t tell who you laned against. The League client did not give usable
                position data for this game, so nothing is pre-selected. Pick your lane opponent below.
              </p>
            )}
            <div role="group" aria-label="Pick your lane opponent" className="d25-tiles">
              {pending.enemyChampionIds.map(id => {
                const name = champName(id, champIcons);
                const selected = (pending.opponentChampionId ?? draft.opponent) === id;
                return (
                  <div key={id} className="d25-tilewrap">
                    <button
                      type="button"
                      disabled={busy || pending.opponentChampionId !== null}
                      aria-pressed={selected}
                      aria-label={name}
                      title={name}
                      onClick={() => setDraft(prev => ({ ...prev, opponent: selected ? null : id }))}
                      className={`d25-tile${selected ? " d25-tile-sel" : ""}`}
                    >
                      <IconWithFallback
                        src={champIcons.get(id)?.icon ?? ""}
                        alt=""
                        fallbackGlyph={name}
                        size={64}
                        className="d25-tileimg"
                      />
                      {selected && (
                        <span className="d25-check" aria-hidden="true">
                          <Check size={14} weight="bold" color="#1A1405" />
                        </span>
                      )}
                    </button>
                    <span className="d25-tilename">{name}</span>
                  </div>
                );
              })}
            </div>

            <hr className="d25-hr" />

            <div className="d25-prevrole">
              <label htmlFor="d25-prevrole-select" className="d25-prevrole-label">Previous role</label>
              {needsRole ? (
                <select
                  id="d25-prevrole-select"
                  aria-label="Your role"
                  value={draft.role ?? ""}
                  disabled={busy}
                  onChange={event => setDraft(prev => ({ ...prev, role: event.target.value === "" ? null : Number(event.target.value) as RoleId }))}
                  className="d25-prevrole-select"
                >
                  <option value="">Choose your role</option>
                  {Object.entries(ROLE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              ) : (
                <span className="d25-prevrole-value">{role}</span>
              )}
            </div>

            <h3 className="d25-panel-h">How easy was your lane?</h3>
            <div role="group" aria-label="Lane score from 1 to 10" className="d25-scores">
              {SCORES.map(value => {
                const selected = draft.score === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    aria-pressed={selected}
                    aria-label={`Score ${value} out of 10`}
                    onClick={() => setDraft(prev => ({ ...prev, score: selected ? null : value }))}
                    className={`d25-scorebtn${selected ? " d25-scorebtn-sel" : ""}`}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
            <div className="d25-scalelabels" aria-hidden="true">
              <span>1 · Unplayable</span><span>10 · Free lane</span>
            </div>

            <label className="d25-notelabel" htmlFor="d25-note">
              Note (optional)
            </label>
            <textarea
              id="d25-note"
              value={draft.note}
              maxLength={MAX_LANE_NOTE_LENGTH}
              rows={2}
              disabled={busy}
              onChange={event => setDraft(prev => ({ ...prev, note: event.target.value }))}
              placeholder="What decided the lane?"
              className="d25-note"
            />
            <span className="d25-counter">{draft.note.length}/{MAX_LANE_NOTE_LENGTH}</span>

            {needsOpponent && draft.opponent === null && pending.opponentChampionId === null &&
              <p className="d25-panel-note">Pick the opponent above to save a score. Skip works without picking.</p>}
            {error && <p role="alert" className="d25-panel-error">{error}</p>}

            <div className="d25-panel-actions">
              <button type="button" onClick={handleSave} disabled={!canSubmit} className="d25-savebtn">
                {busy ? "Saving…" : "Save score"}
              </button>
              <button type="button" onClick={handleSkip} disabled={busy} className="d25-skipbtn">
                Skip game
              </button>
            </div>
            <p className="d25-stored">Your ratings are stored on this PC.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
