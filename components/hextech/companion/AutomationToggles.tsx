"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AutomationToggles — /live-setup's "AUTOMATION" section (mockup 2.png): two
// real SWITCH controls (role="switch", not styled checkboxes) wired to the
// SAME state/handlers the pre-redesign page's `<input type="checkbox">` pair
// used (getAutoItemSetsEnabled/setAutoItemSetsEnabled,
// getAutoRunesEnabled/setAutoRunesEnabled in companionClient.ts) — this
// component owns no storage logic itself, only the toggle UI.
// ─────────────────────────────────────────────────────────────────────────────

interface SwitchRowProps {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description: React.ReactNode;
}

function SwitchRow({ id, checked, onChange, title, description }: SwitchRowProps) {
  return (
    <div className="flex items-start gap-3.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 flex-shrink-0 w-10 h-[22px] rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${
          checked ? "bg-teal" : "bg-panel2 border border-line"
        }`}
      >
        <span
          className={`absolute top-[3px] w-4 h-4 rounded-full bg-bg shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-[21px]" : "translate-x-[3px]"
          }`}
          aria-hidden="true"
        />
      </button>
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="block text-[12.5px] text-txt font-semibold">{title}</span>
        <span className="block text-[11px] text-mut leading-relaxed mt-0.5 max-w-[62ch]">{description}</span>
      </label>
    </div>
  );
}

export interface AutomationTogglesProps {
  autoItemSets: boolean;
  autoRunes: boolean;
  /** Hydrated-after-mount gate (localStorage read) so SSR/first-paint never
   *  shows a stale/mismatched toggle state — same posture the pre-redesign
   *  page already used for its checkboxes. */
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
    <section className="bg-panel border border-line rounded-xl p-5 sm:p-6 space-y-5">
      <p className="text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">Automation</p>

      <SwitchRow
        id="auto-item-sets-toggle"
        checked={hydrated && autoItemSets}
        onChange={onToggleItemSets}
        title="Auto-add item builds on champ select"
        description={
          <>
            Up to 3 item sets (Core, Optimized, Pro) appear in your in-client shop — a passive
            suggestion, same as Blitz/u.gg import.
          </>
        }
      />

      <SwitchRow
        id="auto-runes-toggle"
        checked={hydrated && autoRunes}
        onChange={onToggleRunes}
        title="Auto-apply runes on champ select"
        description={
          <>
            Applies the recommended page using CoachBuild&apos;s own slot — your personal rune pages
            are never touched.
          </>
        }
      />

      <div className="flex items-start gap-2 text-[11px] text-mut leading-relaxed pt-1 border-t border-line/50">
        <span className="text-good flex-shrink-0" aria-hidden="true">
          🛡
        </span>
        <p>
          Only reads champion picks, roles and item builds — never summoner names, cooldowns, or
          ability timers. Never acts in-game for you.
        </p>
      </div>
    </section>
  );
}
