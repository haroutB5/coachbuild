import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import CompanionProvider from "@/components/live/CompanionProvider";
import AutoExporter from "@/components/live/AutoExporter";
import BuildPrewarmer from "@/components/live/BuildPrewarmer";
import AppShell from "@/components/hextech/AppShell";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CoachBuild — Runes & Items by champion + lane",
  description:
    "Highest win-probability runes, shards, items and summoners for any champion and lane. Data from coachless.gg (WPA).",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CoachBuild",
  },
  // Standard (non-Apple-prefixed) mobile-web-app-capable meta tag — Chrome
  // deprecated bare reliance on `apple-mobile-web-app-capable` and logs a
  // console warning without this one present too. `metadata.other` is the
  // App Router's escape hatch for meta tags the typed `Metadata` fields
  // don't cover; the apple-prefixed tag above stays for iOS Safari.
  other: {
    "mobile-web-app-capable": "yes",
    // The version of the web app in THIS document, for the desktop companion
    // to read out of its own WebView2 window (see app/api/app-version/route.ts
    // for why it has to). Same source as the footer and the service-worker
    // cache name: package.json -> next.config.mjs -> NEXT_PUBLIC_APP_VERSION.
    // A meta tag rather than a global because it is present before hydration,
    // so the host can read it the moment navigation completes.
    "coachbuild-version": process.env.NEXT_PUBLIC_APP_VERSION ?? "",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0d0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased font-sans">
        {/* v0.37.0 (Draft recommender, plan §6c): CompanionProvider now owns
            THE single app-wide companion status poll — see its own header
            comment for the split of responsibility with app/page.tsx's
            follow effect. Wrapping at the root (not just "/") is what lets
            /draft react to the same live session without a second poller. */}
        {/* v0.41.0 (champ-select auto-export lift): AutoExporter mounts inside
            CompanionProvider so it reacts to the SAME app-wide /status poll on
            EVERY route — the fix for auto-export never firing when the user
            drafts from /draft (which suppresses opening the Builds page, where
            the exporter used to live). Exactly one owner app-wide; see
            components/live/autoExport.ts's header. */}
        {/* v0.50.0 (global nav redesign): AppShell now owns the branded left
            rail (desktop) + bottom tab bar (mobile) that replace the old
            per-page TabNav + Builds-only hextech Sidebar + MobileNavMenu.
            Stays INSIDE CompanionProvider so the rail's companion status
            card can read the same app-wide useCompanion() poll every other
            live-aware surface already uses. */}
        <CompanionProvider>
          <AppShell>{children}</AppShell>
          <AutoExporter />
          {/* v0.111.0: warms the champ-select champion's build into
              lib/buildCache.ts before the user opens the Builds page. Renders
              nothing and never touches page state — see its own header. */}
          <BuildPrewarmer />
        </CompanionProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
