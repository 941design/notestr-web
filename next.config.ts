import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  scope: "/notestr/",
  sw: "sw.js",
  workboxOptions: {
    runtimeCaching: [
      {
        urlPattern: /^wss?:\/\/.*/,
        handler: "NetworkOnly" as const,
      },
    ],
  },
});

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/notestr",
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
