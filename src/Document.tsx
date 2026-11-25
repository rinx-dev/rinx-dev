import type { ParentProps } from "solid-js"
import { HydrationScript } from "@solidjs/web"
import firstFrame from "virtual:first-frame"

// A 16×16 pixel "r" favicon.
const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">` +
      `<rect width="16" height="16" fill="#0b0b0b"/>` +
      `<path fill="#ecebe6" d="M4 3h3v10H4zM7 5h2v2H7zM9 3h3v3H9z"/>` +
      `</svg>`,
  )

const themeScript =
  `try{var t=localStorage.getItem("rinx-theme")}catch(e){}` +
  `if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";` +
  `document.documentElement.dataset.theme=t;` +
  `document.querySelector('meta[name="theme-color"]').setAttribute("content",t==="light"?"#f3f2ee":"#0b0b0b")`

// The document shell (replaces index.html), picked up by @solidjs/vite-plugin's start mode.
export default function Document(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>rinx.dev</title>
        <meta name="description" content="rinx.dev" />
        <meta name="theme-color" content="#0b0b0b" />
        {/* Apply the saved or system theme before first paint, so there's no flash. */}
        <script innerHTML={themeScript} />
        <meta property="og:title" content="rinx.dev" />
        <meta property="og:description" content="rinx.dev" />
        <link rel="icon" href={favicon} />
        <HydrationScript />
      </head>
      <body>
        {/* The settled wordmark, painted by an inline script before the bundle loads. */}
        <canvas
          id="ff"
          aria-hidden="true"
          style="position:fixed;top:0;left:0;z-index:1;image-rendering:pixelated;pointer-events:none"
        />
        <script innerHTML={firstFrame} />
        {props.children}
      </body>
    </html>
  )
}
