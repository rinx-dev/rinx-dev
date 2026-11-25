// The rinx.dev wordmark, drawn on a square unit grid: one-unit strokes, square
// counters, and the lower half of each counter filled with a dithered checker.
//
// Each glyph is 7 rows: two ascender rows, then a 5-unit x-height.
// "#" solid, "s" shaded (dithered), "." empty.

const GLYPHS: Record<string, string[]> = {
  r: [
    "...",
    "...",
    "###",
    "#..",
    "#..",
    "#..",
    "#..",
  ],
  i: [
    "#",
    ".",
    "#",
    "#",
    "#",
    "#",
    "#",
  ],
  n: [
    "....",
    "....",
    "###.",
    "#..#",
    "#ss#",
    "#ss#",
    "#ss#",
  ],
  // Left unshaded: its lower notch is open, not a counter, and shading it made an hourglass.
  x: [
    "....",
    "....",
    "#..#",
    "#..#",
    ".##.",
    "#..#",
    "#..#",
  ],
  ".": [
    ".",
    ".",
    ".",
    ".",
    ".",
    ".",
    "#",
  ],
  d: [
    "...#",
    "...#",
    "####",
    "#..#",
    "#ss#",
    "#ss#",
    "####",
  ],
  e: [
    "....",
    "....",
    "####",
    "#..#",
    "####",
    "#ss.",
    "####",
  ],
  // Five wide so it narrows to a 1-unit point (a 4-wide v reads as u); this also
  // makes ".dev" exactly as wide as "rinx" when stacked.
  v: [
    ".....",
    ".....",
    "#...#",
    "#...#",
    "#sss#",
    ".#s#.",
    "..#..",
  ],
  // Digits for the 404 page: full height (no ascender gap), same strokes and shading.
  "4": [
    "#..#",
    "#..#",
    "#..#",
    "####",
    "...#",
    "...#",
    "...#",
  ],
  "0": [
    "####",
    "#..#",
    "#..#",
    "#ss#",
    "#ss#",
    "#ss#",
    "####",
  ],
}

export const ROWS = 7
/** Row where the x-height starts; the block is centred optically on the x-height. */
export const X_TOP = 2
export const X_HEIGHT = 5
/** Empty rows between stacked lines. */
export const LINE_GAP = 2
const GAP = 1

export interface Cell {
  /** Grid position in units. */
  col: number
  row: number
  shade: boolean
}

export interface Line {
  cells: Cell[]
  /** Each glyph's column span in units, in order. */
  glyphs: { col0: number; col1: number }[]
  /** Width in units, and the width of a leading "." that hangs in the margin. */
  width: number
  hang: number
}

const glyphWidth = (ch: string) => GLYPHS[ch]?.[0].length ?? 0

/** Lays out a string of glyphs left to right, 1 unit apart. */
export function setLine(text: string, hangPeriod = false): Line {
  const cells: Cell[] = []
  const glyphs: { col0: number; col1: number }[] = []
  let x = 0
  let hang = 0
  for (const [i, ch] of [...text].entries()) {
    const g = GLYPHS[ch]
    if (!g) continue
    g.forEach((row, r) => {
      ;[...row].forEach((c, col) => {
        if (c !== ".") cells.push({ col: x + col, row: r, shade: c === "s" })
      })
    })
    glyphs.push({ col0: x, col1: x + glyphWidth(ch) })
    x += glyphWidth(ch) + GAP
    if (i === 0 && hangPeriod && ch === ".") hang = x
  }
  return { cells, glyphs, width: x - GAP, hang }
}

export interface PlacedCell extends Cell {
  /** Top-left in device px. */
  x: number
  y: number
}

/** A glyph's x-height box in device px (left, top, right, bottom), for per-letter lighting. */
export type GlyphBox = [number, number, number, number]

export interface WordLayout {
  /** Unit size in device px. */
  unit: number
  cells: PlacedCell[]
  glyphs: GlyphBox[]
  stacked: boolean
}

export interface LayoutOptions {
  /**
   * Size the letters as this text would be sized, so another word (the 404 page's) keeps
   * the same unit, and with the same x-height centring, the same baseline.
   */
  sizeLike?: string
}

/**
 * Places the wordmark on a w×h surface (device px). The unit is a whole number
 * of dither cells and the origin sits on the cell grid, so glyph edges and the
 * shade checker land exactly on the page's dither pixels.
 */
export function layoutWordmark(word: string, w: number, h: number, cell: number, opts: LayoutOptions = {}): WordLayout {
  const stacked = w / h < 0.9
  const linesOf = (text: string) => {
    const dot = text.indexOf(".")
    return stacked && dot > 0 ? [setLine(text.slice(0, dot)), setLine(text.slice(dot), true)] : [setLine(text)]
  }
  const lines = linesOf(word)
  // Width of the visible letters (a hanging period sits outside the measure).
  const measureOf = (ls: Line[]) => Math.max(...ls.map((l) => l.width - l.hang))
  const measure = measureOf(lines)
  const lineGap = LINE_GAP
  const rowsOf = (ls: Line[]) => ROWS * ls.length + lineGap * (ls.length - 1)
  const blockRows = rowsOf(lines)
  const sizing = opts.sizeLike ? linesOf(opts.sizeLike) : lines
  const fit = Math.min((w * (stacked ? 0.74 : 0.66)) / measureOf(sizing), (h * (stacked ? 0.5 : 0.34)) / rowsOf(sizing))
  // Whole dither cells per unit: edges stay on the grid, and the checker (anchored
  // at the canvas origin) stays continuous across neighbouring cells.
  const unit = Math.max(cell * 2, Math.floor(fit / cell) * cell)

  // Optical centre: the x-height of the whole block, not the ascenders.
  const xTop = X_TOP
  const xBottom = (lines.length - 1) * (ROWS + lineGap) + X_TOP + X_HEIGHT
  const top = h / 2 - ((xTop + xBottom) / 2) * unit
  const snap = (v: number) => Math.round(v / cell) * cell

  const cells: PlacedCell[] = []
  const glyphs: GlyphBox[] = []
  // One left edge for every line, sized by the widest; a leading period hangs into the margin.
  const left = snap(w / 2 - (measure / 2) * unit)
  lines.forEach((line, i) => {
    const x0 = left - line.hang * unit
    const y0 = snap(top + i * (ROWS + lineGap) * unit)
    for (const c of line.cells) cells.push({ ...c, x: x0 + c.col * unit, y: y0 + c.row * unit })
    for (const g of line.glyphs) {
      glyphs.push([x0 + g.col0 * unit, y0 + X_TOP * unit, x0 + g.col1 * unit, y0 + (X_TOP + X_HEIGHT) * unit])
    }
  })
  return { unit, cells, glyphs, stacked }
}
