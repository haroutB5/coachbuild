import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([{
    extends: [...nextCoreWebVitals],
    rules: {
        // React hooks v6 modernization (2026-08-06): both compiler-safety
        // rules are enforced. The 16 deliberate set-state-in-effect exceptions
        // have inline rationales: SSR/deep-link hydration (app/compact,
        // app/live-setup, app/page, ServiceWorkerRegister, AccountPicker),
        // request hand-offs (app/compact, app/movers, BuildTabContent),
        // transition timing (DetailPopover, GameDetailSheet, BuildTabContent),
        // DOM geometry (ChampionPicker, TopBar, ThemedSelect), and the
        // byte-identical-pinned draft request state machines (app/draft).
        // react-hooks/refs has no per-site exception.
        "react-hooks/set-state-in-effect": "error",
        "react-hooks/refs": "error",
    },
}]);
