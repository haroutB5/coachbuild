"use client";

// Mobile bottom tab bar (v0.50.0, plan Decision 4). Replaces the old
// MobileNavMenu "More" disclosure + the collapsed hextech Sidebar's own lane
// row on mobile — 4 fixed destinations (Builds/Pro Players/Patch Movers/My
// Stats), per the user's explicit directive: NO Companion, NO Draft, NO
// companion card on mobile (desktop-play-only). `grid grid-cols-4`, never
// overflow-x (R3) — this is a small, fixed item count, not a scrollable list.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MOBILE_NAV_ITEMS } from "./navItems";
import { isActiveNav } from "./activeNav";
import NavIcon from "./NavIcon";

export default function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-4 bg-sidebar border-t border-line"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const active = isActiveNav(pathname, item.href);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-1 min-h-[56px] text-[10px] font-semibold uppercase tracking-[0.03em] transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-inset ${
              active ? "text-teal" : "text-mut"
            }`}
          >
            <NavIcon iconKey={item.iconKey} className="w-[18px] h-[18px]" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
