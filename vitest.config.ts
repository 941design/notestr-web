import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // S3's diagnostic harness classifier (e2e/fixtures/mls-trace-classify.ts)
      // is unit-tested via vitest per AC-DIAG-5. The classifier is a pure
      // module so it runs in node/vitest without the Playwright runner.
      "e2e/fixtures/**/*.test.ts",
    ],
  },
});
