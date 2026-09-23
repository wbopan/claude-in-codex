import path from "node:path";

import { defineConfig } from "vitest/config";

const TEST_FILES = ["packages/**/test/**/*.test.ts", "tools/**/*.test.mjs"];
// Opt-in tests against a real Claude or Hermes install. Each file skips itself unless its
// CLAUDE_IN_CODEX_RUN_*=1 variable is set, and it needs the real HOME for credentials.
const REAL_FILES = ["**/*.real.test.ts", "**/*.real.test.mjs"];
// Tests that start a Host, spawn processes or otherwise take seconds rather than milliseconds.
const INTEGRATION_FILES = ["packages/**/test/integration/**/*.test.ts"];
const ISOLATE_HOME = "tests/setup/isolate-home.ts";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  build: {
    assetsInlineLimit: 100000,
  },
  test: {
    environment: "node",
    maxWorkers: 4,
    passWithNoTests: false,
    // A stray `.only` would silently run one test in CI.
    allowOnly: !process.env.CI,
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: TEST_FILES,
          exclude: [...REAL_FILES, ...INTEGRATION_FILES],
          setupFiles: [ISOLATE_HOME],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: INTEGRATION_FILES,
          exclude: REAL_FILES,
          setupFiles: [ISOLATE_HOME],
        },
      },
      {
        extends: true,
        test: {
          name: "real",
          include: REAL_FILES,
        },
      },
    ],
  },
});
