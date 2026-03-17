#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");

const cases = [
  { basePath: "", expectedBasePath: "" },
  { basePath: "/notestr/", expectedBasePath: "/notestr" },
];

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

for (const { basePath, expectedBasePath } of cases) {
  cleanBuildArtifacts();

  execFileSync("npm", ["run", "build"], {
    cwd: rootDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_BASE_PATH: basePath,
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

