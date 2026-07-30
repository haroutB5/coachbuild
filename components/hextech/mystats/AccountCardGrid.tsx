"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AccountCardGrid — the reference's 3x2 grid of account cards, each showing a
// portrait-less avatar block, `Name #tag` (tag muted), a region chip, the rank
// and LP, with the ACTIVE card lifted on a lighter surface and a gold border.
//
// ── IT DOES NOT OWN THE SWITCH, AND THAT IS DELIBERATE ──────────────────────
// Switching accounts goes through `switchAccount` in ./accountPickerModel — the
// SAME pure mutation the (tested) AccountPicker uses — and it is passed in as a
// callback rather than called here. That indirection exists for one reason: the
// hard rule this page was fixed for is that a switch must force the summary to
// re-fetch, because every number on the page has just changed meaning and a
// stale figure beside a newly-active account name is the exact shipped bug.
// `switchAccount` fires `refetchSummary` if and only if the server reported
// `switched: true`. A second, hand-rolled switch path in this file would be a
// second place for that rule to be forgotten, which is how the /api/pros
// query-drift bug (CLAUDE.md gotcha (dd)) happened. One mutation, two UIs.
//
// ── WHAT THE GRID DOES WITH TWO ACCOUNTS ────────────────────────────────────
// The reference shows six filled cells. This install has two linked accounts.
// Columns are 1 / 2 / 3 by breakpoint and the cards FLOW rather than sitting in
// fixed slots, so two accounts plus the trailing action cell is exactly one full
// row of three at `lg` — a deliberate row, not four holes. See
// buildAccountCards' doc comment for why the trailing cell is "Link another
// account" at this size and only becomes the reference's "Show all accounts"
// once there is genuinely something hidden.
//
// ── RANK: THREE STATES, NOT TWO ─────────────────────────────────────────────
// A card renders `rank.label` from `formatRank`, which never returns an empty
// string. An account whose rank has never been read says "Rank not synced" — it
// does NOT say "Unranked" and it does NOT render a blank emblem. That case is
// the NORMAL one for a linked-but-inactive account, since a Riot call is only
// ever spent on the active one, so getting it wrong would mislabel half this
// grid on every load.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import type { AccountCard, AccountCardGridModel, RankDisplay } from "./profileModel";
import { formatRegionChip } from "./profileModel";

const RANK_TONE: Record<RankDisplay["state"], string> = {
  // Colour is state, not decoration: only a REAL standing is accented.
  ranked: "text-teal",
  unranked: "text-mut",
  unknown: "text-mut/70",
};

export interface AccountCardGridProps {
  model: AccountCardGridModel;
  /** Champion icon for the account's most-played champion, when known. Purely
   *  an avatar — a null renders the initial-glyph fallback, never a gap. */
  avatarOf?: (card: AccountCard) => string | undefined;
  /** Fired on a card click for a NON-active account. Must route through
   *  accountPickerModel's `switchAccount` so the summary re-fetch cannot be
   *  lost — see this file's header. */
  onSelect: (id: number) => void;
  /** Non-null while a switch is in flight, so the card can show it. */
  pendingId?: number | null;
  /** Trailing cell: reveal the hidden accounts. */
  onShowAll?: () => void;
  /** Trailing cell: jump to the link/detect flow (the account picker below). */
  onLinkAnother?: () => void;
  disabled?: boolean;
}

export default function AccountCardGrid({
  model,
  avatarOf,
  onSelect,
  pendingId = null,
  onShowAll,
  onLinkAnother,
  disabled = false,
}: AccountCardGridProps) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5" role="list">
      {model.cards.map((card) => {
        const region = formatRegionChip(card.region);
        const pending = pendingId === card.id;
        const avatar = avatarOf?.(card) ?? "";
        return (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => !card.active && onSelect(card.id)}
              disabled={disabled || card.active || pending}
              // aria-current, not aria-pressed: this is "which of these is the
              // one in use", not a toggle.
              aria-current={card.active ? "true" : undefined}
              aria-label={
                card.active
                  ? `${card.riotId}, the active account. ${card.rank.label}.`
                  : `Switch to ${card.riotId}. ${card.rank.label}.`
              }
              // 58px, not 76. The reference's cards are 59px on a 1290px page
              // and that shortness is most of what makes its grid read as dense
              // rather than as a list of settings rows. Everything still fits
              // because the layout changed shape with the height: the reference
              // puts TWO lines on each side of the card (name / region on the
              // left, rank / LP right-aligned on the right), where ours put
              // three things down the middle. Nothing was dropped to get here.
              className={`w-full min-h-[58px] text-left rounded-xl border px-2.5 py-2 flex items-center gap-2.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                card.active
                  ? "border-line-gold bg-panel2 cursor-default"
                  : "border-line bg-panel hover:bg-panel2/70 active:scale-[0.99] motion-reduce:active:scale-100"
              } ${disabled || pending ? "opacity-60" : ""}`}
            >
              <span className="w-8 h-8 rounded-full overflow-hidden bg-black/40 border border-line flex items-center justify-center flex-shrink-0">
                <IconWithFallback
                  src={avatar}
                  alt=""
                  fallbackGlyph={card.gameName}
                  className="w-full h-full object-cover"
                  size={32}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1 min-w-0">
                  <span className="text-[12.5px] font-semibold text-txt truncate tracking-[-0.01em] leading-[1.25]">
                    {card.gameName}
                  </span>
                  {card.tagLine && (
                    <span className="text-[10.5px] text-mut flex-shrink-0">#{card.tagLine}</span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
                  {region && (
                    <span className="inline-flex items-center h-[15px] px-1.5 rounded bg-white/[0.05] border border-line text-[8px] font-bold uppercase tracking-[0.07em] text-mut flex-shrink-0">
                      {region}
                    </span>
                  )}
                  {/* The games count moved off the right-hand column to keep
                      that column to the reference's rank-over-LP pair. It is
                      still on the card and still labelled on hover — it is a
                      real denominator and dropping it to save 12px would be the
                      wrong trade. */}
                  <span
                    className="text-[9px] text-mut/80 tabular-nums truncate"
                    title="Matches stored for this account, across every split"
                  >
                    {card.games}g stored
                  </span>
                </span>
              </span>

              {/* The reference's right-aligned pair: standing on top, LP under
                  it. Both slots keep their box when empty so a mixed grid of
                  ranked and never-synced accounts still aligns row to row. */}
              {/* Capped at 40% of the card. At 1024px the grid is three 241px
                  columns and an uncapped rank string ("Platinum IV") ate enough
                  of the row that the SHORTER of two account names started
                  truncating. The reference truncates names too — its own grid
                  shows "DepressedMegaMind #7…" — so a cap rather than a wrap is
                  the faithful answer; 40% is just where both fit. */}
              <span className="flex-shrink-0 text-right max-w-[40%]">
                <span
                  className={`block text-[9.5px] font-semibold truncate leading-[1.3] min-h-[13px] ${RANK_TONE[card.rank.state]}`}
                  title={card.rank.title}
                >
                  {card.rank.label}
                </span>
                {/* LP is the reference's right-aligned figure. Absent (unranked
                    or unread) leaves the slot EMPTY rather than printing a 0 —
                    and the slot keeps its width so cards stay aligned. */}
                <span className="block text-[13px] font-bold tabular-nums text-txt min-h-[17px] leading-[1.3]">
                  {card.rank.lp ?? <span className="text-mut/50">&mdash;</span>}
                </span>
              </span>
            </button>
          </li>
        );
      })}

      <li>
        <button
          type="button"
          onClick={() => (model.action === "show-all" ? onShowAll?.() : onLinkAnother?.())}
          className="w-full min-h-[58px] rounded-xl border border-dashed border-line bg-transparent px-3 py-2 flex flex-col items-center justify-center gap-0.5 text-mut hover:text-txt hover:border-line-gold transition-colors motion-reduce:transition-none active:scale-[0.99] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <span className="text-[11.5px] font-semibold">
            {model.action === "show-all" ? "Show all accounts" : "Link another account"}
          </span>
          <span className="text-[9.5px] text-mut/80">
            {model.action === "show-all"
              ? `${model.hiddenCount} more linked`
              : "Detected from your League client"}
          </span>
        </button>
      </li>
    </ul>
  );
}
