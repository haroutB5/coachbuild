import type { ChampionRef } from "@/lib/types";

export interface FeaturedOtpRequestInputs {
  champId: number;
  champKey: string;
  ver: string;
}

/** The values that identify all requests made by FeaturedOtpCard's effect. */
export function featuredOtpRequestInputs(
  champ: Pick<ChampionRef, "id" | "key">,
  ver: string
): FeaturedOtpRequestInputs {
  return { champId: champ.id, champKey: champ.key, ver };
}
