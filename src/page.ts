// Which page this is. There is one app; the build also writes 404.html (vite.config.ts),
// the same shell marked <html data-page="404">, which Cloudflare serves for unknown paths.
// The site has a single page, so any other path is "not found": that also covers the dev
// server (`cf dev` / `bun run dev`), which answers every path with the shell.
// Shared by the inline first frame and the app, so both draw the same word the same way.
import type { LayoutOptions } from "./wordmark"
import type { SceneId } from "./dither/shaders"

export interface Page {
  notFound: boolean
  /** The big pixel word in the middle. */
  word: string
  layout: LayoutOptions
  /** A fixed background (no scene picker), or null for the visitor's choice. */
  scene: SceneId | null
  /** Cacti in the Dunes (the 404 page). */
  cacti: boolean
}

export function currentPage(): Page {
  const notFound = document.documentElement.dataset.page === "404" || location.pathname !== "/"
  return notFound
    ? { notFound, word: "404", layout: { sizeLike: "rinx.dev" }, scene: "dunes", cacti: true }
    : { notFound, word: "rinx.dev", layout: {}, scene: null, cacti: false }
}
