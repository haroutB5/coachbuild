import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // Was ["lib/__tests__/**/*.test.ts", "components/__tests__/**/*.test.ts"]
    // -- silently missed nested __tests__ dirs (components/hextech/GlobalNav/
    // __tests__/*.test.ts, added v0.50.0): activeNav.test.ts,
    // companionStatusModel.test.ts, and navItems.test.ts (3 files) were never
    // being collected by `npx vitest run` even though they exist, import
    // cleanly, and pass when targeted directly. Widened to `**/__tests__/**`
    // so any depth of nesting under lib/ or components/ is picked up; the v0.51
    // GlobalNav additions (champSelectChipModel.test.ts, navBadgeModel.test.ts)
    // land in that same nested directory and need this fix to actually run.
    include: ["lib/**/__tests__/**/*.test.ts", "components/**/__tests__/**/*.test.ts"],
  },
});
