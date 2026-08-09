import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Existing aliases — values mirror app/globals.css so untouched
        // Tailwind call sites pick up the Nocturne reskin automatically.
        bg: "#161826",
        sidebar: "#12141f",
        panel: "#232532",
        "panel-glass": "#1b1d2a",
        panel2: "#1c1e2c",
        line: "rgba(233,233,237,.16)",
        "line-gold": "rgba(145,132,217,.22)",
        teal: "#9184d9",
        "teal-hover": "#b5abfc",
        "teal-dim": "#5d5294",
        lavender: "#a7a1db",
        gold: "#9184d9",
        txt: "#e9e9ed",
        mut: "#9397ab",
        // Positive/negative performance data only — never decorative.
        good: "#46c79b",
        bad: "#e8736e",
        win: "#46c79b",
        loss: "#e8736e",

        // Canonical Nocturne color tokens and ramps.
        surface: "#232532",
        text: "#e9e9ed",
        divider: "rgba(233,233,237,.16)",
        accent: {
          DEFAULT: "#9184d9",
          100: "#f5f4ff",
          200: "#e7e5fe",
          300: "#d2cefd",
          400: "#b5abfc",
          500: "#968ae0",
          600: "#796cbf",
          700: "#5d5294",
          800: "#423a6a",
          900: "#2b2741",
        },
        "accent-2": {
          DEFAULT: "#a7a1db",
          100: "#f5f4ff",
          200: "#e7e5fe",
          300: "#d2cefd",
          400: "#b5afe8",
          500: "#9690c9",
          600: "#7972a9",
          700: "#5c5783",
          800: "#423e5d",
          900: "#2b293a",
        },
        neutral: {
          100: "#f3f5fe",
          200: "#e4e7f5",
          300: "#cfd3e5",
          400: "#b2b6ca",
          500: "#9397ab",
          600: "#75798c",
          700: "#595d6c",
          800: "#3f424d",
          900: "#292b31",
        },
        section: "#262a60",
        "section-glow": "#353b80",
        "section-ghost": "#4c5397",
      },
      fontFamily: {
        sans: [
          "var(--font-body)",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: ["var(--font-heading)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
