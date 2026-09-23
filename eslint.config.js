import path from "node:path";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["packages/**/*.ts", "tests/**/*.ts"];
const javaScriptFiles = [
  "*.config.js",
  "packages/**/scripts/**/*.mjs",
  "scripts/**/*.mjs",
  "tests/**/*.mjs",
  "tools/**/*.mjs",
];

export default [
  includeIgnoreFile(path.resolve(import.meta.dirname, ".gitignore")),
  {
    ...js.configs.recommended,
    files: javaScriptFiles,
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // `const { omitted, ...rest } = value` is how the code drops fields.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Probe functions are serialized and evaluated inside the Desktop renderer.
    files: ["tools/probes/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        __cxAcceptance: "writable",
        __cxConnection: "writable",
        __cxMenuTests: "writable",
        __cxNetPaths: "writable",
        __cxNetRestore: "writable",
      },
    },
  },
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: typeScriptFiles,
  })),
  {
    files: typeScriptFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
];
