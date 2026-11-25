// The intro's first phase: the wordmark's 1-px outline draws itself on. Shared by the
// inline first frame (src/firstFrame.ts, which draws it before the bundle loads) and the
// WebGL renderer (which continues it), so both reveal exactly the same pixels at the
// same moment. Everything here is in dither pixels, rows top to bottom.
import type { WordLayout } from "./wordmark"

/** How long the outline takes to draw, from the inline script's start. */
export const OUTLINE_MS = 800

/**
 * Outline progress as a whole number 0..255: an outline pixel is drawn once its order
 * value is <= this. Integer, so the CPU and the shader compare exactly the same numbers.
 */
export const outlineThreshold = (elapsedMs: number) =>
  Math.floor(Math.min(1, Math.max(0, elapsedMs / OUTLINE_MS)) * 255)

export interface Raster {
  /** Per dither pixel: 0 empty, 1 stroke, 2 counter (shaded). */
  map: Uint8Array
  /** Per dither pixel: 0 if not on the outline, else 1..255, the moment it is drawn. */
  order: Uint8Array
}

/**
 * Rasterizes the wordmark onto the W×H dither grid and orders its outline pixels. Each
 * connected outline (a letter's outer edge, a counter's inner edge, the i's dot) is
 * traced from its top-left pixel in both directions at once, like a pen going round;
 * outlines further right start later, so the word draws left to right.
 */
export function rasterize(word: WordLayout, cell: number, W: number, H: number): Raster {
  const map = new Uint8Array(W * H)
  const u = word.unit / cell
  // The word's box on the grid, so the scans below skip the empty screen around it.
  let bx0 = W
  let by0 = H
  let bx1 = 0
  let by1 = 0
  for (const c of word.cells) {
    const cx = c.x / cell
    const cy = c.y / cell
    bx0 = Math.max(0, Math.min(bx0, cx))
    by0 = Math.max(0, Math.min(by0, cy))
    bx1 = Math.min(W, Math.max(bx1, cx + u))
    by1 = Math.min(H, Math.max(by1, cy + u))
    for (let y = Math.max(0, cy); y < Math.min(H, cy + u); y++)
      for (let x = Math.max(0, cx); x < Math.min(W, cx + u); x++) map[y * W + x] = c.shade ? 2 : 1
  }

  // Outline: stroke pixels with a 4-neighbour that is not stroke (the shader's test).
  const stroke = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && map[y * W + x] === 1
  const order = new Uint8Array(W * H)
  const pixels: number[] = []
  let minX = Infinity
  let maxX = -Infinity
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++)
      if (stroke(x, y) && !(stroke(x - 1, y) && stroke(x + 1, y) && stroke(x, y - 1) && stroke(x, y + 1))) {
        order[y * W + x] = 255 // marked; replaced by the real order below
        pixels.push(y * W + x)
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
      }

  // Breadth-first along each 8-connected outline, from its first pixel in raster order
  // (topmost, then leftmost). `pixels` is in raster order, so unvisited ones start new outlines.
  const dist = new Int32Array(W * H).fill(-1)
  const span = Math.max(1, maxX - minX)
  const queue = new Int32Array(pixels.length)
  for (const start of pixels) {
    if (dist[start] >= 0) continue
    let head = 0
    let tail = 0
    let far = 0
    let left = Infinity
    queue[tail++] = start
    dist[start] = 0
    while (head < tail) {
      const p = queue[head++]
      const x = p % W
      const y = (p - x) / W
      left = Math.min(left, x)
      far = Math.max(far, dist[p])
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) {
            const n = ny * W + nx
            if (order[n] && dist[n] < 0) {
              dist[n] = dist[p] + 1
              queue[tail++] = n
            }
          }
        }
    }
    // Start 0..0.45 by position across the word, then 0.55 to go all the way round.
    const begin = (0.45 * (left - minX)) / span
    for (let i = 0; i < tail; i++) {
      const p = queue[i]
      order[p] = 1 + Math.round((begin + (0.55 * dist[p]) / Math.max(1, far)) * 254)
    }
  }
  return { map, order }
}
