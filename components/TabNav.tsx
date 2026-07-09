"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Builds" },
  { href: "/history", label: "Pro History" },
] as const;

export default function TabNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex justify-center gap-1.5 mb-5">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`px-3.5 py-1.5 rounded-lg text-[13px] font-semibold transition-colors border active:scale-95 ${
              active
                ? "bg-teal text-bg border-teal"
                : "bg-panel2 text-mut border-line hover:border-teal-dim hover:text-txt"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
