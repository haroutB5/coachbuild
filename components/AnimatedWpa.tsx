"use client";

import { useCountUp } from "./useCountUp";
import { wpaClass, wpaText } from "./StatBadge";

/** WPA headline number with a one-shot count-up-from-0 on mount — the app's
 *  single tasteful motion touch (WPA is CoachBuild's core stat, rendered on
 *  every rune/item/spell tile). Renders through the same wpaClass/wpaText
 *  helpers everything else uses, so color + formatting stay identical to
 *  the static version; only the animation is new. */
export default function AnimatedWpa({
  wpa,
  className = "",
}: {
  wpa: number;
  className?: string;
}) {
  const animated = useCountUp(wpa);
  return (
    <span className={`tabular-nums ${wpaClass(wpa)} ${className}`}>{wpaText(animated)}</span>
  );
}
