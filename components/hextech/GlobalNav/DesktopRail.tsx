"use client";

// Nocturne desktop rail. Mobile gets MobileTabBar instead. The rail is the
// one navigation surface that owns the companion status card; all state shown
// there comes from the app-wide CompanionProvider poll.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { NAV_ITEMS, type NavItem } from "./navItems";
import { isActiveNav } from "./activeNav";
import NavIcon from "./NavIcon";
import CompanionStatusCard from "./CompanionStatusCard";

function NavGroup({
  label,
  items,
  pathname,
  search,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  search: string;
}) {
  return (
    <div>
      <p className="mb-2 px-2 text-[9px] font-medium uppercase tracking-[0.16em] text-txt/[0.30]">{label}</p>
      <nav aria-label={label} className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = isActiveNav(pathname, item.href, search);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] font-medium transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                active
                  ? "bg-teal/[0.14] text-txt"
                  : "text-txt/60 hover:bg-txt/[0.05] hover:text-txt"
              }`}
            >
              {active && <span aria-hidden="true" className="absolute left-0 top-[9px] bottom-[9px] w-0.5 rounded-full bg-accent" />}
              <NavIcon iconKey={item.iconKey} className="h-[15px] w-[15px] flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export default function DesktopRail() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const playItems = NAV_ITEMS.filter((item) => item.group === "play");
  const dataItems = NAV_ITEMS.filter((item) => item.group === "data");
  const setupItems = NAV_ITEMS.filter((item) => item.group === "setup");

  return (
    <aside className="hidden lg:flex lg:w-[216px] lg:flex-shrink-0 lg:flex-col overflow-y-auto border-r border-[rgba(233,233,237,0.08)] bg-sidebar px-3 pb-3 pt-4">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-1">
        <span
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: "radial-gradient(120% 120% at 30% 20%, var(--color-accent-700), var(--color-accent-900))",
            boxShadow: "inset 0 0 0 1px rgba(145,132,217,.4), 0 0 18px rgba(145,132,217,.22)",
          }}
        >
          <NavIcon iconKey="cb-tile" className="h-[17px] w-[17px] text-accent-300" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold leading-tight text-txt">CoachBuild</span>
          <span className="mt-0.5 block text-[9px] font-medium uppercase leading-tight tracking-[0.14em] text-txt/[0.38]">
            WPA Intelligence
          </span>
        </span>
      </Link>

      <NavGroup label="Play" items={playItems} pathname={pathname} search={search} />
      <div className="mt-5">
        <NavGroup label="Data" items={dataItems} pathname={pathname} search={search} />
      </div>
      <div className="mt-5">
        <NavGroup label="Setup" items={setupItems} pathname={pathname} search={search} />
      </div>

      <div className="mt-auto pt-5">
        <CompanionStatusCard />
      </div>
    </aside>
  );
}
