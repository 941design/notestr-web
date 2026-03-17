import type { MetadataRoute } from "next";
import { getBasePath } from "@/config/base-path";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const basePath = getBasePath();

  return {
    name: "notestr — encrypted task manager",
    short_name: "notestr",
    description: "Encrypted task manager on Nostr with MLS groups",
    theme_color: "#0d1117",
    background_color: "#0d1117",
    display: "standalone",
    scope: `${basePath}/`,
    start_url: `${basePath}/`,
    icons: [
      {
        src: `${basePath}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
