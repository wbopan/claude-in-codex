import path from "node:path";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["packages/**/*.ts", "tests/**/*.ts"];
const javaScriptFiles = [
  "*.config.js",
  "packages/**/scripts/**/*.mjs",
  "packages/**/test/**/*.mjs",
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
