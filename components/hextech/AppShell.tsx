"use client";

// Global nav shell (v0.50.0, global-nav-plan.md Decision 1). Wraps every
// route (app/layout.tsx, inside CompanionProvider so the rail's companion
// card can read useCompanion()) in ONE branded left rail (desktop) + bottom
// tab bar (mobile), replacing the old per-page TabNav + Builds-only hextech
// Sidebar + MobileNavMenu trio.
import { Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Minus, Square, X } from "@phosphor-icons/react";
import DesktopRail from "./GlobalNav/DesktopRail";
import MobileTabBar from "./GlobalNav/MobileTabBar";
import TopBar from "./GlobalNav/TopBar";

/** Routes that render WITHOUT the nav shell. /compact is a deliberately
 *  chrome-free mini view: a browser user can pop it out onto a second monitor,
 *  and the desktop shell loads this same route in its always-on-top champ-select
 *  overlay. It is a normal web route either way — nothing here is desktop-only,
 *  and nothing about the shell leaks into the app. */
const CHROMELESS_ROUTES = new Set(["/compact"]);

function TitleBar({ patch }: { patch: string | null }) {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;

  return (
    <header className="hidden h-[34px] flex-shrink-0 items-center justify-between border-b border-[rgba(233,233,237,0.06)] bg-sidebar px-3 lg:flex">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 rounded-[3px]"
          style={{ background: "linear-gradient(140deg, var(--color-accent), var(--color-accent-700))" }}
        />
        <span className="text-[11px] font-medium text-txt/[0.72]">CoachBuild</span>
        <span className="text-[10px] text-txt/[0.32]">
          Patch {patch ?? "—"} · {version ? `v${version}` : "v—"}
        </span>
      </div>
      <div className="flex h-full items-stretch" aria-hidden="true">
        <span className="flex w-11 items-center justify-center text-txt/35">
          <Minus size={14} weight="light" />
        </span>
        <span className="flex w-11 items-center justify-center text-txt/35">
          <Square size={12} weight="light" />
        </span>
        <span className="flex w-11 items-center justify-center text-txt/50 transition-colors duration-[120ms] ease-in hover:bg-[#9c3b3b] hover:text-txt">
          <X size={14} weight="light" />
        </span>
      </div>
    </header>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // R7: best-effort GET /api/patch, once. A failure (or a slow cold start)
  // must never crash the shell or block first paint — null just renders
  // "PATCH —" in the rail footer.
  const [patch, setPatch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/patch")
      .then((r) => (r.ok ? (r.json() as Promise<{ patch?: string }>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.patch) setPatch(data.patch);
      })
      .catch(() => {
        /* network hiccup — rail footer stays on "—" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hooks above run unconditionally — the early return is placed after them
  // so the rules of hooks hold on every route.
  if (pathname != null && CHROMELESS_ROUTES.has(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-bg text-txt">
      <TitleBar patch={patch} />
      <div className="flex min-h-screen lg:h-[calc(100vh-34px)] lg:min-h-0">
        <Suspense fallback={null}><DesktopRail /></Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">{children}</main>
        </div>
        <Suspense fallback={null}><MobileTabBar /></Suspense>
      </div>
    </div>
  );
}
