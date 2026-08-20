// ─────────────────────────────────────────────────────────────────────────────
// generate-consensus-artifact.mts — CLI for the per-patch precomputed consensus
// the in-game shop export reads INSTEAD of the database.
//
// Runs on the INGEST side (a scheduled job or by hand), never at request time.
// That is the whole design: the request path gets a static file, and the one
// process that still needs Postgres runs once a patch, where a failure is a
// non-zero exit and a red log line rather than a silently short shop panel.
//
//   npx tsx scripts/generate-consensus-artifact.mts --base https://coachbuild.vercel.app
//   npx tsx scripts/generate-consensus-artifact.mts --champions 134,101 --dry-run
//
// ── This file owns argv, stdout and the file write. Nothing else. ───────────
//
// Every rule about what may be written lives in lib/consensus/generateArtifact.ts
// and is unit-tested there. A script cannot be, and the rules in question are
// the kind where being wrong is expensive: a combo written as `null` tells the
// export "this champion genuinely has no pro data, omit the block" and the
// export does not second-guess it, so one flaky request during generation could
// delete a block from the shop panel for a whole patch.
//
// ── Why it goes through the HTTP API and not straight to SQL ────────────────
//
// A generator holding its own copy of the two queries would be a third place
// the sample is defined, and this codebase has already paid for that once:
// v0.70.0 fixed the Pro Consensus card to `limit=200&proMin=100` and left the
// export path on `limit=100` with no pro-play floor, so the "Pro build" line
// users got in their shop stayed ~96% solo queue for weeks. A generator that
// drifted the same way would be worse, because it would bake the wrong sample
// into a committed file and serve it with total confidence.
//
// So it issues the SAME request the live export issues — literally the same
// builder, `consensusRequestPath` — against a running deployment, and reduces
// the answer with the SAME function, `reduceConsensusModel`.
//
// Cost, since the point of all this is a compute quota: 173 champions x 5 roles
// x 2 endpoints = 1,730 requests, once per patch. At ~0.2 s of database time
// each that is roughly 6 minutes of compute, or ~0.03 CU-hours at Neon's 0.25
// CU floor — against a 100 CU-hour monthly allowance.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { getAllChampions } from "@/lib/staticData";
import { getItemDetailMap } from "@/components/itemDetail";
import { versionFromPatch } from "@/components/proAssets";
import { serializeConsensusArtifact } from "@/components/hextech/consensusArtifact";
import { generateConsensusArtifact, type GenerateOptions } from "@/lib/consensus/generateArtifact";

const DEFAULT_OUT = "public/consensus/item-set-consensus.json";

interface CliOptions extends GenerateOptions {
  out: string;
  dryRun: boolean;
  retries: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    base: "http://localhost:3000",
    out: DEFAULT_OUT,
    patch: null,
    championIds: null,
    concurrency: 4,
    minCoverage: 0.95,
    dryRun: false,
    retries: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") opts.base = next().replace(/\/+$/, "");
    else if (a === "--out") opts.out = next();
    else if (a === "--patch") opts.patch = next();
    else if (a === "--concurrency") opts.concurrency = Math.max(1, parseInt(next(), 10));
    else if (a === "--min-coverage") opts.minCoverage = Number(next());
    else if (a === "--champions") opts.championIds = next().split(",").map((s) => parseInt(s.trim(), 10));
    else if (a === "--retries") opts.retries = Math.max(0, parseInt(next(), 10));
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "generate-consensus-artifact — bake the per-patch shop-export consensus",
          "",
          "  --base <url>           deployment to draw the sample from (default http://localhost:3000)",
          `  --out <path>           output file (default ${DEFAULT_OUT})`,
          "  --patch <major.minor>  override the patch label (default: read off /api/build)",
          "  --champions <ids>      comma-separated champion ids, for a smoke run",
          "  --concurrency <n>      parallel champion-roles (default 4)",
          "  --min-coverage <0..1>  refuse to write below this resolved fraction (default 0.95)",
          "  --retries <n>          per-request retries before a combo is dropped (default 3)",
          "  --dry-run              resolve everything, print the report, write nothing",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
  }
}

/** Retries 5xx and network errors; does NOT retry 4xx, which is a real answer
 *  about a bad request and will not improve. Throws on every exhausted attempt,
 *  which is what the generator core reads as "this combo failed" — the same
 *  failure-vs-empty distinction the export makes, applied one layer up. */
function makeFetchJson(retries: number) {
  return async function fetchJson<T>(url: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new HttpStatusError(res.status, url);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpStatusError && err.status >= 400 && err.status < 500) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[consensus] base=${opts.base} concurrency=${opts.concurrency} minCoverage=${opts.minCoverage}`);

  const report = await generateConsensusArtifact(opts, {
    fetchJson: makeFetchJson(opts.retries),
    listChampions: getAllChampions,
    loadItemMeta: (patch) => getItemDetailMap(versionFromPatch(patch)),
    onProgress: (done, total) => {
      if (done % 100 === 0 || done === total) console.log(`[consensus] ${done}/${total}`);
    },
  });

  console.log(
    `[consensus] patch=${report.artifact.patch} resolved ${report.resolved}/${report.attempted} ` +
      `(${(report.coverage * 100).toFixed(1)}%) — pro ${report.artifact.coverage.pro}, otp ${report.artifact.coverage.otp}`
  );
  for (const f of report.failures.slice(0, 20)) console.warn(`[consensus] FAILED ${f}`);
  if (report.failures.length > 20) console.warn(`[consensus] ... and ${report.failures.length - 20} more`);

  const text = serializeConsensusArtifact(report.artifact);
  const sizeKb = (Buffer.byteLength(text) / 1024).toFixed(1);

  if (opts.dryRun) {
    console.log(`[consensus] --dry-run: would write ${sizeKb} KB to ${opts.out}`);
    return;
  }
  const outPath = resolvePath(process.cwd(), opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, "utf8");
  console.log(`[consensus] wrote ${sizeKb} KB to ${outPath}`);
}

main().catch((err) => {
  console.error(`[consensus] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
