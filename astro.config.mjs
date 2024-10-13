import { defineConfig } from "astro/config";

import cloudflare from "@astrojs/cloudflare";

import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  output: "server",
  site: "https://rinx.dev",
  base: "/",
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [
    sitemap({
      lastmod: new Date("2024-10-08"), // YYYY-MM-DD
    }),
  ],
});
