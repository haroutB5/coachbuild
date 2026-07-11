// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/types.ts — Phase 1 pro-match-history types.
// THE CONTRACT for GET /api/pros lives on ProGame/ProsResponse — fronty builds
// against this exactly. Do not diverge without updating both sides.
// ─────────────────────────────────────────────────────────────────────────────

/** 0=TOP 1=JUNGLE 2=MIDDLE 3=BOTTOM 4=UTILITY — same numbering as app RoleId,
 *  minus the 5=auto sentinel (pro match data always has a concrete role).
 *  Kept intentionally NARROW (no -1 here) — lib/pro/extract.ts and
 *  lib/pro/roleMap.ts's soloQ path is guaranteed a concrete role by
 *  construction (TEAM_POSITION_MAP only ever produces 0-4) and that
 *  guarantee is worth keeping visible in the type. See DisplayRoleId below
 *  for the field that needs to tolerate "unresolved." */
export type ProRoleId = 0 | 1 | 2 | 3 | 4;

/** ProRoleId plus -1=UNKNOWN, added for Phase 2 (prostage): Leaguepedia's
 *  Role text can fail to resolve (missing, or a vocabulary variant
 *  lib/prostage/roleMap.ts doesn't recognize yet), and those rows are still
 *  stored/served rather than dropped — components/ProGameCard.tsx's
 *  GAME_LANE_LABEL lookup already tolerates any unmapped numeric key by
 *  simply omitting the lane label, so -1 renders as "no lane shown," never a
 *  crash or a wrong label. Used ONLY on the outward ProGame/ProGamePlayer
 *  contract, which both sources (soloq, always concrete; prostage,
 *  sometimes unresolved) share — soloQ's own internal types stay on the
 *  narrower ProRoleId since a plain ProRoleId value is always assignable to
 *  DisplayRoleId. */
export type DisplayRoleId = ProRoleId | -1;

export interface ProGamePlayer {
  name: string;
  team: string | null;
  role: DisplayRoleId;
  country: string | null;
}

export interface ProGameAccount {
  riotId: string; // "gameName#tagLine"
  region: string; // lolpros server string, e.g. "EUW", "KR"
}

export interface ProGameRunes {
  primaryTree: number;
  keystone: number;
  primary: number[]; // 3 non-keystone primary rune ids
  secondaryTree: number;
  secondary: number[]; // 2 ids
  shards: number[]; // [offense, flex, defense]
}

export interface ProGamePurchase {
  itemId: number;
  ts: number; // seconds into the game (converted from Riot's raw ms timeline timestamp)
}

/** THE CONTRACT — GET /api/pros response element.
 *  Phase 2 (prostage): source is a REAL discriminant, not a hardcoded literal
 *  — "prostage" rows come from Leaguepedia Cargo (official esports games) and
 *  carry `tournament`; "soloq" rows never set it. prostage rows have no Riot
 *  match timeline, so purchaseOrder/skillOrder are always [] and
 *  gameDurationSec is always 0 for them — the frontend hides duration/build-
 *  timeline UI when gameDurationSec === 0 (coordinate any change here with
 *  fronty's consumer). */
export interface ProGame {
  id: string; // matchId (soloq) or Leaguepedia GameId (prostage)
  source: "soloq" | "prostage";
  player: ProGamePlayer;
  account: ProGameAccount;
  championId: number;
  championName: string;
  role: DisplayRoleId;
  patch: string; // "16.13"; may be "" for prostage rows where Patch wasn't resolvable
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameCreation: string; // ISO
  gameDurationSec: number; // 0 for prostage (unknown — Cargo doesn't expose it)
  spells: [number, number];
  finalItems: number[]; // item0-5, 0s filtered out
  trinket: number | null; // item6
  purchaseOrder: ProGamePurchase[]; // undo-adjusted, chronological; always [] for prostage
  skillOrder: string[]; // ["Q","W","E","Q",...]; always [] for prostage
  runes: ProGameRunes;
  tournament?: string; // prostage only — tournament_display, e.g. "LEC 2026 Summer"
  playerLink?: string; // prostage only — prostage_matches.player_link, the `player` param for /api/prostage/timeline
  /** Per-game ALLY + ENEMY team compositions (dpm.lol-style champ icon rows).
   *  Both fields are ALWAYS emitted together, or BOTH omitted — never one
   *  without the other. Emitted only when there are exactly 5 champion ids
   *  per side; absent = frontend renders nothing for this row.
   *  allyChampionIds INCLUDES the player's own champion (matches `championId`
   *  above) so the frontend can highlight self by id match within the row.
   *
   *  ROLE-ORDERED (added 2026-07-11): index 0=Top 1=Jungle 2=Mid 3=Bot/ADC
   *  4=Support, per side — so a mid-laner's champion always renders in the
   *  middle slot of the strip, not wherever the source fetch happened to put
   *  it. Both producers (lib/pro/extract.ts's extractTeamComps for soloq,
   *  app/api/pros/route.ts's compsForGame for prostage) degrade to SOURCE
   *  ORDER whenever a side's 5 entries don't carry exactly 5 distinct known
   *  roles (0-4) — a role-less/duplicate-role shape (remake/AFK/unresolved
   *  Cargo role) yields a wrong-but-complete strip rather than a
   *  reordered lie. The frontend does not need to special-case either
   *  case — it just renders index order and highlights self by championId. */
  allyChampionIds?: number[];
  enemyChampionIds?: number[];
  /** Cleaned (wiki-disambiguation stripped) team display names — prostage
   *  ONLY, always emitted together or both omitted (soloq never sets these;
   *  soloq team strings come from lolpros/Riot and never carry a Leaguepedia
   *  parenthetical). allyTeamName is the TRACKED side (this row's own
   *  `player.team`); enemyTeamName is the one other team present in the same
   *  game. Omitted when the row's own team is null or the opposing team
   *  can't be resolved to exactly one other team for the game_id (same
   *  ambiguity guard as allyChampionIds/enemyChampionIds, computed from the
   *  same batched comps query — see app/api/pros/route.ts's
   *  teamNamesForGame). The RAW (uncleaned) team string is still what
   *  `player.team` carries, and what's stored in the DB / used as the
   *  comps-grouping join key — cleaning happens ONLY at this display field,
   *  via lib/prostage/displayName.ts's cleanLeaguepediaName(). */
  allyTeamName?: string | null;
  enemyTeamName?: string | null;
  /** Per-player team data (added 2026-07-11) — full per-slot detail so the
   *  frontend sheet can render each player's items, not just a champ-icon
   *  strip. Same both-or-neither / 5-or-omit / role-ordered contract as
   *  allyChampionIds/enemyChampionIds above (index 0=Top..4=Support, degrades
   *  to source order on a non-5-distinct-role side) — producers share the
   *  SAME ordering helper (orderByRole in lib/pro/extract.ts) so the two
   *  arrays are never out of sync with each other for a given row.
   *  allyPlayers[i] and allyChampionIds[i] always describe the same slot.
   *  name is the display name when resolvable: soloq uses the Riot match's
   *  riotIdGameName (falls back to summonerName, then null — summonerName is
   *  frequently "" post-privacy-change, see lib/pro/extract.ts); prostage uses
   *  the tracked pros.name when that row links to a known pro, else the raw
   *  Leaguepedia player_link. */
  allyPlayers?: TeamCompPlayer[];
  enemyPlayers?: TeamCompPlayer[];
}

export interface TeamCompPlayer {
  championId: number;
  /** DISPLAY name — for prostage, wiki-disambiguation-stripped (see
   *  lib/prostage/displayName.ts's cleanLeaguepediaName()) when this falls
   *  back to the raw player_link; when it resolves to a tracked pro, pros.name
   *  is already clean. For soloq, the Riot-derived name (see
   *  lib/pro/extract.ts's riotParticipantName) needs no cleaning. */
  name: string | null;
  items: number[]; // final items, 0s filtered, order preserved
  trinket: number | null;
  role: number | null; // 0-4, null when unknown
  /** coachbuild.pros.id UUID when this participant resolves to a TRACKED pro,
   *  else null. Prostage: resolved via prostage_matches.pro_id (set at
   *  ingest — see lib/prostage/ingest.ts) with a conservative name-match
   *  fallback (pros.name against the RAW player_link, then against the
   *  cleaned form) applied in app/api/pros/route.ts's buildProstageCompsMap
   *  for any row that fallback still missed at ingest time (e.g. a pro
   *  tracked AFTER this row was ingested). SoloQ participants are always
   *  null EXCEPT the tracked player's own slot, which carries his own known
   *  proId (cheap — already known from the request context, see
   *  lib/pro/extract.ts's participantToTeamCompPlayer) — teammates/opponents
   *  in a soloq game are random ranked players we don't track and never
   *  fuzzy-match by name. Optional field: absent means "not attempted /
   *  not applicable," same as null for consumers. */
  proId?: string | null;
}

export interface ProsResponse {
  games: ProGame[];
}

/** THE CONTRACT — GET /api/players response element (typeahead search). */
export interface Player {
  id: string; // lolpros uuid
  name: string;
  slug: string;
  team: string | null;
  role: ProRoleId | null;
  country: string | null;
  gameCount: number;
}

export interface PlayersResponse {
  players: Player[];
}

// ── lolpros.gg raw shapes (partial + defensive — undocumented API) ──────────
// Verified live 2026-07-09. Ladder entries carry ONE (main) account; profiles
// carry the FULL account list under league_player.accounts.

export interface LolProsAccountRaw {
  uuid?: string;
  server?: string;
  encrypted_puuid?: string | null;
  summoner_name?: string; // "gamename#tagline" display form
  gamename?: string;
  tagline?: string;
  summoner_names?: { name: string; created_at?: string }[];
}

export interface LolProsTeamRaw {
  name?: string;
  tag?: string;
  slug?: string;
}

export interface LolProsLadderEntry {
  uuid: string;
  name: string;
  slug: string;
  country: string | null;
  position: string | null; // "20_jungle", "30_mid", "40_adc", "10_top", "50_support"
  team: LolProsTeamRaw | null;
  account: LolProsAccountRaw | null;
}

export interface LolProsProfile {
  uuid: string;
  name: string;
  slug: string;
  country: string | null;
  position: string | null;
  team: LolProsTeamRaw | null;
  accounts: LolProsAccountRaw[];
}

// ── Riot API raw shapes (partial — only the fields we consume) ──────────────

export interface RiotAccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotPerkSelection {
  perk: number;
  var1?: number;
  var2?: number;
  var3?: number;
}

export interface RiotPerkStyle {
  description: string; // "primaryStyle" | "subStyle"
  style: number;
  selections: RiotPerkSelection[];
}

export interface RiotPerks {
  statPerks: { defense: number; flex: number; offense: number };
  styles: RiotPerkStyle[];
}

export interface RiotParticipant {
  puuid: string;
  participantId: number;
  teamId: number; // 100 | 200 — used to sum team_kills for the raw game-stats extraction
  championId: number;
  championName: string;
  teamPosition: string; // "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""
  // Player display name for teammate/opponent rows (TeamCompPlayer.name).
  // Verified live 2026-07-11 against a real match-v5 response: riotIdGameName
  // is the current field (Riot ID display name, post-Riot-ID-migration);
  // summonerName still exists on the DTO but comes back "" (empty string) for
  // real accounts now — privacy change, NOT reliably absent/undefined, so
  // treat an empty string the same as missing rather than trusting truthiness
  // alone at the call site.
  riotIdGameName?: string;
  riotIdTagline?: string;
  summonerName?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number; // lane minions
  neutralMinionsKilled: number; // jungle monsters — cs = sum of both
  totalDamageDealtToChampions: number;
  goldEarned: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  summoner1Id: number;
  summoner2Id: number;
  perks: RiotPerks;
}

export interface RiotMatch {
  metadata: { matchId: string };
  info: {
    gameCreation: number; // epoch ms
    gameDuration: number; // seconds (match-v5)
    gameVersion: string; // "14.13.567.1234"
    participants: RiotParticipant[];
  };
}

export interface RiotTimelineEvent {
  type: string;
  timestamp: number; // ms
  participantId?: number;
  itemId?: number; // ITEM_PURCHASED / ITEM_SOLD
  beforeId?: number; // ITEM_UNDO
  afterId?: number; // ITEM_UNDO
  skillSlot?: number; // SKILL_LEVEL_UP (1=Q 2=W 3=E 4=R)
  levelUpType?: string; // SKILL_LEVEL_UP
}

export interface RiotTimelineFrame {
  timestamp: number;
  events: RiotTimelineEvent[];
}

export interface RiotTimeline {
  info: { frames: RiotTimelineFrame[] };
}

// ── Internal DB row shapes ───────────────────────────────────────────────────

export interface ProRow {
  id: string;
  name: string;
  slug: string;
  team: string | null;
  role: ProRoleId | null;
  country: string | null;
  updated_at: string;
}

export interface ProAccountRow {
  puuid: string;
  pro_id: string;
  region: string;
  riot_id: string;
  active: boolean;
  last_fetched_at: string | null;
  last_match_ts: number | null;
}
