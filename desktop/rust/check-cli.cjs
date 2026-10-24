const { spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const runner = path.join(__dirname, 'run-wasi.cjs');
const wasm = path.join(__dirname, 'coachbuild-core/target/wasm32-wasip1/debug/coachbuild-core.wasm');
function run(input, command = 'merge-itemset') {
  const child = spawnSync(process.execPath, [runner, wasm, command], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  if (child.error) throw child.error;
  return { status: child.status, value: JSON.parse(child.stdout) };
}
const input = { existing: { accountId: 77, itemSets: [{ title: 'Foreign', blocks: [{ keep: true }] }, { uid: 'coachbuild-old' }] }, newSets: [{ title: 'Plain', uid: 'coachbuild-new' }], replacePrefix: 'ignored' };
assert.deepStrictEqual(run(input), { status: 0, value: { accountId: 77, itemSets: [input.existing.itemSets[0], input.newSets[0]] } });
assert.deepStrictEqual(run({ existing: [], newSets: [] }), { status: 0, value: null });
assert.equal(run({ existing: {}, newSets: null }).status, 2);
assert.equal(run('{broken').status, 2);
assert.equal(run({}, 'merge-runepage').status, 2);
assert.equal(run({ existing: {}, newSets: [], replacePrefix: 4 }).status, 2);
console.log('6 CLI process checks passed (WASI), including JSON errors and unsupported commands.');
