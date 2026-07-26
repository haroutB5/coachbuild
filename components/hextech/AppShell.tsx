"use client";

// Global nav shell (v0.50.0, global-nav-plan.md Decision 1). Wraps every
// route (app/layout.tsx, inside CompanionProvider so the rail's companion
// card can read useCompanion()) in ONE branded left rail (desktop) + bottom
// tab bar (mobile), replacing the old per-page TabNav + Builds-only hextech
// Sidebar + MobileNavMenu trio.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import DesktopRail from "./GlobalNav/DesktopRail";
import MobileTabBar from "./GlobalNav/MobileTabBar";
import TopBar from "./GlobalNav/TopBar";

/** Routes that render WITHOUT the nav shell. /compact is a deliberately
 *  chrome-free mini view: a browser user can pop it out onto a second monitor,
 *  and the desktop shell loads this same route in its always-on-top champ-select
 *  overlay. It is a normal web route either way — nothing here is desktop-only,
 *  and nothing about the shell leaks into the app. */
const CHROMELESS_ROUTES = new Set(["/compact"]);

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
    <div className="lg:flex min-h-screen">
      <DesktopRail patch={patch} />
      {/* v0.51.0 (global top bar): TopBar is chrome on EVERY route — mounted
          above <main>'s own content, inside the flex-1 column so it never
          overlaps DesktopRail's fixed-width column. Sticky to the viewport
          top of this scroll container; z-30 keeps it under any modal/sheet
          overlay (GameDetailSheet's backdrop is z-[100]) but above normal
          page content. Never changes which routes are follow-capable — it's
          pure chrome, the champion-search emit is consumed opportunistically
          by whichever page is mounted (today, only "/"). */}
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <main className="flex-1 min-w-0 pb-16 lg:pb-0">{children}</main>
      </div>
      <MobileTabBar />
    </div>
  );
}
