// Inline-SVG icon set for the rail/bottom-bar (v0.50.0). Deliberately no icon
// library dependency — 6 small stroke glyphs + the CB brand tile, all
// `currentColor`-driven so a single Tailwind text-color class recolors the
// whole glyph (active/inactive states in DesktopRail/MobileTabBar). Kept as
// one small map rather than 7 separate component files, same "one place to
// scan" rationale as heroContracts.ts's LANE_LABEL. No "use client" needed —
// pure presentational SVG, no hooks/handlers; only ever rendered from
// already-client parents (DesktopRail/MobileTabBar).

type IconKey = "crossed-swords" | "medal" | "broadcast" | "trophy" | "trending-up" | "bar-chart" | "cb-tile";

interface NavIconProps {
  iconKey: string;
  className?: string;
}

const PATHS: Record<IconKey, React.ReactNode> = {
  "crossed-swords": (
    <>
      <path d="M4 4l7 7M4 11l7-7M4 4v3M4 4h3" />
      <path d="M20 4l-7 7M20 11l-7-7M20 4v3M20 4h-3" />
      <path d="M8.5 15.5l-4 4M15.5 15.5l4 4" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="15" r="5" />
      <path d="M9 4l1.7 6.5M15 4l-1.7 6.5" />
      <path d="M9 4H7l2.4 7M15 4h2l-2.4 7" />
      <path d="M12 12.5v5" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7" />
      <path d="M5.5 5.5a9 9 0 000 13M18.5 5.5a9 9 0 010 13" />
    </>
  ),
  trophy: (
    <>
      <path d="M7 4h10v5a5 5 0 01-10 0V4z" />
      <path d="M7 5H4.5A1.5 1.5 0 003 6.5v.5A3.5 3.5 0 006.5 10.5H7M17 5h2.5A1.5 1.5 0 0121 6.5v.5A3.5 3.5 0 0117.5 10.5H17" />
      <path d="M12 14v3M9 20h6M10 17h4v3h-4z" />
    </>
  ),
  "trending-up": (
    <>
      <path d="M4 16l5.5-5.5 3.5 3.5L20 7" />
      <path d="M14 7h6v6" />
    </>
  ),
  "bar-chart": (
    <>
      <path d="M5 20V11M12 20V4M19 20v-7" />
      <path d="M3 20h18" />
    </>
  ),
  "cb-tile": (
    <>
      <path d="M12 3l7 3.5v6.3c0 4-3 6.8-7 8.2-4-1.4-7-4.2-7-8.2V6.5L12 3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
};

export default function NavIcon({ iconKey, className }: NavIconProps) {
  const content = PATHS[iconKey as IconKey];
  if (!content) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {content}
    </svg>
  );
}
