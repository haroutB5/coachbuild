"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AccountCardGrid — the reference's 3x2 grid of account cards, each showing a
// portrait-less avatar block, `Name #tag` (tag muted), a region chip, the rank,
// the LP and the account's own WIN RATE, with the ACTIVE card lifted on a
// lighter surface and a gold border.
//
// ── WHY THE WIN RATE IS HERE AND NOT IN A STRIP ─────────────────────────────
// 2026-07-30 user directive: the page's KPI strip (games / win rate / build
// adherence) was deleted and the win rate moved onto these cards. The strip was
// the ACTIVE account's figures only, so it printed one win rate above a grid of
// accounts that each have their own — the number and its subject were in
// different places. On the card, the figure sits inside the box that names whose
// it is, and every account carries its own instead of one borrowing the look of
// a page-wide total. `card.record` is per-account by construction; see
// resolveAccountWinrate in ./profileModel.
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
import { formatPct, formatRegionChip } from "./profileModel";

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
              // The win rate is spoken too, and with its denominator — a bare
              // "52.1%" in a label is a percentage of nothing stated.
              aria-label={
                (card.active
                  ? `${card.riotId}, the active account. ${card.rank.label}.`
                  : `Switch to ${card.riotId}. ${card.rank.label}.`) +
                (card.record.pct === null
                  ? ""
                  : ` ${formatPct(card.record.pct)} win rate over ${card.record.games} games.`)
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
                    // Wording updated 2026-07-30 with the solo-queue-only
                    // filter: every My Stats read now counts solo queue and
                    // nothing else, so "matches" alone over-claimed — the count
                    // dropped materially on at least one live account when the
                    // filter landed. The QUEUE RULE itself lives server-side
                    // (lib/mystats/queues.ts); this is a label, not a second
                    // copy of it, and no queue id appears on the client.
                    title="Solo-queue matches stored for this account this season"
                  >
                    {/* "141g", not "141g stored". MEASURED, not trimmed for
                        taste: with the win rate now sharing the right-hand
                        column, 1024px (three 241px columns) truncated BOTH the
                        account name and this line — "Munst…" beside "138g
                        sto…", which is two clipped strings in a 58px card. The
                        word cost ~30px and the tooltip already carries the full
                        sentence, so dropping it buys the name back. */}
                    {card.games}g
                  </span>
                </span>
              </span>

              {/* The reference's right-aligned pair: standing on top, LP under
                  it. Both slots keep their box when empty so a mixed grid of
                  ranked and never-synced accounts still aligns row to row. */}
              {/* Capped at 46% of the card. It was 40% when this column held
                  rank-over-LP only; the win rate moved in beside the LP
                  (2026-07-30 user directive, replacing the deleted KPI strip)
                  and two tabular figures on one line need the extra six points.
                  A cap rather than a wrap is still the faithful answer — the
                  reference truncates account names too ("DepressedMegaMind
                  #7…") — and the name keeps `truncate` on the other side. */}
              <span className="flex-shrink-0 text-right max-w-[46%]">
                <span
                  className={`block text-[9.5px] font-semibold truncate leading-[1.3] min-h-[13px] ${RANK_TONE[card.rank.state]}`}
                  title={card.rank.title}
                >
                  {card.rank.label}
                </span>
                {/* LP, then the account's own win rate.
                    BOTH slots keep their box when empty — an em dash, never a
                    0 and never a collapsed row. LP absent means unranked or
                    unread; win rate absent means the response carried no
                    honestly-readable rate for this account (see
                    resolveAccountWinrate). The two are independent, so a
                    ranked account with no rate and an unranked account with a
                    rate both still align row-to-row.
                    `justify-end` + `whitespace-nowrap`: at 1024px this column
                    is ~110px and a wrap here would put the win rate under the
                    LP, which reads as a second, unlabelled figure. */}
                <span className="flex items-baseline justify-end gap-1.5 min-h-[17px] whitespace-nowrap">
                  <span className="text-[13px] font-bold tabular-nums text-txt leading-[1.3]">
                    {card.rank.lp ?? <span className="text-mut/50">&mdash;</span>}
                  </span>
                  {/* Colour is STATE, not decoration: a rate over too small a
                      sample stays muted rather than wearing a green/red verdict
                      it has not earned — the same rule the champion rows use. */}
                  <span
                    title={card.record.title}
                    className={`text-[13px] font-bold tabular-nums leading-[1.3] ${
                      card.record.pct === null
                        ? "text-mut/50"
                        : card.record.lowSample
                          ? "text-mut"
                          : card.record.pct >= 0.5
                            ? "text-good"
                            : "text-bad"
                    }`}
                  >
                    {card.record.pct === null ? <>&mdash;</> : formatPct(card.record.pct)}
                  </span>
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
