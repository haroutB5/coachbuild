"use client";

import type { ReactNode } from "react";
import { ShieldCheck } from "@phosphor-icons/react";

interface SwitchRowProps {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description: ReactNode;
}

function SwitchRow({ id, checked, onChange, title, description }: SwitchRowProps) {
  return (
    <div className="flex items-start gap-3.5 border-t border-txt/[0.06] pt-4 first:border-t-0 first:pt-0">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms] ease-in focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:h-[22px] lg:w-[38px]"
      >
        <span
          className={`absolute h-[22px] w-[38px] rounded-full transition-colors duration-[120ms] ease-in lg:inset-0 ${
            checked ? "bg-accent" : "border border-txt/[0.14] bg-txt/[0.06]"
          }`}
          aria-hidden="true"
        />
        <span
          className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg shadow-sm transition-transform duration-[120ms] ease-in motion-reduce:transition-none lg:top-[3px] lg:translate-x-0 lg:translate-y-0 ${
            checked ? "left-[calc(50%+10px)] lg:left-auto lg:right-[3px]" : "left-[calc(50%-10px)] lg:left-[3px]"
          }`}
          aria-hidden="true"
        />
      </button>
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold text-txt">{title}</p>
        <p className="mt-0.5 max-w-[66ch] text-[11px] leading-relaxed text-mut">{description}</p>
      </div>
    </div>
  );
}

export interface AutomationTogglesProps {
  autoItemSets: boolean;
  autoRunes: boolean;
  hydrated: boolean;
  onToggleItemSets: (next: boolean) => void;
  onToggleRunes: (next: boolean) => void;
}

export default function AutomationToggles({
  autoItemSets,
  autoRunes,
  hydrated,
  onToggleItemSets,
  onToggleRunes,
}: AutomationTogglesProps) {
  return (
    <section className="space-y-4 rounded-[9px] bg-panel-glass p-5 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:p-6">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-txt/[0.48]">Automation</p>

      <SwitchRow
        id="auto-item-sets-toggle"
        checked={hydrated && autoItemSets}
        onChange={onToggleItemSets}
        title="Auto-add item builds on champ select"
        description={
          <>
            One item set for your champion and role appears in the in-client shop, holding four build lines side by side — WPA build, Pro build, OTP build and Hidden gem — plus your starting items.
          </>
        }
      />

      <SwitchRow
        id="auto-runes-toggle"
        checked={hydrated && autoRunes}
        onChange={onToggleRunes}
        title="Auto-apply runes on champ select"
        description={<>Applies the recommended page using CoachBuild&apos;s own slot — your personal rune pages are never touched.</>}
      />

      <div className="flex items-start gap-2 border-t border-txt/[0.06] pt-4 text-[11px] leading-relaxed text-mut">
        <ShieldCheck size={14} weight="regular" className="mt-0.5 shrink-0 text-accent-400" aria-hidden="true" />
        <p>Rune and item writes go to CoachBuild&apos;s own page and set — your personal pages are never touched or deleted.</p>
      </div>
    </section>
  );
}
