"use client";

import { CopySimple } from "@phosphor-icons/react";
import { useState } from "react";
import { getAccountSecret } from "@/components/live/mystatsAccount";

export type PairDesktopState =
  | { status: "hidden" }
  | { status: "revealed"; secret: string }
  | { status: "missing" };

type CopyState = "idle" | "copied" | "failed";

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export function pairDesktopStateAfterReveal(secret: string | null): PairDesktopState {
  const value = secret?.trim() ?? "";
  return value.length > 0 ? { status: "revealed", secret: value } : { status: "missing" };
}

export async function copyPairDesktopSecret(
  secret: string,
  writer: ClipboardWriter | null =
    typeof navigator === "undefined" ? null : navigator.clipboard
): Promise<boolean> {
  if (!writer) return false;
  try {
    await writer.writeText(secret);
    return true;
  } catch {
    return false;
  }
}

interface PairDesktopControlViewProps {
  state: PairDesktopState;
  copyState: CopyState;
  onReveal: () => void;
  onHide: () => void;
  onCopy: () => void;
}

/** Exported separately so the repo's node-only Vitest setup can verify each
 * credential state without adding a DOM test dependency. */
export function PairDesktopControlView({
  state,
  copyState,
  onReveal,
  onHide,
  onCopy,
}: PairDesktopControlViewProps) {
  return (
    <section
      aria-labelledby="pair-desktop-title"
      className="mt-5 rounded-[9px] bg-panel-glass px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:px-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p
            id="pair-desktop-title"
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mut"
          >
            Desktop LP capture
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-mut">
            Pair the CoachBuild desktop app to record LP changes for your sessions.
          </p>
        </div>

        {state.status === "hidden" && (
          <button
            type="button"
            onClick={onReveal}
            className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-[8px] px-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-teal shadow-[inset_0_0_0_1px_rgba(145,132,217,.7)] transition-colors duration-[120ms] ease-in hover:bg-teal/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg lg:min-h-0 lg:py-2.5"
          >
            Pair desktop app
          </button>
        )}
      </div>

      {state.status === "revealed" && (
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <p className="text-[11px] leading-relaxed text-mut">
            Paste this secret into the CoachBuild desktop tray&apos;s Settings, then save it.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <input
              type="text"
              readOnly
              value={state.secret}
              aria-label="Desktop pairing secret"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              className="min-h-[44px] min-w-0 flex-1 rounded-[8px] border border-line bg-black/30 px-3 font-mono text-[12px] text-txt selection:bg-teal/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            />
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-teal shadow-[inset_0_0_0_1px_rgba(145,132,217,.7)] transition-colors duration-[120ms] ease-in hover:bg-teal/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <CopySimple size={13} weight="regular" aria-hidden="true" />
              {copyState === "copied" ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onHide}
              className="min-h-[44px] shrink-0 rounded-[8px] px-3 text-[11px] font-medium text-mut transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Hide secret
            </button>
          </div>
          {copyState === "failed" && (
            <p role="status" className="mt-2 text-[10.5px] text-mut">
              Clipboard access is unavailable. Select the secret and copy it manually.
            </p>
          )}
        </div>
      )}

      {state.status === "missing" && (
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <p role="status" className="text-[11px] leading-relaxed text-mut">
            No My Stats account secret is saved in this browser yet. Add it in the account
            control first, then check again.
          </p>
          <button
            type="button"
            onClick={onReveal}
            className="mt-2 min-h-[44px] rounded-[8px] px-3 text-[11px] font-semibold text-teal shadow-[inset_0_0_0_1px_rgba(145,132,217,.7)] transition-colors hover:bg-teal/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg lg:min-h-0 lg:py-2.5"
          >
            Check again
          </button>
        </div>
      )}
    </section>
  );
}

export default function PairDesktopControl() {
  // Deliberately contains no secret on the initial render. localStorage is read
  // only in reveal(), after the user explicitly asks to expose the credential.
  const [state, setState] = useState<PairDesktopState>({ status: "hidden" });
  const [copyState, setCopyState] = useState<CopyState>("idle");

  function reveal(): void {
    setCopyState("idle");
    setState(pairDesktopStateAfterReveal(getAccountSecret()));
  }

  function hide(): void {
    setCopyState("idle");
    setState({ status: "hidden" });
  }

  async function copy(): Promise<void> {
    if (state.status !== "revealed") return;
    setCopyState((await copyPairDesktopSecret(state.secret)) ? "copied" : "failed");
  }

  return (
    <PairDesktopControlView
      state={state}
      copyState={copyState}
      onReveal={reveal}
      onHide={hide}
      onCopy={() => void copy()}
    />
  );
}
