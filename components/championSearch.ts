import type { ChampionRef } from "@/lib/types";

/**
 * Community shorthand accepted by the champion search. Values intentionally
 * use the API's display names so a typo in this table cannot manufacture a
 * result: `matchChampions` only accepts an alias when that name/key is present
 * in the supplied `/api/champions` data.
 */
export const CHAMPION_ALIASES = {
  j4: "Jarvan IV",
  jarvan: "Jarvan IV",
  mf: "Miss Fortune",
  ww: "Warwick",
  tf: "Twisted Fate",
  kata: "Katarina",
  asol: "Aurelion Sol",
  kha: "Kha'Zix",
  cho: "Cho'Gath",
  mundo: "Dr. Mundo",
  tk: "Tahm Kench",
  tahm: "Tahm Kench",
  gp: "Gangplank",
  lb: "LeBlanc",
  ez: "Ezreal",
  cass: "Cassiopeia",
  trynd: "Tryndamere",
  yi: "Master Yi",
  vlad: "Vladimir",
  malz: "Malzahar",
  morde: "Mordekaiser",
  naut: "Nautilus",
  noc: "Nocturne",
  seju: "Sejuani",
  shy: "Shyvana",
  shyv: "Shyvana",
  sol: "Aurelion Sol",
  aurelion: "Aurelion Sol",
  vik: "Viktor",
  voli: "Volibear",
  rek: "Rek'Sai",
  reksai: "Rek'Sai",
  kog: "Kog'Maw",
  velkoz: "Vel'Koz",
  heca: "Hecarim",
  ori: "Orianna",
  panth: "Pantheon",
  renek: "Renekton",
  tris: "Tristana",
  xin: "Xin Zhao",
  akshan: "Akshan",
} as const satisfies Readonly<Record<string, string>>;

interface ChampionSearchForm {
  compact: string;
  words: string[];
}

interface ChampionCandidate {
  champion: ChampionRef;
  forms: ChampionSearchForm[];
}

/** Keep search tolerant of League punctuation and diacritics. */
function searchForm(value: string): ChampionSearchForm {
  const folded = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return {
    compact: folded.replace(/[^a-z0-9]/g, ""),
    words: folded.split(/[^a-z0-9]+/).filter(Boolean),
  };
}

function aliasTargetMatches(candidate: ChampionCandidate, target: string): boolean {
  const targetForm = searchForm(target).compact;
  return candidate.forms.some((form) => form.compact === targetForm);
}

/**
 * Match a query against the API champion list and rank the result without
 * mutating the input. Exact names and verified aliases come first, then
 * compact prefixes/word-initial queries, then ordinary mid-string includes.
 *
 * The compact form makes `leesin`, `kaisa`, `chogath`, and `drmundo` work even
 * though the API display names contain spaces, apostrophes, or punctuation.
 * Word-by-word matching additionally handles queries such as `lee s`.
 */
export function matchChampions(query: string, champions: ChampionRef[]): ChampionRef[] {
  const trimmed = query.trim();
  if (!trimmed) return champions.slice();

  const queryForm = searchForm(trimmed);
  if (!queryForm.compact) return champions.slice();

  const aliasTarget = CHAMPION_ALIASES[queryForm.compact as keyof typeof CHAMPION_ALIASES];
  const candidates: ChampionCandidate[] = champions.map((champion) => ({
    champion,
    forms: [searchForm(champion.name), searchForm(champion.key)],
  }));

  return candidates
    .map((candidate, originalIndex) => {
      const aliasMatch = aliasTarget ? aliasTargetMatches(candidate, aliasTarget) : false;
      const exactMatch = candidate.forms.some((form) => form.compact === queryForm.compact);
      const prefixMatch = candidate.forms.some((form) => form.compact.startsWith(queryForm.compact));
      const wordInitialMatch =
        queryForm.words.length > 1 &&
        candidate.forms.some(
          (form) =>
            queryForm.words.length <= form.words.length &&
            queryForm.words.every((word, index) => form.words[index].startsWith(word))
        );
      const includesMatch = candidate.forms.some((form) => form.compact.includes(queryForm.compact));

      if (!aliasMatch && !exactMatch && !prefixMatch && !wordInitialMatch && !includesMatch) return null;

      // Alias hits intentionally share the exact-match rank, even where the
      // alias is only a short prefix of the canonical display name.
      const rank = aliasMatch || exactMatch ? 0 : prefixMatch || wordInitialMatch ? 1 : 2;
      return { candidate, rank, originalIndex };
    })
    .filter((entry): entry is { candidate: ChampionCandidate; rank: number; originalIndex: number } => entry !== null)
    .sort((a, b) => a.rank - b.rank || a.originalIndex - b.originalIndex)
    .map((entry) => entry.candidate.champion);
}

