"use client";

// Mobile bottom tab bar. It retains the existing four fixed destinations
// (Builds/Pro Players/Patch Movers/My Stats); Draft, Post-Game, and Companion
// remain desktop-only shell surfaces.
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
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[rgba(233,233,237,0.08)] bg-sidebar lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const active = isActiveNav(pathname, item.href);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-[56px] flex-col items-center justify-center gap-1 text-[10px] font-medium uppercase tracking-[0.03em] transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] ${
              active ? "text-accent-400" : "text-txt/50"
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
