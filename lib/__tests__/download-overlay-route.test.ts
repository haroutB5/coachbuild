// ─────────────────────────────────────────────────────────────────────────────
// download-overlay-route.test.ts
//
// WHY THIS FILE EXISTS.
//
// On 2026-07-27, minutes after overlay v0.4.1 was published, the live download
// button served **v0.2.0** — three releases stale. The route was not hardcoded
// and had no bug in the usual sense; it asked GitHub's `/releases/latest`, and
// GitHub answered with an old release.
//
// The mechanism: GitHub documents "latest" as the most recent non-draft,
// non-prerelease release *sorted by the `created_at` of the underlying git tag*.
// The overlay releases repo holds BINARIES ONLY — effectively one commit, with
// every tag pointing at it — so all five tags carried the identical `created_at`
// (2026-07-27T17:43:01Z). With a five-way tie the winner is arbitrary, and it
// genuinely differed between two callers in the same minute.
//
// So these tests are built around payloads where `created_at` is USELESS and
// array order is MISLEADING. A route that trusts either fails here.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";

/** Every tag shares this timestamp — the exact condition that broke production. */
const TIE = "2026-07-27T17:43:01Z";

function release(
  tag: string,
  opts: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {}
) {
  const assets = (opts.assets ?? [
    `CoachBuild-Overlay-Setup-${tag.replace(/^v/, "")}.exe`,
    `CoachBuild-Overlay-Setup-${tag.replace(/^v/, "")}.exe.blockmap`,
    `CoachBuild-Overlay-${tag.replace(/^v/, "")}-portable.exe`,
    "latest.yml",
  ]).map((name) => ({
    name,
    browser_download_url: `https://github.com/haroutB5/coachbuild-overlay-releases/releases/download/${tag}/${name}`,
  }));
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    created_at: TIE,
    assets,
  };
}

function mockGitHub(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)
  );
}

async function callRoute(): Promise<Response> {
  const { GET } = await import("@/app/api/download/overlay/route");
  return (await GET()) as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("GET /api/download/overlay", () => {
  it("picks the highest SEMVER, not the array order — the production regression", () => {
    // v0.2.0 FIRST in the array and every created_at identical: exactly the
    // payload shape that served a stale installer to real users.
    mockGitHub([
      release("v0.2.0"),
      release("v0.4.1"),
      release("v0.3.1"),
      release("v0.4.0"),
      release("v0.3.0"),
    ]);
    return callRoute().then((res) => {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/v0.4.1/");
      expect(res.headers.get("location")).toContain("CoachBuild-Overlay-Setup-0.4.1.exe");
    });
  });

  it("compares numerically, not lexically — v0.10.0 beats v0.9.0", () => {
    // A string sort puts "v0.9.0" above "v0.10.0". This is the bug that would
    // replace the current one the first time a minor version reaches double
    // digits, which is 5 releases away.
    mockGitHub([release("v0.9.0"), release("v0.10.0")]);
    return callRoute().then((res) => {
      expect(res.headers.get("location")).toContain("/v0.10.0/");
    });
  });

  it("never serves a DRAFT, even when it is the highest version", () => {
    // A draft is invisible to the public; linking one gives a 404.
    mockGitHub([release("v0.4.1"), release("v0.9.9", { draft: true })]);
    return callRoute().then((res) => {
      expect(res.headers.get("location")).toContain("/v0.4.1/");
    });
  });

  it("never serves a PRERELEASE, even when it is the highest version", () => {
    mockGitHub([release("v0.4.1"), release("v0.5.0", { prerelease: true })]);
    return callRoute().then((res) => {
      expect(res.headers.get("location")).toContain("/v0.4.1/");
    });
  });

  it("skips an unparseable tag rather than ranking it", () => {
    // A release we cannot rank is one we cannot honestly call newest.
    mockGitHub([release("nightly"), release("v0.4.1"), release("latest")]);
    return callRoute().then((res) => {
      expect(res.headers.get("location")).toContain("/v0.4.1/");
    });
  });

  it("returns the INSTALLER, never the blockmap or the portable build", () => {
    // `...Setup-0.4.1.exe.blockmap` also contains "Setup" and ".exe"; handing a
    // user a blockmap looks like a corrupt download rather than a wrong file.
    mockGitHub([release("v0.4.1")]);
    return callRoute().then((res) => {
      const loc = res.headers.get("location") ?? "";
      expect(loc).toMatch(/CoachBuild-Overlay-Setup-0\.4\.1\.exe$/);
      expect(loc).not.toContain(".blockmap");
      expect(loc).not.toContain("portable");
    });
  });

  it("falls back to the releases PAGE when no release has an installer", () => {
    mockGitHub([release("v0.4.1", { assets: ["latest.yml", "notes.txt"] })]);
    return callRoute().then((res) => {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://github.com/haroutB5/coachbuild-overlay-releases/releases/latest"
      );
    });
  });

  it("falls back to the releases PAGE on a non-ok response, an empty list, and a reshaped payload", async () => {
    const PAGE = "https://github.com/haroutB5/coachbuild-overlay-releases/releases/latest";

    mockGitHub({ message: "rate limited" }, false);
    expect((await callRoute()).headers.get("location")).toBe(PAGE);

    vi.resetModules();
    mockGitHub([]);
    expect((await callRoute()).headers.get("location")).toBe(PAGE);

    vi.resetModules();
    // Not an array — the old code read `.assets` off an object; this pins that
    // a reshaped payload degrades instead of throwing.
    mockGitHub({ tag_name: "v0.4.1", assets: [] });
    expect((await callRoute()).headers.get("location")).toBe(PAGE);
  });

  it("degrades to the releases PAGE when the fetch throws outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND api.github.com");
      })
    );
    const res = await callRoute();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/haroutB5/coachbuild-overlay-releases/releases/latest"
    );
  });
});
