import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Hextech redesign (2026-07). bg/sidebar are near-black, green-
        // tinted (was charcoal). See app/globals.css's :root block for the
        // full rationale — token NAMES are kept from the prior era so every
        // untouched call site (RunePage, TabNav, /history, etc.) picks up
        // the new palette for free.
        bg: "#0a0d0b",
        sidebar: "#060807",
        panel: "#141916",
        "panel-glass": "rgba(20,25,22,0.6)",
        panel2: "#1a2019",
        line: "rgba(255,255,255,0.07)",
        "line-gold": "rgba(200,170,110,0.28)",
        // Primary accent — League Hextech gold (was cyan). Key name kept as
        // `teal` so every existing text-teal/bg-teal/border-teal-dim call
        // site picks up the new palette without a site-wide rename.
        teal: "#c8aa6e",
        "teal-hover": "#ddc48f",
        "teal-dim": "#8a7440",
        // Secondary accent — same gold family (was lavender). Kept both
        // keys: `lavender` is the token going forward, `gold` aliases it so
        // untouched call sites still resolve.
        lavender: "#c8aa6e",
        gold: "#c8aa6e",
        txt: "#ece7de",
        mut: "#838d84",
        // WPA / winrate / performance-score signal ONLY — never decorative.
        good: "#3ecf8e",
        bad: "#f2555a",
        // Pro Builds W/L badge fills — a hue distinct from the gold accent
        // so a badge never reads as "another gold thing." NOT for WPA/stat
        // text (that's good/bad above).
        win: "#2f9e86",
        loss: "#9c3b3b",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
