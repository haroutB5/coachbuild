"use client";

// Branded left rail (v0.50.0, global-nav-plan.md Decision 1/4). Desktop-only
// chrome (`hidden lg:flex`) — mobile gets MobileTabBar instead. Rendered by
// AppShell.tsx above every route's own content; stays Hextech GOLD on every
// route including /draft (v0.51.0 retired /draft's separate cyan
// `.draft-tactical` HUD theme entirely — the whole app is one gold palette
// now, so this was never a real risk to begin with, just historically true).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, type NavItem } from "./navItems";
import { isActiveNav } from "./activeNav";
import NavIcon from "./NavIcon";
import CompanionStatusCard from "./CompanionStatusCard";
import { useCompanion } from "@/components/live/CompanionProvider";
import { buildsPickBadge } from "./navBadgeModel";

interface DesktopRailProps {
  /** e.g. "16.13" — fed by AppShell's own best-effort GET /api/patch fetch.
   *  null renders "PATCH —" rather than a guessed value (R7). */
  patch: string | null;
}

function NavGroup({
  label,
  items,
  pathname,
  showPickBadge,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  /** v0.51.0 — gold "PICK" pill on the Builds item while a live champ select
   *  is in progress (navBadgeModel.buildsPickBadge, engo's pinned contract).
   *  Rendered on every route (this rail is mounted app-wide by AppShell), not
   *  just while the user happens to be on "/". */
  showPickBadge: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-2.5">{label}</p>
      <nav aria-label={label} className="flex flex-col gap-1">
        {items.map((item) => {
          const active = isActiveNav(pathname, item.href);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar ${
                active
                  ? "bg-panel2 border border-line-gold text-txt shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
                  : "border border-transparent text-mut hover:bg-panel2/60 hover:text-txt"
              }`}
            >
              <NavIcon iconKey={item.iconKey} className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.id === "builds" && showPickBadge && (
                <span
                  aria-label="Champion locked in champ select"
                  className="flex-shrink-0 text-[9px] font-bold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded bg-teal text-bg"
                >
                  Pick
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export default function DesktopRail({ patch }: DesktopRailProps) {
  const pathname = usePathname();
  const companion = useCompanion();
  const showPickBadge = companion.statusFresh && buildsPickBadge(companion.phase);
  const playItems = NAV_ITEMS.filter((item) => item.group === "play");
  const dataItems = NAV_ITEMS.filter((item) => item.group === "data");

  return (
    // sticky + h-screen (not min-h-screen) — the flex row (AppShell) stretches
    // this aside to match <main>'s full scrollable height on any content-
    // heavy page (BUILD tab, Pro Players, etc.), which pushed the mt-auto
    // companion card + PATCH footer far below the fold, effectively
    // unreachable without scrolling to the literal bottom of the page
    // (caught via screenshot at 1280x900 — the rail rendered logo/PLAY/DATA
    // correctly but the card+footer were nowhere in the viewport). `sticky
    // top-0 h-screen overflow-y-auto` pins the rail to the viewport instead,
    // independent of main's height; overflow-y-auto is a defensive guard in
    // case the rail's OWN content (unlikely) ever exceeds one viewport.
    <aside className="hidden lg:flex lg:flex-col w-[232px] flex-shrink-0 bg-sidebar border-r border-line sticky top-0 h-screen overflow-y-auto px-4 py-5">
      <Link href="/" className="flex items-center gap-2.5 px-0.5 mb-6">
        <span className="flex-shrink-0 w-8 h-8 rounded-md bg-teal/12 border border-line-gold flex items-center justify-center">
          <NavIcon iconKey="cb-tile" className="w-[18px] h-[18px] text-teal" />
        </span>
        <span className="min-w-0">
          <span
            className="block font-display text-[15px] font-semibold tracking-[0.1em] text-teal uppercase leading-tight"
            style={{ textShadow: "0 0 18px rgba(200,170,110,0.25)" }}
          >
            Coachbuild
          </span>
          <span className="block text-[9px] tracking-[0.14em] uppercase text-mut font-semibold leading-tight mt-0.5">
            WPA Intelligence
          </span>
        </span>
      </Link>

      <NavGroup label="Play" items={playItems} pathname={pathname} showPickBadge={showPickBadge} />
      <div className="mt-5">
        <NavGroup label="Data" items={dataItems} pathname={pathname} showPickBadge={false} />
      </div>

      <div className="mt-auto pt-5 space-y-3">
        <CompanionStatusCard />
        <div className="flex items-center justify-between text-[10.5px] text-mut tabular-nums pt-3 border-t border-line">
          <span>PATCH {patch ?? "—"}</span>
          {process.env.NEXT_PUBLIC_APP_VERSION && <span>v{process.env.NEXT_PUBLIC_APP_VERSION}</span>}
        </div>
      </div>
    </aside>
  );
}
