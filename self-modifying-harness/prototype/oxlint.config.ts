import { defineConfig } from "oxlint";
import gdp from "@gdp-ts/core/lint/oxlint";

// The gdp-ts preset returns { jsPlugins, overrides } (no rules/ignorePatterns),
// so merge it into the anti-slop config instead of replacing anything.
const gdpPreset = gdp({ proofs: ["src/proofs/**"] });

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    "node_modules/**",
    "data/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ...gdpPreset.jsPlugins,
  ],
  overrides: [
    ...gdpPreset.overrides,
    // Only the writers of the catalog document (and the tests that build one) may hold its token: every other module
    // changes the catalog through catalogue.ts, where each write demands a proof.
    {
      files: ["src/catalogue.ts", "src/proofs/**", "test/**"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/catalogue-doc.ts"],
            importNames: ["CellsDoc"],
            message: "The catalog document is written only by src/catalogue.ts (behind proofs) and read only by src/proofs.",
          },
        ],
      },
    ],
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
