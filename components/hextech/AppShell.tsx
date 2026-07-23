"use client";

// Global nav shell (v0.50.0, global-nav-plan.md Decision 1). Wraps every
// route (app/layout.tsx, inside CompanionProvider so the rail's companion
// card can read useCompanion()) in ONE branded left rail (desktop) + bottom
// tab bar (mobile), replacing the old per-page TabNav + Builds-only hextech
// Sidebar + MobileNavMenu trio.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import DesktopRail from "./GlobalNav/DesktopRail";
import MobileTabBar from "./GlobalNav/MobileTabBar";

export default function AppShell({ children }: { children: ReactNode }) {
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

  return (
    <div className="lg:flex min-h-screen">
      <DesktopRail patch={patch} />
      <main className="flex-1 min-w-0 pb-16 lg:pb-0">{children}</main>
      <MobileTabBar />
    </div>
  );
}
