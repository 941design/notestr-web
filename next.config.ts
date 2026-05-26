import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";
import { getBasePath } from "./src/config/base-path";
import { getPwaConfig } from "./src/config/pwa";

const basePath = getBasePath();

const withPWA = withPWAInit(getPwaConfig(process.env.NODE_ENV ?? "development"));

// The E2E build dev-links marmot-ts via a `file:/tmp/marmot-ts/dist` dep,
// which drags a *second physical copy* of `ts-mls` into the tree. `ts-mls`
// uses branded (nominal) types, so two copies of the same version produce
// types that won't unify — the build-time typecheck then fails with spurious
// cross-copy errors even though the emitted bundle is correct. Skip the
// typecheck/lint gate for E2E builds ONLY (production builds never set
// NEXT_PUBLIC_E2E, so they stay strict; `make test` / tsc still cover types).
const isE2E = process.env.NEXT_PUBLIC_E2E === "1";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  images: {
    unoptimized: true,
  },
  typescript: { ignoreBuildErrors: isE2E },
  eslint: { ignoreDuringBuilds: isE2E },
  webpack: (config) => {
    // Polyfill `global` for Nostr/Node.js-oriented libraries
    const webpack = require("webpack");
    config.plugins.push(
      new webpack.DefinePlugin({
        global: "globalThis",
      }),
    );
    // `ts-mls` declares several HPKE/PQC crypto backends as optional peer
    // dependencies and gates them behind `try { await import(...) }` inside
    // switch statements keyed on ciphersuite. Marmot uses ChaCha20-Poly1305
    // + X25519 so none of these branches are ever reached at runtime, but
    // webpack still statically resolves the dynamic import targets during
    // bundling — on macOS (strict) that turns "Compiled with warnings" into
    // hard "Module not found" errors. IgnorePlugin makes webpack treat them
    // as missing, which preserves the existing try/catch fallback to
    // DependencyError if some caller ever does opt into one of these suites.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp:
          /^(@hpke\/dhkem-x448|@hpke\/ml-kem|@hpke\/hybridkem-x-wing|@noble\/post-quantum\/ml-dsa\.js)$/,
      }),
    );
    return config;
  },
};

export default withPWA(nextConfig);
