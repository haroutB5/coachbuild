"use client";

import { useState } from "react";
import { CopySimple, DownloadSimple } from "@phosphor-icons/react";

export const DESKTOP_APP_DOWNLOAD_URL =
  "https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download/CoachBuild.Desktop-win-Setup.exe";

const LEGACY_INSTALL_ONE_LINER = "irm https://coachbuild.vercel.app/companion.ps1 | iex";
const LEGACY_INSTALL_PERSISTENT =
  '& ([scriptblock]::Create((irm https://coachbuild.vercel.app/companion.ps1))) -Install';

function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* The code field remains selectable when clipboard access is unavailable. */
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-mut">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-[8px] bg-[#12141f] px-3 py-2.5 font-mono text-[11px] text-accent-300 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-[8px] px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-400 shadow-[inset_0_0_0_1px_#9184d9] transition-colors duration-[120ms] ease-in hover:bg-accent/[0.14] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
        >
          <CopySimple size={13} weight="regular" aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function InstallCommands() {
  return (
    <section className="space-y-5 rounded-[9px] bg-panel-glass p-5 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:p-6">
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-txt/[0.48]">Install</p>
        <p className="max-w-[70ch] text-[12px] leading-relaxed text-mut">
          The native desktop companion is the recommended path. Setup.exe keeps the bridge on this PC and adds no browser or PowerShell dependency.
        </p>
      </div>

      <a
        href={DESKTOP_APP_DOWNLOAD_URL}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-[8px] px-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-400 shadow-[inset_0_0_0_1px_#9184d9] transition-colors duration-[120ms] ease-in hover:bg-accent/[0.14] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
      >
        <DownloadSimple size={14} weight="regular" aria-hidden="true" />
        Download for Windows
      </a>

      <div className="space-y-4 border-t border-txt/[0.06] pt-4">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-txt/[0.40]">Legacy / fallback PowerShell</p>
        <CopyableCommand label="Run now · this session" command={LEGACY_INSTALL_ONE_LINER} />
        <CopyableCommand label="Run now · auto-start on login" command={LEGACY_INSTALL_PERSISTENT} />
        <p className="text-[11px] leading-relaxed text-mut">
          Paste into PowerShell (Win+X → Terminal). These older commands run in memory; the auto-start variant only adds a Startup shortcut and needs no admin rights.
        </p>
      </div>
    </section>
  );
}
