import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
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
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#131619",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={plusJakarta.variable}>
      <body className="antialiased font-sans">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
