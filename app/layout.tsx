import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Cinzel } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

// Hextech redesign (2026-07): gold serif display face for the wordmark,
// champion name, and any other large caps headline — closest free
// approximation to League's own Trajan-derived client typography. Body copy
// stays on Plus Jakarta Sans; Cinzel is opt-in per element via `font-display`
// (see tailwind.config.ts), never applied globally.
const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
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
    <html lang="en" className={`${plusJakarta.variable} ${cinzel.variable}`}>
      <body className="antialiased font-sans">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
