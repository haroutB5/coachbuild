// ─────────────────────────────────────────────────────────────────────────────
// refresh-champion-kits.mts — the ONLINE half of the champion-kit drift guard.
//
//   npx tsx scripts/refresh-champion-kits.mts            # check only, exit 1 on drift
//   npx tsx scripts/refresh-champion-kits.mts --write    # accept the new roster
//   npx tsx scripts/refresh-champion-kits.mts --patch 16.16.1
//
// The two guards (lib/__tests__/championKitDrift.test.ts and
// desktop/tests/CoachBuild.Core.Tests/ChampionKitDriftTests.cs) compare the two
// shipped tables against fixtures/champion-kit-derived.json. That fixture is a
// snapshot, so on its own it can only ever prove the tables have not drifted
// away from whatever Riot published on the day it was taken. THIS is what
// notices that Riot has moved.
//
// It is deliberately NOT a test. A unit suite that fetches a CDN is a suite that
// goes red when the office wifi does, and one that then gets ignored. Run it
// from maintenance; a non-zero exit means "the roster moved, look at it", not
// "the build is broken".
//
// The free-rank semantics are imported from lib/championKit.ts rather than
// restated here. A second copy of that mapping living in a refresh script is
// how the fixture would end up agreeing with itself and with nothing else — and
// the C# guard asserts the fixture's free ranks follow the web's own semantics
// precisely so this import cannot be quietly replaced by a local constant.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kitFromMaxRanks, SPELL_SLOTS } from "../lib/championKit";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "fixtures", "champion-kit-derived.json");
const VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json";

type DerivedChampion = {
  id: number;
  key: string;
  maxRanks: [number, number, number, number];
  freeR: number;
  purchasableTotal: number;
};

const args = process.argv.slice(2);
const write = args.includes("--write");
const patchArg = args.includes("--patch") ? args[args.indexOf("--patch") + 1] : undefined;

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

async function main(): Promise<number> {
  const patch = patchArg ?? (await getJson(VERSIONS))[0];
  const source = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/championFull.json`;
  const raw = await getJson(source);

  const champions: DerivedChampion[] = [];
  const refused: string[] = [];

  for (const [key, champ] of Object.entries<any>(raw.data)) {
    const spells = champ.spells ?? [];
    // The four-spell shape is the entire positional contract with the CDN. A
    // champion who breaks it is a story, not a row to quietly truncate.
    if (spells.length !== SPELL_SLOTS.length) {
      refused.push(`${key}: ${spells.length} spells, expected ${SPELL_SLOTS.length}`);
      continue;
    }
    const maxRanks = spells.map((s: any) => s.maxrank) as [number, number, number, number];
    const kit = kitFromMaxRanks(maxRanks, key);
    if (!kit) {
      // An R maxrank outside {1,3,4,6}. kitFromMaxRanks refuses rather than
      // guesses, and so does this: writing a guessed row would put the guess
      // beyond the reach of the guard that is supposed to catch it.
      refused.push(`${key}: unresolvable R maxrank ${maxRanks[3]} (${maxRanks.join("/")})`);
      continue;
    }
    champions.push({
      id: Number(champ.key),
      key,
      maxRanks,
      freeR: kit.freeRanks.R,
      purchasableTotal: kit.purchasableTotal,
    });
  }

  champions.sort((a, b) => a.id - b.id);

  const existing = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const next = {
    README: existing.README,
    ddragonPatch: patch,
    fetchedAt: new Date().toISOString(),
    source,
    championCount: champions.length,
    champions,
  };

  // fetchedAt always moves, so it cannot be part of the comparison.
  const same =
    JSON.stringify({ ...existing, fetchedAt: "" }) === JSON.stringify({ ...next, fetchedAt: "" });

  console.log(`ddragon ${patch}: ${champions.length} champions, ${refused.length} refused`);
  for (const line of refused) console.log(`  refused: ${line}`);

  if (same) {
    console.log(`fixture is current (${existing.ddragonPatch} -> ${patch}, no shape changed)`);
    return refused.length > 0 ? 1 : 0;
  }

  const before = new Map<number, DerivedChampion>(
    (existing.champions ?? []).map((c: DerivedChampion) => [c.id, c])
  );
  for (const champ of champions) {
    const old = before.get(champ.id);
    if (!old) {
      console.log(`  NEW      ${champ.key} (${champ.id}) ${champ.maxRanks.join("/")} freeR ${champ.freeR}`);
      continue;
    }
    if (old.maxRanks.join("/") !== champ.maxRanks.join("/") || old.freeR !== champ.freeR)
      console.log(
        `  CHANGED  ${champ.key} (${champ.id}) ${old.maxRanks.join("/")} freeR ${old.freeR}` +
          ` -> ${champ.maxRanks.join("/")} freeR ${champ.freeR}`
      );
    before.delete(champ.id);
  }
  for (const gone of before.values()) console.log(`  REMOVED  ${gone.key} (${gone.id})`);

  if (!write) {
    console.log("\nroster moved. re-run with --write to accept, then run both suites:");
    console.log("  npx vitest run lib/__tests__/championKitDrift.test.ts");
    console.log('  dotnet test desktop/CoachBuild.Desktop.sln --filter "FullyQualifiedName~ChampionKitDrift"');
    return 1;
  }

  writeFileSync(FIXTURE, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nwrote ${FIXTURE}. Run both suites; a red guard names the table entry to update.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  }
);
