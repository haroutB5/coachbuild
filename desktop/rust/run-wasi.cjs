// Execute the pure Rust artifact with Node's experimental WASI API. No Windows
// policy changes, native binary launching, network or real user data access.
const { WASI } = require('node:wasi');
const { readFileSync } = require('node:fs');
const wasi = new WASI({ version: 'preview1', args: process.argv.slice(2), env: {}, preopens: {} });
WebAssembly.instantiate(readFileSync(process.argv[2]), { wasi_snapshot_preview1: wasi.wasiImport })
  .then(({ instance }) => { process.exitCode = wasi.start(instance); }).catch(error => { console.error(error.message); process.exitCode = 1; });
