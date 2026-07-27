// ─────────────────────────────────────────────────────────────────────────────
// OverlayDownload — /live-setup's "CoachBuild Overlay" section. A SECOND,
// independent desktop app (Electron, not the PowerShell companion above): it
// draws a highlight over the player's real Q/W/E/R ability icons in-game,
// marking which ability to level next, by reading League's local Live Client
// Data API (127.0.0.1:2999) directly. It does not require companion.ps1 to be
// running, and companion.ps1 does not require it — they solve different
// problems (champ-select automation vs. an in-game skill-order prompt) and
// this section exists specifically so a user does not mistake one for a
// replacement of the other.
//
// No server component needed — this is a static link + copy, so it's a plain
// (non-"use client") module; the page around it happens to be a client
// component but that's incidental.
//
// Download target: the overlay's own GitHub Releases "latest" page, not a
// hardcoded versioned .exe — the installer filename changes every release
// and a hardcoded link would rot on the very next version bump. No version
// number is shown here for the same reason (repo hard rule: never present an
// unmeasured/unfetched value as fact — see CLAUDE.md "No fabricated data").
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";

const OVERLAY_RELEASES_URL = "https://github.com/haroutB5/coachbuild-overlay-releases/releases/latest";

const FACTS: { key: string; body: ReactNode }[] = [
  {
    key: "smartscreen",
    body: (
      <>
        <strong className="text-txt font-semibold">Windows only.</strong> The installer is
        unsigned, so Windows SmartScreen will warn on first run — click{" "}
        <strong className="text-txt">More info</strong> &rarr;{" "}
        <strong className="text-txt">Run anyway</strong>. That warning is expected, not a sign
        anything is wrong.
      </>
    ),
  },
  {
    key: "same-pc",
    body: (
      <>
        Install it on the <strong className="text-txt">same PC that runs League</strong> — it
        reads a localhost-only API, so nothing about it works over a network or a second machine.
      </>
    ),
  },
  {
    key: "auto-update",
    body: <>Updates itself automatically after the first install — no need to redownload.</>,
  },
  {
    key: "display-mode",
    body: (
      <>
        League&apos;s display mode must be <strong className="text-txt">Borderless</strong> or{" "}
        <strong className="text-txt">Windowed</strong> — an always-on-top overlay can&apos;t draw
        over exclusive Fullscreen.
      </>
    ),
  },
];

export default function OverlayDownload() {
  return (
    <section className="bg-panel border border-line rounded-xl p-5 sm:p-6 space-y-5">
      <div className="space-y-1.5">
        <p className="text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">
          CoachBuild Overlay — a separate app
        </p>
        <p className="text-[12px] text-mut leading-relaxed max-w-[60ch]">
          Highlights your Q/W/E/R ability icons in-game so you always know which one to level
          next. It&apos;s independent of the companion above — you can install one, both, or
          neither.
        </p>
      </div>

      <a
        href={OVERLAY_RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover rounded-lg px-4 py-2.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        Download for Windows
        <span aria-hidden="true">&#8599;</span>
      </a>

      <ul className="space-y-2 text-[11px] text-mut leading-relaxed">
        {FACTS.map((fact) => (
          <li key={fact.key} className="flex gap-2">
            <span className="text-teal flex-shrink-0" aria-hidden="true">
              &bull;
            </span>
            <span>{fact.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
