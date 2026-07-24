"use client";

// ─────────────────────────────────────────────────────────────────────────────
// InstallCommands — /live-setup's "INSTALL — ONE LINE, NOTHING WRITTEN TO
// DISK" section (mockup 2.png). Lifted verbatim from the pre-redesign
// app/live-setup/page.tsx (same CopyableCommand behavior + the same two
// command strings) — only the layout/copy changed to match the mockup's
// "RUN NOW (THIS SESSION)" / "RUN NOW + AUTO-START ON LOGIN" row labels.
//
// Command strings are unchanged from the shipped page (verified against the
// live source before this rewrite) — per the companion's documented flag
// contract (live-companion-plan.md §1), the persistent variant uses `-Install`.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

const INSTALL_ONE_LINER = "irm https://coachbuild.vercel.app/companion.ps1 | iex";
const INSTALL_PERSISTENT =
  '& ([scriptblock]::Create((irm https://coachbuild.vercel.app/companion.ps1))) -Install';

function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard API unavailable/denied (insecure context, permission) —
         the code block below is still selectable/copyable by hand. */
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] tracking-[0.1em] uppercase text-mut font-semibold">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-pre bg-black/40 border border-line rounded-lg px-3 py-2.5 text-[12px] text-txt">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="flex-shrink-0 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover rounded-lg px-3.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
        >
          <span aria-hidden="true">⧉</span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function InstallCommands() {
  return (
    <section className="bg-panel border border-line rounded-xl p-5 sm:p-6 space-y-5">
      <p className="text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">
        Install — one line, nothing written to disk
      </p>
      <CopyableCommand label="Run now (this session)" command={INSTALL_ONE_LINER} />
      <CopyableCommand label="Run now + auto-start on login" command={INSTALL_PERSISTENT} />
      <p className="text-[11px] text-mut leading-relaxed">
        Paste into PowerShell (Win+X &rarr; Terminal). Runs in memory; the auto-start variant only
        adds a Startup shortcut — no admin rights.
      </p>
    </section>
  );
}
