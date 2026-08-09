import { DownloadSimple } from "@phosphor-icons/react";
import CompanionOverlayWidget, { REAL_OVERLAY_COLORS } from "./CompanionOverlayWidget";

const DESKTOP_APP_DOWNLOAD_URL =
  "https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download/CoachBuild.Desktop-win-Setup.exe";

const COMPLIANCE_LINE =
  "Reads only your own champion, level and ability ranks from the live game API. Nothing about enemies, no cooldowns, no input.";

interface StateSampleProps {
  ability: "W" | "R" | null;
  title: string;
  description: string;
  refusal?: boolean;
}

function StateSample({ ability, title, description, refusal = false }: StateSampleProps) {
  return (
    <li className="flex items-start gap-3 border-t border-txt/[0.07] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <span
        className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[10px] text-[25px] font-semibold leading-none ${
          refusal
            ? "border border-txt/[0.14] bg-txt/[0.04] text-txt/[0.50]"
            : "border text-white"
        }`}
        style={
          refusal
            ? undefined
            : {
                backgroundColor: REAL_OVERLAY_COLORS.pinkFill,
                borderColor: REAL_OVERLAY_COLORS.pink,
                color: REAL_OVERLAY_COLORS.pink,
              }
        }
        aria-hidden="true"
      >
        {refusal ? "—" : ability}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-txt">{title}</p>
        <p className="mt-1 max-w-[58ch] text-[12px] leading-relaxed text-mut">{description}</p>
      </div>
    </li>
  );
}

export default function OverlayDownload() {
  return (
    <section className="space-y-5 rounded-[9px] bg-panel-glass p-5 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:p-6">
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-txt/[0.48]">In-game overlay</p>
        <p className="max-w-[72ch] text-[12px] leading-relaxed text-mut">
          A small second-monitor surface that names the next ability to level. It never becomes an in-app live game screen.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(250px,0.72fr)_minmax(0,1fr)] lg:gap-8">
        <div className="space-y-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-txt/[0.40]">Shown at real size, over your game</p>
          <div
            className="flex min-h-[218px] items-center justify-center rounded-[10px] p-4"
            style={{ background: "radial-gradient(120% 140% at 20% 0%, #1d2530, #0f1319 70%)" }}
          >
            <CompanionOverlayWidget
              championName="Galio"
              level={11}
              state="next"
              ability="W"
              abilityName="Shield of Durand"
              fromRank={3}
              toRank={4}
              liveSignal={false}
            />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-txt/[0.40]">Every state it can be in</p>
          <ul>
            <StateSample
              ability="W"
              title="Next ability"
              description="The normal state — ability, name and the rank transition it is about to make."
            />
            <StateSample
              ability="R"
              title="Ultimate available"
              description="Takes priority the moment the game will legally allow the rank — seven champions publish R at 12, so the level gate is checked, not assumed."
            />
            <StateSample
              ability={null}
              refusal
              title="Refuses past level 15"
              description="The source publishes 1–15. Past that the overlay shows a dash rather than a guess — the same refusal the Builds skill grid makes."
            />
          </ul>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-txt/[0.07] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <a
          href={DESKTOP_APP_DOWNLOAD_URL}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 self-start rounded-[8px] px-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-400 shadow-[inset_0_0_0_1px_#9184d9] transition-colors duration-[120ms] ease-in hover:bg-accent/[0.14] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
        >
          <DownloadSimple size={14} weight="regular" aria-hidden="true" />
          Download for Windows
        </a>
        <p className="max-w-[64ch] text-[11px] leading-relaxed text-mut sm:text-right">{COMPLIANCE_LINE}</p>
      </div>
    </section>
  );
}
