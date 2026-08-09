"use client";

import { useEffect, useState } from "react";
import { getAutoItemSetsEnabled, getAutoRunesEnabled, setAutoItemSetsEnabled, setAutoRunesEnabled } from "@/components/live/companionClient";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms] ease-in focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:h-[22px] lg:w-10"
    >
      <span
        className="absolute left-1/2 top-1/2 h-[22px] w-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-[120ms] ease-in lg:inset-0 lg:hidden lg:translate-x-0 lg:translate-y-0"
        style={{ background: checked ? "#9184d9" : "rgba(233,233,237,.12)" }}
        aria-hidden="true"
      />
      <span
        className={`absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg transition-transform duration-[120ms] ease-in motion-reduce:transition-none lg:hidden ${
          checked
            ? "ml-[10px]"
            : "-ml-[10px]"
        }`}
        aria-hidden="true"
      />
      <span
        className="absolute inset-0 hidden rounded-full transition-colors duration-[120ms] ease-in lg:block"
        style={{ background: checked ? "#9184d9" : "rgba(233,233,237,.12)" }}
        aria-hidden="true"
      />
      <span
        className="absolute top-[3px] hidden h-4 w-4 rounded-full bg-bg transition-transform duration-[120ms] ease-in motion-reduce:transition-none lg:inline"
        style={{ transform: checked ? "translateX(21px)" : "translateX(3px)" }}
        aria-hidden="true"
      />
    </button>
  );
}

export default function DraftLockInCard() {
  const [autoItemSets, setAutoItemSets] = useState(false);
  const [autoRunes, setAutoRunes] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration mirrors Companion setup's existing control state.
    setAutoItemSets(getAutoItemSetsEnabled());
    setAutoRunes(getAutoRunesEnabled());
    setHydrated(true);
  }, []);

  function toggleItemSets() {
    setAutoItemSets((current) => {
      const next = !current;
      setAutoItemSetsEnabled(next);
      return next;
    });
  }

  function toggleRunes() {
    setAutoRunes((current) => {
      const next = !current;
      setAutoRunesEnabled(next);
      return next;
    });
  }

  const itemSetsChecked = hydrated && autoItemSets;
  const runesChecked = hydrated && autoRunes;

  return (
    <section
      className="rounded-[9px] p-3.5"
      style={{ background: "linear-gradient(150deg, rgba(145,132,217,.14), rgba(35,37,50,.75))", boxShadow: "inset 0 0 0 1px rgba(145,132,217,.22)" }}
      aria-labelledby="on-lock-in-heading"
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-accent-400" aria-hidden="true">ϟ</span>
        <h2 id="on-lock-in-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-300">On lock-in</h2>
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.45] text-txt/[0.58]">Runes and the full item set are pushed to your client the moment you lock. Nothing is overwritten.</p>

      <div className="mt-4 space-y-3 fading-rule pt-3" style={{ background: "linear-gradient(to right, transparent, rgba(233,233,237,.14) 18%, rgba(233,233,237,.14) 82%, transparent)", backgroundSize: "100% 1px", backgroundRepeat: "no-repeat", backgroundPosition: "top" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-txt">Auto-add item builds</p>
            <p className="mt-0.5 text-[10px] leading-[1.35] text-txt/[0.42]">Stage the recommended shop set in-client.</p>
          </div>
          <Toggle checked={itemSetsChecked} onChange={toggleItemSets} label="Auto-add item builds on champ select" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-txt">Auto-apply runes</p>
            <p className="mt-0.5 text-[10px] leading-[1.35] text-txt/[0.42]">Apply the CoachBuild rune page on lock.</p>
          </div>
          <Toggle checked={runesChecked} onChange={toggleRunes} label="Auto-apply runes on champ select" />
        </div>
      </div>
    </section>
  );
}
