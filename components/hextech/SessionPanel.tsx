import {
  SESSIONS_LIMIT,
  type SessionLpDelta,
  type SessionSummary,
} from "@/lib/mystats/sessions";

export interface SessionPanelProps {
  sessions: readonly SessionSummary[];
  /** Defaults to the viewer's locale. Exposed so fixed-format surfaces and
   * tests can request the same date order without changing the session data. */
  locale?: string;
  /** Defaults to the viewer's time zone. */
  timeZone?: string;
}

interface DateFormatOptions {
  locale?: string;
  timeZone?: string;
}

function asDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value: string, options: DateFormatOptions): string {
  const date = asDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: options.timeZone,
  }).format(date);
}

function formatTime(value: string, options: DateFormatOptions): string {
  const date = asDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: options.timeZone,
  }).format(date);
}

/** A calendar-day number in the displayed time zone, not an elapsed 24-hour
 * count. That keeps the "next day" marker correct across daylight saving. */
function displayedDay(value: string, options: DateFormatOptions): number | null {
  const date = asDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: options.timeZone,
  }).formatToParts(date);
  const numberPart = (type: "day" | "month" | "year") =>
    Number(parts.find((part) => part.type === type)?.value);
  const day = numberPart("day");
  const month = numberPart("month");
  const year = numberPart("year");
  if (![day, month, year].every(Number.isFinite)) return null;
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function dayOffset(session: SessionSummary, options: DateFormatOptions): number {
  const start = displayedDay(session.startedAt, options);
  const end = displayedDay(session.endedAt, options);
  return start === null || end === null ? 0 : Math.max(0, end - start);
}

function signedLp(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}

function lpTone(value: number): string {
  if (value > 0) return "text-good";
  if (value < 0) return "text-bad";
  return "text-mut";
}

function approximateReason(reason: SessionLpDelta["reason"]): string {
  switch (reason) {
    case "partial-open":
      return "The opening LP reading was taken after this session started.";
    case "partial-close":
      return "The closing LP reading was taken before this session ended.";
    case "partial-bracket":
      return "Both LP readings were taken during this session, so only part of it is measured.";
    case "extra-games":
      return "The LP readings also bracket games outside this session.";
    default:
      return "The available LP readings do not exactly bracket this session.";
  }
}

function approximateTitle(delta: SessionLpDelta): string {
  const extraGames = delta.extraGames;
  const extraGamesText =
    typeof extraGames !== "number"
      ? "The extra-game count is unavailable."
      : `${extraGames} extra ${extraGames === 1 ? "game" : "games"} included.`;
  return `Estimated LP change. ${approximateReason(delta.reason)} ${extraGamesText}`;
}

function LpDelta({ delta }: { delta: SessionLpDelta }) {
  // Confidence decides whether a number is allowed to render. In particular,
  // an unavailable payload remains a dash even if a stale producer supplied 0
  // (or any other numeric value) beside it.
  if (delta.confidence === "unavailable" || typeof delta.value !== "number") {
    return (
      <span className="text-mut" aria-label="LP change unavailable">
        —
      </span>
    );
  }

  const value = signedLp(delta.value);
  const className = `font-semibold tabular-nums ${lpTone(delta.value)}`;
  if (delta.confidence === "exact") return <span className={className}>{value}</span>;

  const title = approximateTitle(delta);
  return (
    <span className={className} title={title} aria-label={`${value} LP, estimated. ${title}`}>
      <span aria-hidden="true">≈</span>{" "}
      {value}
    </span>
  );
}

/** Recent ranked-solo sittings, newest first as supplied by the summary API. */
export default function SessionPanel({ sessions, locale, timeZone }: SessionPanelProps) {
  const formatOptions = { locale, timeZone };

  return (
    <section
      aria-label="Recent sessions"
      className="overflow-hidden rounded-[9px] bg-panel-glass shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]"
    >
      <div className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">
          Sessions
        </p>
        <p className="text-[10px] tabular-nums text-mut">Last {SESSIONS_LIMIT}</p>
      </div>

      {sessions.length === 0 ? (
        <p className="border-t border-white/[0.06] px-4 py-4 text-[11.5px] text-mut sm:px-5">
          No ranked solo sessions recorded yet.
        </p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-2 bg-white/[0.025] px-4 py-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-mut sm:grid-cols-[minmax(0,1fr)_76px_76px] sm:px-5"
          >
            <span>Session</span>
            <span className="text-right">Record</span>
            <span className="text-right">LP</span>
          </div>
          <ol className="divide-y divide-white/[0.06]">
            {sessions.map((session, index) => {
              const startTime = formatTime(session.startedAt, formatOptions);
              const endTime = formatTime(session.endedAt, formatOptions);
              const daysLater = dayOffset(session, formatOptions);
              return (
                <li
                  key={`${session.startedAt}-${session.endedAt}-${index}`}
                  className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_76px_76px] sm:px-5"
                >
                  <span className="min-w-0">
                    <time
                      dateTime={session.startedAt}
                      className="block truncate text-[11.5px] font-semibold text-txt"
                    >
                      {formatDate(session.startedAt, formatOptions)}
                    </time>
                    <span className="mt-0.5 block truncate text-[10px] tabular-nums text-mut">
                      <time dateTime={session.startedAt}>{startTime}</time>
                      <span aria-hidden="true"> – </span>
                      <span className="sr-only"> to </span>
                      <time dateTime={session.endedAt}>{endTime}</time>
                      {daysLater > 0 && (
                        <span
                          className="ml-1 text-[9px] text-mut/75"
                          title={daysLater === 1 ? "Ends the next day" : `Ends ${daysLater} days later`}
                        >
                          (+{daysLater} {daysLater === 1 ? "day" : "days"})
                        </span>
                      )}
                    </span>
                  </span>
                  <span
                    className="text-right text-[11.5px] font-semibold tabular-nums text-txt"
                    aria-label={`${session.wins} wins, ${session.losses} losses`}
                  >
                    {session.wins}W {session.losses}L
                  </span>
                  <span className="text-right text-[11.5px]">
                    <LpDelta delta={session.lpDelta} />
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
