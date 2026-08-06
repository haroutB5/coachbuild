import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([{
    extends: [...nextCoreWebVitals],
    rules: {
        // Next-16 migration (2026-08-06): eslint-plugin-react-hooks v6 ships two
        // new React-Compiler-era rules that the pre-migration config never
        // enforced. 63 pre-existing call sites trip them. Disabled to keep the
        // lint contract identical across the upgrade; re-enabling them is a
        // deliberate modernization pass of its own, not a migration side effect.
        "react-hooks/set-state-in-effect": "off",
        "react-hooks/refs": "off",
    },
}]);
