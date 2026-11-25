// Inlined into the HTML at build time and run before first paint, so the wordmark is on
// screen before the bundle loads. It is the start of the intro: the 1-px outline draws
// itself on (src/outline.ts, the same pixels in the same order as the shader), and keeps
// going until WebGL takes over mid-stroke and fills the letters in. With reduced motion
// there is no intro: it paints the settled word, a CPU port of the shader's Plain frame
// (time 0, no pointer). The WebGL canvas covers it once it has drawn.
import { layoutWordmark, ROWS, LINE_GAP, X_TOP, X_HEIGHT } from "./wordmark"
import { outlineThreshold, rasterize } from "./outline"
import { currentPage } from "./page"

// The intro's clock starts on the first frame that is actually shown (a tab opened in
// the background runs this script but no frames, and must not skip the draw-on). The
// renderer reads the same start from window.rinxIntroStart and continues from it.
let t0 = 0
const light = document.documentElement.dataset.theme === "light"
const settled = matchMedia("(prefers-reduced-motion: reduce)").matches
const ink = light ? [0xf3, 0xf2, 0xee] : [0x0b, 0x0b, 0x0b]
const paper = light ? [0x14, 0x14, 0x14] : [0xec, 0xeb, 0xe6]

// Same grid as DitherRenderer.resize().
const pixel = Math.min(innerWidth, innerHeight) < 700 ? 2 : 3
const dpr = devicePixelRatio || 1
const cell = Math.max(1, Math.round(pixel * dpr))
const W = Math.max(1, Math.ceil((innerWidth * dpr) / cell))
const H = Math.max(1, Math.ceil((innerHeight * dpr) / cell))
const page = currentPage()
const word = layoutWordmark(page.word, Math.round(innerWidth * dpr), Math.round(innerHeight * dpr), cell, page.layout)

const canvas = document.getElementById("ff") as HTMLCanvasElement
canvas.width = W
canvas.height = H
canvas.style.width = `${(W * cell) / dpr}px`
canvas.style.height = `${(H * cell) / dpr}px`
const ctx = canvas.getContext("2d")!
const img = ctx.createImageData(W, H)
const d = img.data
// One 32-bit write per pixel (RGBA bytes in memory order on little-endian hardware).
new Uint32Array(d.buffer).fill(((255 << 24) | (ink[2] << 16) | (ink[1] << 8) | ink[0]) >>> 0)

const { map, order } = rasterize(word, cell, W, H)
const u = word.unit / cell
let minX = Infinity
let maxX = -Infinity
for (const c of word.cells) {
  minX = Math.min(minX, c.x / cell)
  maxX = Math.max(maxX, c.x / cell + u)
}
const first = word.cells[0]
const top = H - (first.y / cell - first.row * u)
const half = (maxX - minX) / 2

const setPaper = (i: number) => {
  d[i * 4] = paper[0]
  d[i * 4 + 1] = paper[1]
  d[i * 4 + 2] = paper[2]
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const bayer8 = (x: number, y: number) => {
  x &= 7
  y &= 7
  const e = x ^ y
  const v = ((e & 1) << 5) | ((y & 1) << 4) | ((e & 2) << 2) | ((y & 2) << 1) | ((e & 4) >> 1) | ((y & 4) >> 2)
  return (v + 0.5) / 64
}

// The settled word: outline solid, fill stepped through the bands, counters at half.
function paintSettled() {
  // Only the wordmark's cells can light up, so visit those instead of the whole grid.
  for (const c of word.cells) {
    const cx = c.x / cell
    const cy = c.y / cell
    for (let y = Math.max(0, cy); y < Math.min(H, cy + u); y++)
      for (let x = Math.max(0, cx); x < Math.min(W, cx + u); x++) {
        const i = y * W + x
        const m = map[i]
        // gl_FragCoord: pixel centre, y up.
        const fx = x + 0.5
        const fy = H - y - 0.5
        const gy = (top - fy) / u
        const row = ((Math.floor(gy) % (ROWS + LINE_GAP)) + ROWS + LINE_GAP) % (ROWS + LINE_GAP)
        const qx = (fx - 0.5 * W) / half
        const qy = (row + (gy - Math.floor(gy)) - X_TOP - X_HEIGHT / 2) / (X_HEIGHT / 2)
        let t = 0.5 + 0.5 * qy
        t += 0.09 * Math.sin(qx * 6.5) + 0.04 * Math.sin(qx * 13)
        t = Math.min(1, Math.max(0, t))
        const level = 1 - (0.75 * Math.floor(smooth(0.2, 0.95, t) * 3.999)) / 3
        const L = order[i] ? 1 : m === 1 ? level : 0.5 * level
        if (bayer8(x, H - 1 - y) <= L) setPaper(i)
      }
  }
}

if (!settled) {
  // Outline pixels by draw order; each frame reveals the ones whose moment has come.
  const pending: number[] = []
  for (let i = 0; i < order.length; i++) if (order[i]) pending.push(i)
  pending.sort((a, b) => order[a] - order[b])
  let next = 0
  const frame = (now: number) => {
    if (!canvas.isConnected) return
    const thr = outlineThreshold(now - t0)
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    for (; next < pending.length && order[pending[next]] <= thr; next++) {
      const i = pending[next]
      const x = i % W
      const y = (i - x) / W
      setPaper(i)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    if (x1 >= 0) ctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    if (next < pending.length) requestAnimationFrame(frame)
  }
  ctx.putImageData(img, 0, 0)
  requestAnimationFrame((now) => {
    t0 = now
    window.rinxIntroStart = now
    frame(now)
  })
} else {
  paintSettled()
  ctx.putImageData(img, 0, 0)
}
