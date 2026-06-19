import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0e14",
        panel: "#11161f",
        panel2: "#161d28",
        line: "#222c3a",
        teal: "#2dd4bf",
        "teal-dim": "#1d9c8c",
        txt: "#e7edf5",
        mut: "#8a97a8",
        good: "#3ddc84",
        bad: "#ff5d6c",
        gold: "#c8aa6e",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
