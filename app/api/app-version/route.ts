import { NextResponse } from "next/server";

/** The version of the web app THIS deployment is serving.
 *
 *  Exists for the desktop companion, not for the browser. The WebView2 window
 *  it hosts is long-lived — the desktop only navigates it when no follow
 *  attachment is live (`FollowAttachmentTracker.IsAnyAttached`), and a page
 *  that is polling /status is permanently attached, so a window opened before
 *  a deploy keeps running that deploy's JS until it is closed. On 2026-08-19
 *  that cost a user the entire 0.112.0 release: they entered champ select 18
 *  minutes after it went live and their window was still executing 0.111.0,
 *  which nothing on either side could see.
 *
 *  The desktop now reads this on window open and on champ-select entry,
 *  compares it against the version the loaded document reports (the
 *  `coachbuild-version` meta tag in app/layout.tsx — SAME source, `pkg.version`
 *  via next.config.mjs), logs both, and re-navigates when they differ.
 *
 *  `no-store` and `force-dynamic` are the whole point: a cached answer here
 *  would report the version of whichever deployment served the cache entry,
 *  which is exactly the failure this endpoint exists to detect. Kept
 *  deliberately tiny — it is polled by every installed desktop app on every
 *  champ select. */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? null },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
