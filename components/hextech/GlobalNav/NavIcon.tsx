// Phosphor icon adapter for the rail/bottom-bar. Keeping the map here means
// nav data stays serialisable and the desktop/mobile surfaces share one icon
// vocabulary. The library's light weight is the closest match to Nocturne's
// 1.2px stroked glyphs while retaining proper semantic SVGs.
import type { IconProps } from "@phosphor-icons/react";
import {
  Broadcast,
  ChartBar,
  ChartLineUp,
  CrosshairSimple,
  ShieldCheck,
  SquaresFour,
  TrendUp,
  Trophy,
} from "@phosphor-icons/react";

type IconKey = "draft" | "builds" | "post-game" | "companion" | "trophy" | "patch-movers" | "my-stats" | "cb-tile";

interface NavIconProps {
  iconKey: string;
  className?: string;
}

const ICONS: Record<IconKey, React.ComponentType<IconProps>> = {
  draft: CrosshairSimple,
  builds: SquaresFour,
  "post-game": TrendUp,
  companion: Broadcast,
  trophy: Trophy,
  "patch-movers": ChartLineUp,
  "my-stats": ChartBar,
  "cb-tile": ShieldCheck,
};

export default function NavIcon({ iconKey, className }: NavIconProps) {
  const Icon = ICONS[iconKey as IconKey];
  if (!Icon) return null;
  return <Icon aria-hidden="true" size={15} weight="light" className={className} />;
}
