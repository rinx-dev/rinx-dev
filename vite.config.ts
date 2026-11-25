import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import solid from "@solidjs/vite-plugin"
import { build } from "rolldown"
import { cloudflare } from "@cloudflare/vite-plugin"

// "virtual:first-frame" is src/firstFrame.ts bundled to a minified IIFE string. Document.tsx
// inlines it, so the wordmark paints before the app bundle has loaded.
const firstFrame = (): Plugin => ({
  name: "first-frame",
  resolveId: (id) => (id === "virtual:first-frame" ? "\0first-frame" : null),
  async load(id) {
    if (id !== "\0first-frame") return null
    const out = await build({ input: "src/firstFrame.ts", write: false, output: { format: "iife", minify: true } })
    // Rebuild in dev when anything the script bundles changes.
    for (const file of out.output[0].moduleIds) this.addWatchFile(file)
    return `export default ${JSON.stringify(out.output[0].code.trim())}`
  },
})

// Production builds ship the /* glsl */ template strings without comments, indentation or
// blank lines. Lines stay separate, so preprocessor lines (#version) are untouched; dev
// keeps the full source so compile errors point at readable lines.
const minifyGlsl = (): Plugin => ({
  name: "minify-glsl",
  apply: "build",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/dither/shaders.ts")) return null
    return code.replace(/\/\* glsl \*\/ `((?:\\[\s\S]|[^`\\])*)`/g, (_, body: string) => {
      const lines = body
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").trim())
        .filter(Boolean)
      return "`" + lines.join("\n") + "\n`"
    })
  },
})

// 404.html: the prerendered shell marked <html data-page="404">, so the same app draws
// "404" over the dunes (src/page.ts). Cloudflare serves it, with status 404, for any path
// without a file (notFoundHandling "404-page" in cloudflare.config.ts). Runs after the
// Solid plugin has prerendered index.html.
const notFoundPage = (): Plugin => ({
  name: "not-found-page",
  apply: "build",
  buildApp: {
    order: "post",
    async handler(builder) {
      const client = builder.environments.client.config
      const dir = resolve(client.root, client.build.outDir)
      const html = readFileSync(resolve(dir, "index.html"), "utf8")
      const page = html
        .replace('<html lang="en">', '<html lang="en" data-page="404">')
        .replace("<title>rinx.dev</title>", "<title>404 · rinx.dev</title>")
      if (page === html || !page.includes('data-page="404"')) throw new Error("[not-found-page] index.html shell changed; update the replacements")
      writeFileSync(resolve(dir, "404.html"), page)
    },
  },
})

// Dev only: the dev server answers every path with the page shell (status 200), and
// 404.html only exists in a build. Answer unknown pages with 404 like Cloudflare does;
// src/page.ts then draws the 404 page for any path other than "/".
const devNotFound = (): Plugin => ({
  name: "dev-not-found",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "/").split("?")[0]
      const isPage =
        req.method === "GET" &&
        !!req.headers.accept?.includes("text/html") &&
        path !== "/" &&
        path !== "/index.html" &&
        !path.startsWith("/@") &&
        !path.startsWith("/cdn-cgi/") &&
        !/\.[a-z0-9]+$/i.test(path)
      if (isPage) {
        res.statusCode = 404
        const writeHead = res.writeHead
        res.writeHead = function (this: typeof res, code: number, ...rest: unknown[]) {
          return (writeHead as (...a: unknown[]) => typeof res).call(this, code === 200 ? 404 : code, ...rest)
        } as typeof res.writeHead
      }
      next()
    })
  },
})

export default defineConfig({
  // cloudflare() builds for an assets-only Worker described in cloudflare.config.ts.
  plugins: [devNotFound(), firstFrame(), minifyGlsl(), solid({ start: true }), cloudflare(), notFoundPage()],
  server: { port: 3000 },
  build: { target: "esnext" },
})
