import { defineConfig } from "vitest/config";

export default defineConfig({
  // S8 (react-engine-hooks) is this repo's first .tsx test file. tsconfig.json
  // sets "jsx": "preserve" (Next.js's own recommended value -- next build's
  // SWC/webpack pipeline does its own JSX transform and never reads tsc's
  // "jsx" setting for output, only for editor/tsc typechecking), which
  // Vite 8's default oxc transform inherits as "preserve" too, and then
  // refuses to parse the resulting JSX syntax ("Failed to parse source...
  // make sure to not set jsx to preserve"). Overriding ONLY oxc's own jsx
  // runtime here (not tsconfig.json, which next build and `tsc --noEmit`
  // both still read as "preserve") keeps this scoped to the vitest/Vite
  // test pipeline with zero effect on the Next.js build.
  oxc: {
    jsx: { runtime: "automatic" },
  },
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
