import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // GPT-6's review probes, kept byte for byte (the gate pins their sha256 and runs them): CommonJS, not ours to restyle.
    "scripts/probes/gpt6-*/**",
  ]),
]);

export default eslintConfig;
