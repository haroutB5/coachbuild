// ─────────────────────────────────────────────────────────────────────────────
// GET /api/download/overlay
//
// Redirects straight to the CURRENT CoachBuild Overlay installer, so the site's
// download button starts a download instead of opening a GitHub page.
//
// ── Why a route and not a direct link ───────────────────────────────────────
// GitHub's convenient `releases/latest/download/<asset>` form still requires the
// EXACT asset filename, and ours carries the version
// (`CoachBuild-Overlay-Setup-0.2.0.exe`). Hardcoding that in the page would 404
// the moment the next version ships — a dead download button that nobody
// notices until a user reports it. Asking the API which asset is current costs
// one cached request and cannot rot.
//
// ── Degradation is deliberate ───────────────────────────────────────────────
// Every failure path — API down, rate limited, reshaped payload, no matching
// asset — falls back to the human-readable releases PAGE rather than erroring.
// A user who wanted a download and lands on the releases list can still finish
// the job in one click; a user who gets a 500 cannot. This is the same posture
// as /api/skill-order's "200 + null is a normal answer", applied to a redirect.
//
// The repo is PUBLIC, so this is an unauthenticated call and carries no token.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNER = "haroutB5";
const REPO = "coachbuild-overlay-releases";
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

/**
 * The LIST endpoint, not `/releases/latest`. This is a correctness fix, not a
 * preference — see the tag-tie note below.
 *
 * GitHub defines "latest" as the most recent non-draft, non-prerelease release
 * "sorted by the `created_at` attribute of the underlying git tag". Our releases
 * repo holds BINARIES ONLY: it has effectively one commit, and every tag points
 * at it, so all five tags carry the IDENTICAL `created_at` (2026-07-27T17:43:01Z
 * for v0.2.0 through v0.4.1). A five-way tie leaves the winner arbitrary.
 *
 * That is not theoretical. On 2026-07-27, minutes after v0.4.1 was published,
 * `/releases/latest` answered **v0.4.1** to a direct call and this route served
 * **v0.2.0** — a three-versions-stale installer to anyone clicking Download.
 * Sorting ourselves by SEMVER removes the dependency on GitHub's tie-breaking
 * entirely, and keeps working however the tags are created.
 */
const API_LIST = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`;

/** GitHub's unauthenticated API allows 60 requests/hour PER IP. A Vercel
 *  function's IP is shared across every visitor, so an uncached call here would
 *  be a genuine outage risk on a busy day for a button that changes at most
 *  once per release. Ten minutes is far longer than the request rate needs and
 *  far shorter than a release cycle. */
const CACHE_SECONDS = 600;

/** The NSIS installer, not the portable build and not the .blockmap that sits
 *  beside it. Anchored on `Setup` + `.exe` so `...Setup-0.2.0.exe.blockmap`
 *  (which also contains "Setup" and would otherwise match a looser test) is
 *  excluded — downloading a blockmap instead of an installer would look like a
 *  corrupt download rather than a wrong file. */
function isInstallerAsset(name: unknown): name is string {
  return typeof name === "string" && /setup.*\.exe$/i.test(name);
}

/**
 * Parse a `vX.Y.Z` tag into comparable numbers. Returns null for anything that
 * is not exactly three numeric parts — an unparseable tag is SKIPPED rather
 * than sorted to the bottom, because a release we cannot rank is one we cannot
 * honestly call newest.
 */
function parseSemver(tag: unknown): [number, number, number] | null {
  if (typeof tag !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Highest semver wins; ties (impossible for distinct tags) keep the first. */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function toReleasesPage() {
  // 302, not 308: which asset is "latest" changes, so this must never be
  // cached permanently by a browser as a permanent redirect.
  return NextResponse.redirect(RELEASES_PAGE, { status: 302 });
}

export async function GET() {
  try {
    const res = await fetch(API_LIST, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub asks every client to identify itself; unidentified callers are
        // rate-limited harder.
        "User-Agent": "coachbuild-overlay-download",
      },
      next: { revalidate: CACHE_SECONDS },
    });

    if (!res.ok) return toReleasesPage();

    const releases = (await res.json()) as unknown;
    if (!Array.isArray(releases)) return toReleasesPage();

    // Pick the highest SEMVER among real, published releases. Drafts are
    // invisible to users and prereleases are opt-in, so neither may ever win
    // the download button — the same rule electron-builder's updater applies.
    let best: { version: [number, number, number]; assets: unknown } | null = null;
    for (const r of releases as Array<{
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
      assets?: unknown;
    }>) {
      if (r?.draft === true || r?.prerelease === true) continue;
      const version = parseSemver(r?.tag_name);
      if (!version) continue;
      if (!Array.isArray(r?.assets)) continue;
      if (!best || compareSemver(version, best.version) > 0) {
        best = { version, assets: r.assets };
      }
    }

    if (!best || !Array.isArray(best.assets)) return toReleasesPage();

    const installer = (best.assets as Array<{ name?: unknown; browser_download_url?: unknown }>).find(
      (a) => isInstallerAsset(a?.name)
    );

    const url = installer?.browser_download_url;
    if (typeof url !== "string" || !url.startsWith("https://")) return toReleasesPage();

    const response = NextResponse.redirect(url, { status: 302 });
    // Cache the REDIRECT at the CDN too, so a burst of clicks doesn't each cost
    // a GitHub API call. Kept off the browser (`max-age=0`) so a user who
    // downloads, waits for a new release, and clicks again gets the new one.
    response.headers.set("Cache-Control", `public, max-age=0, s-maxage=${CACHE_SECONDS}`);
    return response;
  } catch {
    // Network failure, DNS, timeout, malformed JSON — all the same to the user.
    return toReleasesPage();
  }
}
