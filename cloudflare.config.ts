import { defineConfig } from "cf/config"

// Assets-only Worker: no script, so every request is a static-asset hit. The assets are
// Vite's client build, which @cloudflare/vite-plugin (vite.config.ts) hands to cf.
export default defineConfig({
  worker: {
    name: "rinx-dev",
    compatibilityDate: "2026-11-24",
    // Production traffic on the apex domain; the zone must be on this Cloudflare account.
    domains: ["rinx.dev"],
    assets: {
      notFoundHandling: "404-page",
    },
  },
})
