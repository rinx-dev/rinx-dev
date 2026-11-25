import type { SceneId } from "./dither/shaders"
import { ROWS, setLine } from "./wordmark"

// Tiny 1-bit thumbnails of each background, drawn the same way as the page: a
// brightness field per pixel, quantized with a Bayer matrix. Each one becomes a
// single SVG path of lit pixels filled with currentColor, so it stays crisp at
// any DPR and follows the theme through CSS.

type Field = (x: number, y: number) => number // pixel centre, y down, returns 0..1

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** Lit pixels as one path: horizontal runs, so a 24×16 icon is a few dozen rectangles. */
const pixelPath = (w: number, h: number, field: Field) => {
  let d = ""
  for (let y = 0; y < h; y++) {
    let run = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && field(x + 0.5, y + 0.5) > (BAYER4[y & 3][x & 3] + 0.5) / 16
      if (on && run < 0) run = x
      if (!on && run >= 0) {
        d += `M${run} ${y}h${x - run}v1h${run - x}z`
        run = -1
      }
    }
  }
  return d
}

const W = 24
const H = 16
const disc = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) < r
const tent = (x: number, cx: number, half: number) => Math.max(0, 1 - Math.abs(x - cx) / half)
const glow = (y: number, horizon: number, peak: number, falloff: number) =>
  y < horizon ? peak * Math.exp(-(horizon - y) / falloff) : 0
const has = (points: [number, number][], x: number, y: number) =>
  points.some(([px, py]) => Math.floor(x) === px && Math.floor(y) === py)

/** The wordmark as a small solid bar, with clear space around it, like the page. */
const withTitle = (scene: Field): Field => (x, y) => {
  if (y > 7 && y < 8 && x > 8 && x < 16) return 1
  if (y > 6 && y < 9 && x > 7 && x < 17) return 0
  return scene(x, y)
}

const SKY_STARS: [number, number][] = [[2, 2], [8, 1], [13, 3], [4, 4], [22, 1], [16, 0], [10, 4]]

const FIELDS: Record<SceneId, Field> = {
  plain: () => 0,
  ocean: (x, y) => {
    const hz = 11
    if (y < hz) {
      if (disc(x, y, 19.5, 3.2, 2.3)) return 1
      if (has(SKY_STARS, x, y)) return 1
      return glow(y, hz, 0.5, 1.4)
    }
    if (y < hz + 1) return 0.9 // horizon line
    // Moon path: widens toward the viewer, broken into glints.
    if (Math.abs(x - 19.5) < 0.6 + (y - hz) * 0.35) return (Math.floor(x) + Math.floor(y)) % 2 ? 0.25 : 1
    const row = Math.floor(y)
    if (row === 13 || row === 15) return (Math.floor(x) + row * 3) % 7 < 3 ? 0.7 : 0
    return 0
  },
  peaks: (x, y) => {
    const near = 14.4 - 1.8 * tent(x, 11, 5) - 1.4 * tent(x, 18, 4)
    if (y > near) return 0
    // Tall peaks sit either side of the wordmark, so its clear space can't erase them.
    const far = 12.5 - 7.5 * tent(x, 4.5, 5) - 6 * tent(x, 20, 4.5) - 2 * tent(x, 12.5, 4)
    if (y > far) return y < far + 1.6 ? 1 : 0.5 // lit ridge, checker slopes
    return glow(y, 12.5, 0.35, 2)
  },
  dunes: (x, y) => {
    const near = 13.6 + 1.3 * Math.sin(x * 0.33 + 2.5)
    if (y > near) return Math.cos(x * 0.33 + 2.5) < 0 && y < near + 1.2 ? 0.6 : 0
    const far = 11.6 + 0.8 * Math.sin(x * 0.55 + 1)
    if (y > far) return Math.cos(x * 0.55 + 1) < 0 ? 0.45 : 0.06
    if (disc(x, y, 18.5, 9.8, 2.4)) return 1
    return glow(y, 12, 0.6, 2)
  },
  night: (x, y) => {
    const hill = 12.6 + 1.1 * Math.sin(x * 0.42 + 0.6)
    if (y > hill) return 0
    if (has([[3, 9], [21, 10], [12, 10], [17, 9], [7, 11], [1, 6], [23, 5]], x, y)) return 1
    // Aurora: vertical rays along the top, fading downward.
    if (y < 5) {
      const ray = (Math.floor(x) * 7) % 5 < 2 ? 0.85 : 0.3
      return ray * (1 - y / 5)
    }
    return y > hill - 1 ? 0.25 : 0
  },
}

const SCENE_PATHS = Object.fromEntries(
  Object.entries(FIELDS).map(([id, field]) => [id, pixelPath(W, H, withTitle(field))]),
) as Record<SceneId, string>

export function SceneIcon(props: { scene: SceneId }) {
  return (
    <svg
      class="pixel-icon"
      viewBox={`0 0 ${W} ${H}`}
      width={W * 2}
      height={H * 2}
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <path d={SCENE_PATHS[props.scene]} fill="currentColor" />
    </svg>
  )
}

// Theme icon: a 12×12 disc, one half solid and the other half dithered, inside a ring.
const THEME_PATH = pixelPath(12, 12, (x, y) => {
  const d = Math.hypot(x - 6, y - 6)
  if (d > 5.4) return 0
  if (d > 4.4) return 1
  return x < 6 ? 1 : 0.5
})

export function ThemeIcon() {
  return (
    <svg class="pixel-icon theme-icon" viewBox="0 0 12 12" width="24" height="24" shape-rendering="crispEdges" aria-hidden="true">
      <path d={THEME_PATH} fill="currentColor" />
    </svg>
  )
}

// The wordmark in miniature, from the same glyph grids: 2 px per unit, stroke cells solid
// and shaded cells as a 1 px checker, like the big one. Used for the 404 page's way home.
const MINI = setLine("rinx.dev")
const MINI_PATH = MINI.cells
  .map((c) => {
    const x = c.col * 2
    const y = c.row * 2
    return c.shade ? `M${x} ${y + 1}h1v1h-1zM${x + 1} ${y}h1v1h-1z` : `M${x} ${y}h2v2h-2z`
  })
  .join("")

export function WordIcon() {
  return (
    <svg
      class="pixel-icon word-icon"
      viewBox={`0 0 ${MINI.width * 2} ${ROWS * 2}`}
      width={MINI.width * 2}
      height={ROWS * 2}
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <path d={MINI_PATH} fill="currentColor" />
    </svg>
  )
}
