import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";
import { getBasePath } from "./src/config/base-path";
import { getPwaConfig } from "./src/config/pwa";

const basePath = getBasePath();

const withPWA = withPWAInit(getPwaConfig(process.env.NODE_ENV ?? "development"));

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    // Polyfill `global` for Nostr/Node.js-oriented libraries
    const webpack = require("webpack");
    config.plugins.push(
      new webpack.DefinePlugin({
        global: "globalThis",
      }),
    );
    return config;
  },
};

export default withPWA(nextConfig);
