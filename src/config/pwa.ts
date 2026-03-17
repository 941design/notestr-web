import { getBasePath } from "./base-path";

/**
 * PWA configuration for @ducanh2912/next-pwa.
 *
 * Disabled in development because the generated sw.js references SWC helpers
 * (_async_to_generator, _ts_generator) that are not available at runtime
 * in the service worker context.
 */
export function getPwaConfig(nodeEnv: string) {
  const basePath = getBasePath();

  return {
    dest: "public" as const,
    register: true,
    scope: `${basePath}/`,
    sw: "sw.js",
    disable: nodeEnv !== "production",
    workboxOptions: {
      runtimeCaching: [
        {
          urlPattern: /^wss?:\/\/.*/,
          handler: "NetworkOnly" as const,
        },
      ],
    },
  };
}
