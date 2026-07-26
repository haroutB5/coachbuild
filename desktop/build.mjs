// Bundles main + preload with esbuild. The shell imports the shared write rules
// from ../lib/lcu/applySafety.ts (the repo's single source for Hard rule 5), so
// a bundler is required — that import must NOT be duplicated into desktop/.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
