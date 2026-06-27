#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");

const cases = [
  { basePath: "", expectedBasePath: "" },
  { basePath: "/notestr/", expectedBasePath: "/notestr" },
];

// Concurrent `make test` invocations share rootDir's build artifacts
// (.next, out, public/sw.js). Without serialization, one run's
// cleanBuildArtifacts() rm -rf's .next/out mid-flight under another's
// `next build`, producing spurious "pages-manifest.json not found" failures.
// A directory-based mutex (atomic mkdir) serializes invocations; the normal
// single-invocation path acquires immediately and is unaffected.
const lockDir = path.join(rootDir, ".next-verify-export.lock");
const LOCK_STALE_MS = 10 * 60 * 1000; // a full two-case build is well under this
const LOCK_POLL_MS = 1000;
const LOCK_TIMEOUT_MS = 20 * 60 * 1000;

function sleepSync(ms) {
  // Block the process without busy-spinning.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Lock held. Take it over if it is stale (a crashed run left it behind).
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { force: true, recursive: true });
          continue;
        }
      } catch {
        continue; // Lock vanished between EEXIST and stat — retry immediately.
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          `verify-static-export: timed out waiting for build lock ${lockDir}`,
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function cleanBuildArtifacts() {
  rmSync(path.join(rootDir, "out"), { force: true, recursive: true });
  rmSync(path.join(rootDir, ".next"), { force: true, recursive: true });
  rmSync(path.join(publicDir, "sw.js"), { force: true });

  for (const entry of readdirSync(publicDir)) {
    if (entry.startsWith("workbox-") && entry.endsWith(".js")) {
      rmSync(path.join(publicDir, entry), { force: true });
    }
  }
}

function withBasePath(basePath, suffix) {
  const prefix = basePath ? `${basePath}` : "";
  return `${prefix}${suffix}`;
}

acquireLock();
try {
for (const { basePath, expectedBasePath } of cases) {
  cleanBuildArtifacts();

  execFileSync("npm", ["run", "build"], {
    cwd: rootDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_BASE_PATH: basePath,
      // E2E build: tells next.config.ts to skip typecheck/lint (marmot-ts
      // bundles its own copy of ts-mls; two copies of the same nominal types
      // version won't unify even with skipLibCheck, so we gate type errors
      // only for the exported build artifacts — the emitted JS is correct).
      NEXT_PUBLIC_E2E: "1",
    },
    stdio: "inherit",
  });

  const html = readFileSync(path.join(rootDir, "out", "index.html"), "utf8");
  const manifest = JSON.parse(
    readFileSync(path.join(rootDir, "out", "manifest.webmanifest"), "utf8"),
  );
  const sw = readFileSync(path.join(rootDir, "out", "sw.js"), "utf8");

  assert.match(
    html,
    new RegExp(withBasePath(expectedBasePath, "/_next/static")),
    `index.html should reference the expected asset prefix for ${basePath || "root build"}`,
  );
  assert.match(
    html,
    new RegExp(withBasePath(expectedBasePath, "/manifest\\.webmanifest")),
    `index.html should reference the expected manifest path for ${basePath || "root build"}`,
  );
  assert.match(
    html,
    new RegExp(withBasePath(expectedBasePath, "/favicon\\.svg")),
    `index.html should reference the expected favicon path for ${basePath || "root build"}`,
  );

  assert.equal(
    manifest.scope,
    withBasePath(expectedBasePath, "/"),
    `manifest scope should match ${basePath || "root build"}`,
  );
  assert.equal(
    manifest.start_url,
    withBasePath(expectedBasePath, "/"),
    `manifest start_url should match ${basePath || "root build"}`,
  );
  assert.equal(
    manifest.icons[0]?.src,
    withBasePath(expectedBasePath, "/icon.svg"),
    `manifest icon path should match ${basePath || "root build"}`,
  );

  assert.match(
    sw,
    new RegExp(withBasePath(expectedBasePath, "/_next/static")),
    `sw.js should precache the expected asset prefix for ${basePath || "root build"}`,
  );
  assert.match(
    sw,
    new RegExp(withBasePath(expectedBasePath, "/icon\\.svg")),
    `sw.js should precache the expected icon path for ${basePath || "root build"}`,
  );
}
} finally {
  rmSync(lockDir, { force: true, recursive: true });
}

