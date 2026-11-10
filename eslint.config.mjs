import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "test_artifacts/",
      "playwright-report/",
      "results/",
      "test-results/",
      // a byte-identical copy of the heal service's in-page script; it must not be edited (see test-heal-probe.spec.ts)
      "scripts/heal-probe.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node CLI scripts (heal.mjs etc.) — provide Node + fetch globals.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        Buffer: "readonly",
        TextDecoder: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
);
