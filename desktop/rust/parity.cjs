// Generate or verify deterministic reference results by executing the real C# core.
// Run after building oracle/MergeOracle.csproj, with the .NET 8 SDK host path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = __dirname;
const fixture = path.join(root, 'coachbuild-core/tests/fixtures/parity.json');
const sources = ['ItemSetMergeService.cs', 'ApplyPayloadValidation.cs', 'JsonOptions.cs'];
const hashes = Object.fromEntries(sources.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '../src/CoachBuild.Core', name))).digest('hex')]));
let seed = 0x434f4143;
function next(n) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; }
const titles = [undefined, null, 12, '', 'Foreign', 'CoachBuild', 'CoachBuild Old', 'coachbuild Lower', 'Coach\u00adBuild', ' CoachBuild', 'ＣoachBuild', 'CoachBuilder', 'u.gg Ahri', { nested: true }];
const uids = [undefined, null, 42, '', 'coachbuild-', 'coachbuild-import-galio-mid-pro', 'CoachBuild-x', 'foreign', ['coachbuild-x']];
const prefixes = [null, '', 'CoachBuild', 'CoachBuild u.gg', 'Foreign', 'Coach\u00adBuild'];
const primitives = [null, 42, true, false, 'foreign scalar', [], ['nested', { arbitrary: true }]];
function set() {
  if (next(4) === 0) return structuredClone(primitives[next(primitives.length)]);
  const title = titles[next(titles.length)], uid = uids[next(uids.length)];
  const v = { blocks: [{ type: 'Items', items: [{ id: '1001', count: 1 }] }], extension: { keep: [next(99), null, 'é😀<&'] } };
  if (title !== undefined) v.title = title;
  if (uid !== undefined) v.uid = uid;
  return v;
}
const cases = Array.from({ length: 1024 }, (_, index) => {
  let existing;
  if (index < primitives.length) existing = structuredClone(primitives[index]);
  else {
    existing = { accountId: 77, timestamp: index, customTopLevel: { keep: true, nested: [null, '日本語', index] } };
    if (index % 13 !== 0) existing.itemSets = index % 13 === 1 ? 'malformed' : Array.from({ length: next(12) }, set);
  }
  return { existing, newSets: Array.from({ length: next(6) }, set), replacePrefix: prefixes[next(prefixes.length)] };
});
const input = { sourceSha256: hashes, cases };
const dotnet = process.argv[3];
if (!dotnet || !['generate', 'verify'].includes(process.argv[2])) throw new Error('usage: node parity.cjs <generate|verify> <dotnet-host>');
const child = spawnSync(dotnet, [path.join(root, 'oracle/bin/Debug/net8.0/MergeOracle.dll')], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
if (child.status !== 0) throw new Error(`C# oracle failed (${child.status}): ${child.stderr}`);
const oracle = JSON.parse(child.stdout);
if (process.argv[2] === 'generate') {
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, '{"sourceSha256":' + JSON.stringify(oracle.sourceSha256) + ',"cases":[\n' + oracle.cases.map(row => JSON.stringify(row)).join(',\n') + '\n]}\n');
  console.log(`Generated ${oracle.cases.length} C# reference cases; source hashes pinned in fixture.`);
} else {
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fixture, 'utf8')), oracle);
  console.log(`Verified ${oracle.cases.length} reference cases against current unmodified C# core and source hashes.`);
}
