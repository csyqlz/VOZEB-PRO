import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
    ...nextVitals,
    ...nextTypescript,
    {
        rules: {
            "react-hooks/immutability": "off",
            "react-hooks/preserve-manual-memoization": "off",
            "react-hooks/purity": "off",
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/static-components": "off",
            "react-hooks/use-memo": "off",
        },
    },
    globalIgnores([".next/**", ".next-*/**", ".e2e-artifacts/**", ".e2e-data/**", "coverage/**", "node_modules/**", "public/**"]),
]);
