#!/usr/bin/env node
// Local bootstrap runner for the "Draft" recommender's matchup/champ-stats
// ingest (see _research/draft-feature-plan.md §2/§9). Walks EVERY champion
// via lib/draft/ingest.ts's cursor, in-process, back to back — same shape as
// scripts/ingest-prostage.mjs. Uses a curl-subprocess transport (u.gg
// REQUIRES a `Referer: https://u.gg/` header the plain curlTransport
// doesn't send — see scripts/_curl-transport.mjs's curlTransportWithHeaders)
// since app/route code can't shell out but this script can.
//
// NETWORK STATUS (2026-07-20, RESOLVED): this sandbox's Bash-tool curl,
// WebFetch, and a real CDP-driven Chrome browser are ALL Cloudflare-
// challenged against the u.gg zone — but a Node child_process curl spawn
// (exactly what this script's uggCurlTransport does) goes through clean.
// Live-confirmed: Aatrox(266) vs Mordekaiser(82) decodes to 3173/6100 =
// 52.02%, matching counterpick-research.md exactly, and all 5 role-
// dominance probes (top/jungle/mid/adc/support) check out. See
// lib/draft/ugg.ts's header comment and HANDOFF-engy.md for the full log.
//
// TIMEOUT RETRY (2026-07-29): the 2026-07-27 run errored on exactly 12
// champions, all "curl transport failed (exit 28)" — a curl timeout, not a
// rejection. MEASURED live before assuming a cause: 5 of the 12 (142, 147,
// 164, 233, 234) fetched cleanly in 0.6-1.3s each (2.5-3.2MB payloads)
// against curl's own 60s ceiling — i.e. NOT unusually large or slow blobs,
// so the "big matchup file, needs a longer timeout" theory doesn't hold.
// This is a transient blip (one dropped connection/hung DNS lookup out of
// ~340 sequential curl calls over a long walk), which a bounded retry
// fixes and a longer timeout would not (a longer ceiling doesn't help a
// genuinely hung connection, it just makes a truly-stuck one block
// longer before failing). uggCurlTransport below is wrapped with
// lib/retryTransport.ts's retryWithBackoff (2 retries, 5s/15s) — see
// HANDOFF-engo.md for the measurement log.
//
// Run: npm run ingest:draft
import { loadEnvLocal } from "./_env.mjs";
import { curlTransportWithHeaders } from "./_curl-transport.mjs";

loadEnvLocal();

const { runDraftIngest } = await import("../lib/draft/ingest.ts");
const { getAllChampions, MAX_REAL_CHAMPION_ID } = await import("../lib/staticData.ts");
const { UGG_REFERER } = await import("../lib/draft/ugg.ts");
const { withRetryTransport } = await import("../lib/retryTransport.ts");
const { getSql } = await import("../lib/pro/db.ts");
const { recordIngestRun } = await import("../lib/ingestHealth.ts");

// 2026-07-31 audit P2 (#2) — this run already failed silently once (u.gg
// Cloudflare-challenged on every 6xxxx-keyed champion id, 2026-07-30) with
// nothing but a rotating local log to notice it in. recordIngestRun persists
// whether THIS run's whole walk came back clean so the Draft page (see
// lib/draft/recommend.ts's meta) can surface it honestly instead of the
// staleness only being visible days later via meta.currentPatch drifting.
// Best-effort: never let a failure recording status mask/crash over the
// ingest run itself, which has already finished by the time this fires.
async function recordHealth(ok, error) {
  try {
    const sql = getSql();
    if (!sql) return; // no DATABASE_URL -- nothing to record against
    await recordIngestRun(sql, "draft", { ok, error: error ?? null });
  } catch (err) {
    console.error("ingest-draft: failed to record ingest health (non-fatal):", err);
  }
}

/** curlTransportWithHeaders, pre-bound with u.gg's required Referer, and
 *  wrapped with a bounded retry-with-backoff for the transient curl-level
 *  failures (exit 28 timeouts, DNS blips) seen in production — see the
 *  TIMEOUT RETRY note above for the live measurement backing 5s/15s. */
const uggCurlTransport = withRetryTransport(
  (url) => curlTransportWithHeaders(url, { Referer: UGG_REFERER }),
  {
    delaysMs: [5_000, 15_000],
    onRetry: (attempt, err, delayMs) =>
      console.log(`  [u.gg] transient failure (${err.message}); retry ${attempt} in ${delayMs / 1000}s`),
  }
);

// Known-lane-dominant champions for the "role indices via known-champ-max-
// sample" empirical assertion (plan §9): a champion played overwhelmingly in
// ONE lane should decode with the bulk of its matchup ROW COUNT (a rough
// sample-count proxy — real game-volume weighting would need the row's own
// `games` field, checked separately below) concentrated in that lane's app
// role. This is a SIGNAL, not a hard gate (niche/flex picks are real) — it's
// printed for human review, and only fails the run if a role bucket that
// SHOULD be near-empty for this champ instead dominates (a strong sign the
// u.gg role->app-role map is wrong).
const ROLE_PROBES = [
  { name: "Garen", champId: 86, expectedAppRole: 0 }, // top
  { name: "LeeSin", champId: 64, expectedAppRole: 1 }, // jungle
  { name: "Viktor", champId: 112, expectedAppRole: 2 }, // mid
  { name: "Jinx", champId: 222, expectedAppRole: 3 }, // bot/adc
  { name: "Thresh", champId: 412, expectedAppRole: 4 }, // support
];

// 2-3 lopsided matchups to spot-check against the live u.gg site (plan §9).
// champA is hovered on the u.gg counters page; champB is the opponent shown
// in that page's counter list. u.gg's public counters page renders as
// client-rendered React -- this script fetches the page HTML via the SAME
// curl transport (best-effort: prints raw fetch status/byte-length only,
// since regex-scraping a client-rendered SPA's server HTML is unreliable --
// a human should visually cross-check the live page against the printed
// ingested numbers below, exactly as the plan's ship-sequence requires).
const SPOT_CHECK_URLS = [
  "https://u.gg/lol/champions/aatrox/counters",
  "https://u.gg/lol/champions/yasuo/counters",
  "https://u.gg/lol/champions/malzahar/counters",
];

async function runSpotChecks() {
  console.log("\n=== u.gg live spot-check (best-effort HTML fetch) ===");
  for (const url of SPOT_CHECK_URLS) {
    try {
      const body = await uggCurlTransport(url);
      console.log(`  ${url} -> ${body.length} bytes fetched`);
      if (/just a moment/i.test(body)) {
        console.log("    ! Cloudflare challenge page, not real content -- cannot verify from this network");
      }
    } catch (err) {
      console.log(`  ${url} -> FAILED: ${err.message}`);
    }
  }
}

async function runRoleIndexProbes(champions) {
  console.log("\n=== role-index probe (known-champ-max-sample) ===");
  const { fetchMatchups, resolveUggSchema, makeSchemaProbe } = await import("../lib/draft/ugg.ts");
  const { resolveDraftPatchLabel, patchSegment } = await import("../lib/draft/patch.ts");
  const patchLabel = await resolveDraftPatchLabel();
  const seg = patchSegment(patchLabel);
  const schema = await resolveUggSchema(makeSchemaProbe(ROLE_PROBES[0].champId, seg, uggCurlTransport));

  const failures = [];
  for (const probe of ROLE_PROBES) {
    if (!champions.some((c) => c.id === probe.champId)) {
      console.log(`  skip ${probe.name} (id ${probe.champId} not in champion list)`);
      continue;
    }
    try {
      const decoded = await fetchMatchups(probe.champId, seg, schema, uggCurlTransport);
      const counts = Object.fromEntries(
        Object.entries(decoded.byRole).map(([role, rows]) => [role, rows?.length ?? 0])
      );
      const expectedCount = counts[String(probe.expectedAppRole)] ?? 0;
      const maxOtherCount = Math.max(0, ...Object.entries(counts)
        .filter(([role]) => role !== String(probe.expectedAppRole))
        .map(([, n]) => n));
      console.log(`  ${probe.name} (expected app role ${probe.expectedAppRole}): row counts by role = ${JSON.stringify(counts)}`);
      if (expectedCount === 0 && maxOtherCount > 0) {
        failures.push(`${probe.name}: expected app role ${probe.expectedAppRole} had 0 rows while another role had ${maxOtherCount} -- possible role-map mismatch`);
      }
    } catch (err) {
      console.log(`  ${probe.name} -> FAILED: ${err.message}`);
    }
  }
  return failures;
}

async function main() {
  const champions = (await getAllChampions()).filter((c) => c.id < MAX_REAL_CHAMPION_ID);
  console.log(`resolved ${champions.length} champions`);
  if (champions.length === 0) {
    console.log("nothing to ingest -- champion list came back empty");
    return;
  }

  let cursor = 0;
  let totalRowsUpserted = 0;
  let totalStatsUpserted = 0;
  let totalSkippedRows = 0;
  let patch = "";
  let guardOk = null;
  let lolalyticsVerdict = null;
  const allErrors = [];

  for (;;) {
    console.log(`batch: cursor=${cursor}`);
    const result = await runDraftIngest({
      cursor,
      champions,
      transport: uggCurlTransport,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    patch = result.patch;
    totalRowsUpserted += result.rowsUpserted;
    totalStatsUpserted += result.statsUpserted;
    totalSkippedRows += result.skippedRows;
    allErrors.push(...result.errors);
    console.log(
      `  champs ${result.champStart}..+${result.champCount}: ${result.rowsUpserted} matchup rows, ` +
        `${result.statsUpserted} stats rows, ${result.skippedRows} skipped` +
        (result.errors.length ? `, ${result.errors.length} errors` : "")
    );
    if (result.nextCursor === null) {
      // P0 permanent guard (2026-07-21, see lib/draft/ingestGuard.ts): runDraftIngest
      // already ran the cross-source panel + symmetry check on this FINAL
      // cursor internally (gating retention on both) -- surfaced explicitly
      // here too, not just buried in `errors`, so a bootstrap run's own
      // console output makes the guard's verdict impossible to miss.
      guardOk = result.guardOk;
      console.log(`\n=== P0 ingest guard (cross-source panel + symmetry check) === guardOk=${guardOk}`);
      if (guardOk === false) {
        console.log("  GUARD FAILED -- retention was skipped, see errors below for the specific failing comparisons.");
      }

      // EXTERNAL matchup-direction tripwire (2026-07-21, see
      // lib/draft/lolalyticsCheck.ts): also ran internally on this FINAL
      // cursor. "fail" blocks retention just like the guard above;
      // "indeterminate" (lolalytics markup broke, or too few high-sample
      // matchups were comparable) is expected to happen sometimes and is
      // NOT a failure -- surfaced here so it's never mistaken for one.
      lolalyticsVerdict = result.lolalyticsVerdict;
      console.log(`=== lolalytics matchup-direction tripwire === verdict=${lolalyticsVerdict}`);
      if (lolalyticsVerdict === "fail") {
        console.log("  TRIPWIRE FAILED -- retention was skipped, see errors below for the specific disagreeing matchups.");
      } else if (lolalyticsVerdict === "indeterminate") {
        console.log("  indeterminate (scrape shape or DB coverage) -- non-blocking, retention still ran if the other guard passed.");
      }
      break;
    }
    cursor = result.nextCursor;
  }

  const roleProbeFailures = await runRoleIndexProbes(champions);
  await runSpotChecks();

  console.log("\n=== summary ===");
  console.log(
    JSON.stringify(
      {
        patch,
        totalRowsUpserted,
        totalStatsUpserted,
        totalSkippedRows,
        errorCount: allErrors.length,
        roleProbeFailures,
        guardOk,
        lolalyticsVerdict,
      },
      null,
      2
    )
  );
  if (allErrors.length > 0) {
    console.log(`\nfirst 5 errors:\n  ${allErrors.slice(0, 5).join("\n  ")}`);
  }
  const failed = allErrors.length > 0 || roleProbeFailures.length > 0 || guardOk === false || lolalyticsVerdict === "fail";
  if (failed) {
    process.exitCode = 1;
    const summary = [
      ...allErrors.slice(0, 3),
      guardOk === false ? "ingest guard failed" : null,
      lolalyticsVerdict === "fail" ? "lolalytics tripwire failed" : null,
      roleProbeFailures.length > 0 ? `${roleProbeFailures.length} role-probe failure(s)` : null,
    ].filter(Boolean).join("; ");
    await recordHealth(false, summary);
  } else {
    await recordHealth(true);
  }
}

main().catch(async (err) => {
  // A thrown error here means the walk never reached the summary above (e.g.
  // getAllChampions itself failed) -- record it as a failure too, or the
  // worst outages (the ones that abort the whole script) are exactly the
  // ones this table would otherwise stay silent about.
  await recordHealth(false, err instanceof Error ? err.message : String(err));
  if (err?.name === "DbUnavailableError") {
    console.error(`ingest-draft: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-draft failed:", err);
  process.exit(1);
});
