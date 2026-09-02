import type { Metadata } from "next";
import { collectStatus } from "@/lib/status/collect";
import type { StatusCheck, Verdict } from "@/lib/status/verdicts";

// /status — a plain server-rendered page, no client JS of its own. Reads the
// same `collectStatus()` the JSON route does (one in-process cache, one set of
// verdicts), so the page and /api/status can never disagree. Inside AppShell
// like every other route, so the nav and the footer version are the ones the
// rest of the app shows.
//
// Dynamic on purpose: the facts are about NOW. The collection underneath is
// cached for 60 s per warm instance, which is what bounds the load; see
// lib/status/collect.ts.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status — CoachBuild",
  description: "Live health of the data behind CoachBuild: build patch, consensus artifact, database, ingests.",
  robots: { index: false },
};

const VERDICT_STYLE: Record<Verdict, { dot: string; text: string; label: string }> = {
  pass: { dot: "bg-good", text: "text-good", label: "pass" },
  warn: { dot: "bg-accent-400", text: "text-accent-400", label: "warn" },
  fail: { dot: "bg-bad", text: "text-bad", label: "fail" },
};

const OVERALL_COPY: Record<Verdict, string> = {
  pass: "All checks passing",
  warn: "Worth a look",
  fail: "Something users can see is broken",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function CheckRow({ check }: { check: StatusCheck }) {
  const style = VERDICT_STYLE[check.verdict];
  return (
    <li className="flex gap-3 py-3 border-b border-line last:border-b-0">
      <span className={`mt-[6px] h-2.5 w-2.5 flex-shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-[13px] font-semibold text-txt">{check.label}</p>
          <p className={`text-[10px] tracking-[0.13em] uppercase font-semibold ${style.text}`}>{style.label}</p>
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-mut break-words">{check.detail}</p>
        {check.at && <p className="mt-0.5 text-[11px] text-mut/70 tabular-nums">{fmtTime(check.at)}</p>}
      </div>
    </li>
  );
}

export default async function StatusPage() {
  const report = await collectStatus();
  const overall = VERDICT_STYLE[report.overall];
  return (
    <div className="mx-auto w-full max-w-[720px] px-4 sm:px-6">
      <header className="pt-8 pb-5 border-b border-line mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap min-w-0">
          <h1 className="text-[22px] sm:text-2xl font-extrabold tracking-[-0.02em] text-txt whitespace-nowrap">Status</h1>
          <p className="text-mut text-[13px] min-w-0">The data behind every page, checked now.</p>
        </div>
        <div className="flex-shrink-0 text-[11px] text-mut tracking-[0.06em] uppercase">
          web {report.version ?? "unknown"}
        </div>
      </header>

      <section className="rounded-[9px] bg-panel-glass px-4 py-3 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 flex-shrink-0 rounded-full ${overall.dot}`} aria-hidden="true" />
          <p className={`text-[14px] font-semibold ${overall.text}`}>{OVERALL_COPY[report.overall]}</p>
        </div>
        <p className="mt-1 text-[11px] text-mut tabular-nums">
          collected {fmtTime(report.generatedAt)} · refreshed at most once a minute ·{" "}
          <a href="/api/status" className="underline decoration-line underline-offset-2 hover:text-txt">
            JSON
          </a>
        </p>
      </section>

      <ul className="mt-4 rounded-[9px] bg-panel-glass px-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
        {report.checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>

      <p className="mt-4 mb-8 text-[11px] leading-relaxed text-mut/80">
        A consensus artifact one patch behind the live patch is expected for the hours between a Riot
        patch and the next daily re-bake, and is reported as a pass with that reason. Fail means a
        surface users see is empty or wrong right now.
      </p>
    </div>
  );
}
