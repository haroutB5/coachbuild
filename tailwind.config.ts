import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#131619",
        panel: "#1a1d21",
        "panel-glass": "rgba(26,29,33,0.55)",
        panel2: "#202329",
        line: "rgba(255,255,255,0.08)",
        // Primary accent — soft cyan (was teal). Key name kept as `teal` so
        // every existing text-teal/bg-teal/border-teal-dim call site picks
        // up the new palette without a site-wide rename.
        teal: "#82dbf7",
        "teal-hover": "#a1e4f9",
        "teal-dim": "#4fa3c4",
        // Secondary accent — soft lavender (was `gold`, League's pro-badge
        // gold). Kept both keys: `lavender` is the token going forward,
        // `gold` aliases it so untouched call sites still resolve.
        lavender: "#deccfb",
        gold: "#deccfb",
        txt: "#e8e8e8",
        mut: "#9099a3",
        // WPA / winrate / performance-score signal ONLY — never decorative.
        good: "#4ade80",
        bad: "#f87171",
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
      },
    },
  },
  plugins: [],
};

export default config;
