import { fragmentShader, VERTEX_SHADER } from "./shaders"
import { layoutWordmark, type LayoutOptions, type WordLayout } from "../wordmark"
import { OUTLINE_MS, outlineThreshold, rasterize } from "../outline"

type Rgb = [number, number, number]

/** The intro's second phase: after the outline has drawn on, the fill dithers in. */
const FILL_MS = 1200
const CROSSFADE_SECONDS = 0.8
/** Ambient-only frames (scene motion, nothing interactive) run at this rate to save power. */
const AMBIENT_FPS = 30
/** On Plain only the letters' band wave moves; it is slow, so a low rate is enough. */
const WAVE_FPS = 15
const UNIFORMS = [
  "uRes", "uTime", "uMouse", "uMask", "uInk", "uPaper", "uIntro",
  "uUnit", "uOrigin", "uHalfWidth", "uOrder", "uOutline", "uDissolve",
] as const
type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
interface Program {
  program: WebGLProgram
  u: Uniforms
}

const hexToRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export interface RendererOptions {
  word: string
  layout?: LayoutOptions
  /** Cacti in the Dunes scene (the 404 page). */
  cacti?: boolean
}

/**
 * Framework-free WebGL2 renderer. Settings can be set before `attach`; nothing
 * touches the DOM until then.
 */
export class DitherRenderer {
  private opts: RendererOptions
  private canvas: HTMLCanvasElement | null = null
  /** Full-resolution canvas for the pixel wordmark, so its edges stay crisp. */
  private face: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  /**
   * One small program per background, each compiled only when it is shown: the letters
   * alone (key 0, all Plain needs) and one per scene (key = its SCENES index). A single
   * all-scenes program took seconds to compile in browsers without background compiles
   * (Firefox), freezing the page after the intro even on Plain.
   */
  private programs = new Map<number, Program>()
  /** Programs compiling in the background (KHR_parallel_shader_compile). */
  private building: { key: number; program: WebGLProgram }[] = []
  private parallel = false
  /** Scenes whose program failed to build: they show as Plain. */
  private failed = new Set<number>()
  /** The flat 2D face is what shows: no WebGL, or it failed or was lost for good. */
  private faceMode = false
  private texture: WebGLTexture | null = null
  /** Outline draw order per dither pixel (R8), from src/outline.ts. */
  private orderTex: WebGLTexture | null = null
  private order: Uint8Array | null = null
  private vao: WebGLVertexArrayObject | null = null
  private mask: HTMLCanvasElement | null = null

  private scene = 0
  private prevScene = 0
  private blend = 1
  private animate = true
  private time = 0
  private lastDraw = 0
  private ink: Rgb = [0.04, 0.04, 0.04]
  private paper: Rgb = [0.95, 0.94, 0.92]
  private inkHex = "#0b0b0b"
  private paperHex = "#ecebe6"
  private word: WordLayout | null = null
  private checker: { key: string; pattern: CanvasPattern } | null = null
  private lostTimer = 0
  /** Called if the letters' shader fails after attach() returned true (it builds later). */
  onGlFailed?: () => void
  /**
   * While this returns false, WebGL neither draws nor compiles on the main thread (a
   * background compile may run). The intro uses it to keep the outline smooth.
   */
  holdUntil: ((now: number) => boolean) | null = null
  /** Called once, right after the first frame is drawn: WebGL (`gl` true) or the flat fallback. */
  onFirstFrame?: (gl: boolean) => void
  /** The letters' unit lattice in dither px (GL y-up), computed once per layout. */
  private lattice = { unit: 0, left: 0, top: 0, half: 0 }

  /** CSS px per dither pixel (before DPR rounding). */
  private pixel = 3
  /** Device pixels per dither pixel: a whole number, so the upscale stays crisp at any DPR. */
  private cell = 3
  private dpr = 1
  private width = 1
  private height = 1
  /** Fill progress 0..1 (the intro's second phase). */
  private intro = 0
  /** Outline progress 0..255 (the first phase), compared with the order texture. */
  private outline = 0
  /** Intro clock (performance.now() time base): the inline first frame's start, if any. */
  private introStart: number | null = null
  private introClock: (() => number | undefined) | null = null
  private glStart: number | null = null
  private introDone = false
  private last = 0
  private raf = 0
  private dirty = true
  private teardown: (() => void)[] = []
  // Pointer in dither px (eased), for the letters' spotlight. cx/cy: last client px,
  // to re-place it after a resize.
  private mouse = { x: 0, y: 0, tx: 0, ty: 0, cx: 0, cy: 0, on: 0, target: 0, seen: false }
  private started = false

  constructor(opts: RendererOptions) {
    this.opts = opts
  }

  /** Switches the background scene (0 = none), crossfading from the current one. */
  setScene(index: number) {
    if (index === this.scene) return
    if (!this.started) {
      // Before the first frame there is nothing on screen to fade from.
      this.scene = this.prevScene = index
      this.blend = 1
    } else if (index === this.prevScene && this.blend < 1) {
      // Going back mid-fade: reverse from the same mix, with no pop.
      this.prevScene = this.scene
      this.scene = index
      this.blend = 1 - this.blend
    } else {
      // Mid-fade, fade out from whichever scene is more visible.
      this.prevScene = this.blend < 0.5 ? this.prevScene : this.scene
      this.scene = index
      this.blend = 0
    }
    this.invalidate()
  }

  /** Scene motion; off for reduced motion (scenes then hold a still frame). */
  setAnimate(on: boolean) {
    this.animate = on
    this.invalidate()
  }

  setColors(ink: string, paper: string) {
    this.ink = hexToRgb(ink)
    this.paper = hexToRgb(paper)
    this.inkHex = ink
    this.paperHex = paper
    if (this.faceMode) this.drawFace()
    this.invalidate()
  }

  skipIntro() {
    this.settleIntro()
    if (this.faceMode) this.drawFace()
    this.invalidate()
  }

  /**
   * Continue the intro the inline first frame runs. `start` returns its start time
   * (performance.now() base) once its first frame has been shown; until then the
   * renderer waits for it rather than starting a clock of its own.
   */
  startIntroAt(start: () => number | undefined) {
    this.introClock = start
  }

  private settleIntro() {
    this.introDone = true
    this.intro = 1
    this.outline = 255
  }

  /** Converts viewport coordinates to dither pixels (origin bottom-left, like gl_FragCoord). */
  private toGrid(clientX: number, clientY: number) {
    const k = this.dpr / this.cell
    return { x: clientX * k, y: this.height - clientY * k }
  }

  /** The pointer lights up the letters near it. */
  pointerMove(clientX: number, clientY: number) {
    const m = this.mouse
    const g = this.toGrid(clientX, clientY)
    m.cx = clientX
    m.cy = clientY
    m.tx = g.x
    m.ty = g.y
    m.target = 1
    if (!m.seen) {
      m.x = g.x
      m.y = g.y
      m.seen = true
    }
    this.invalidate()
  }

  pointerLeave() {
    this.mouse.target = 0
    this.invalidate()
  }

  attach(canvas: HTMLCanvasElement, face: HTMLCanvasElement): boolean {
    this.canvas = canvas
    this.face = face
    this.mask = document.createElement("canvas")
    // The wordmark is plain 2D canvas, so it still shows when WebGL2 is missing.
    const glOk = this.initGl()

    const onResize = () => this.resize()
    const onLost = (e: Event) => {
      e.preventDefault()
      cancelAnimationFrame(this.raf)
      this.raf = 0
      this.programs.clear()
      this.building = []
      // If the context stays gone, show the flat wordmark rather than nothing
      // (delayed, so quick restores don't flash).
      this.lostTimer = window.setTimeout(() => {
        if (!this.plain) {
          this.faceMode = true
          this.settleIntro()
          this.drawFace()
        }
      }, 1000)
    }
    const onRestored = () => {
      clearTimeout(this.lostTimer)
      if (this.initGl()) {
        this.uploadMask() // invalidate() restarts the loop
      } else {
        this.faceMode = true
        this.settleIntro()
        this.drawFace()
      }
    }
    // Moving the window to a screen with another DPR fires no resize event.
    let dprQuery: MediaQueryList | null = null
    const onDpr = () => {
      this.resize()
      watchDpr()
    }
    const watchDpr = () => {
      dprQuery?.removeEventListener("change", onDpr)
      dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
      dprQuery.addEventListener("change", onDpr)
    }
    watchDpr()
    addEventListener("resize", onResize)
    canvas.addEventListener("webglcontextlost", onLost)
    canvas.addEventListener("webglcontextrestored", onRestored)
    this.teardown.push(() => {
      clearTimeout(this.lostTimer)
      removeEventListener("resize", onResize)
      dprQuery?.removeEventListener("change", onDpr)
      canvas.removeEventListener("webglcontextlost", onLost)
      canvas.removeEventListener("webglcontextrestored", onRestored)
    })

    if (!glOk) this.faceMode = true
    this.resize()
    if (!glOk) {
      this.settleIntro()
      this.drawFace()
      return false
    }
    this.start()
    return true
  }

  detach() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.started = false
    for (const fn of this.teardown.splice(0)) fn()
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext()
    this.gl = null
    this.programs.clear()
    this.building = []
    this.canvas = null
    this.face = null
  }

  /** Marks the frame stale and wakes the loop if it went to sleep. */
  private invalidate() {
    this.dirty = true
    if (!this.raf && this.started && this.gl && !this.faceMode) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.tick)
    }
  }

  private start() {
    this.started = true
    if (this.raf) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  private initGl(): boolean {
    const canvas = this.canvas
    if (!canvas) return false
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    })
    if (!gl) return false
    this.gl = gl

    // Compiling can block the main thread for a second or more. With
    // KHR_parallel_shader_compile the driver does it in the background and tick() polls
    // until it is done, so the page (and the inline intro) keep running.
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile")
    this.programs.clear()
    this.building = []
    this.failed.clear()
    this.vao = gl.createVertexArray()
    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.orderTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.orderTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // While held, only a background compile may start now; otherwise it waits.
    if (this.parallel || !this.holdUntil) return this.build(0)
    return true
  }

  /** The letters-only program: what Plain draws, and what shows while a scene compiles. */
  private get plain() {
    return this.programs.get(0) ?? null
  }

  /**
   * Compiles and links one program (key 0 letters only, else that scene). In the
   * background it is only queued (tick() polls it); otherwise it is finished at once.
   * False if a build finished here and failed.
   */
  private build(key: number): boolean {
    const gl = this.gl
    if (!gl) return false
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      return sh
    }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentShader({ scene: key, cacti: this.opts.cacti })))
    gl.linkProgram(program)
    if (this.parallel) {
      this.building.push({ key, program })
      return true
    }
    return this.finish(key, program)
  }

  /** Checks a finished link and takes the program into use; false if it failed. */
  private finish(key: number, program: WebGLProgram): boolean {
    const gl = this.gl
    if (!gl) return false
    // Only asked once the compile is done: asking earlier would wait for it.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) {
        console.error(gl.getProgramInfoLog(program))
        for (const sh of gl.getAttachedShaders(program) ?? []) {
          const log = gl.getShaderInfoLog(sh)
          if (log) console.error(log)
        }
      }
      if (key !== 0) this.failed.add(key) // that scene shows as Plain; the letters still work
      return false
    }
    const u = {} as Uniforms
    for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name)
    this.programs.set(key, { program, u })
    if (key === 0) {
      this.faceMode = false
      this.clearFace()
    } else if (key === this.scene && this.blend >= 1) {
      // A scene chosen (or restored) before its program was ready dissolves in from Plain.
      this.prevScene = 0
      this.blend = 0
    }
    this.dirty = true
    return true
  }

  /** Takes background builds into use once the driver has finished them. */
  private pollBuilds() {
    const gl = this.gl
    if (!gl || !this.building.length) return
    for (const b of [...this.building]) {
      // COMPLETION_STATUS_KHR (0x91B1): true once compile and link have finished.
      if (!gl.getProgramParameter(b.program, 0x91b1)) continue
      this.building.splice(this.building.indexOf(b), 1)
      if (!this.finish(b.key, b.program) && b.key === 0) this.failGl()
    }
  }

  /** The letters' shader failed: show the flat wordmark instead (rare, a broken driver). */
  private failGl() {
    this.faceMode = true
    this.building = []
    this.settleIntro()
    this.drawFace()
    this.onGlFailed?.()
  }

  /** Whether `key` can be drawn as itself (Plain always; a scene once built, or never if it failed). */
  private ready(key: number) {
    return key === 0 || this.programs.has(key) || this.failed.has(key)
  }

  /**
   * Builds the programs of the scenes on screen (current, and the previous one while
   * fading). In the background as soon as it is wanted; without background compiles it
   * holds the page for a moment, so only once the intro is over.
   */
  private maybeBuildScenes() {
    if (!this.plain) return
    for (const key of [this.scene, this.blend < 1 ? this.prevScene : 0]) {
      if (this.ready(key) || this.building.some((b) => b.key === key)) continue
      if (this.parallel || this.introDone) this.build(key)
    }
  }

  private resize() {
    const canvas = this.canvas
    if (!canvas) return
    // Finer pixels on small screens so the wordmark keeps its shape.
    this.pixel = Math.min(innerWidth, innerHeight) < 700 ? 2 : 3
    // Size the grid in device pixels: each dither pixel covers a whole number of them.
    this.dpr = devicePixelRatio || 1
    this.cell = Math.max(1, Math.round(this.pixel * this.dpr))
    this.width = Math.max(1, Math.ceil((innerWidth * this.dpr) / this.cell))
    this.height = Math.max(1, Math.ceil((innerHeight * this.dpr) / this.cell))
    canvas.width = this.width
    canvas.height = this.height
    canvas.style.width = `${(this.width * this.cell) / this.dpr}px`
    canvas.style.height = `${(this.height * this.cell) / this.dpr}px`
    const m = this.mouse
    if (m.seen) {
      const g = this.toGrid(m.cx, m.cy)
      m.x = m.tx = g.x
      m.y = m.ty = g.y
    }
    this.drawWord()
  }

  private drawWord() {
    // Centre on the visible viewport, not the canvas, which overhangs it by up to one
    // cell. Coordinates are device px from the canvas origin; the mask is the same
    // surface scaled by 2 / cell.
    const vw = Math.round(innerWidth * this.dpr)
    const vh = Math.round(innerHeight * this.dpr)
    this.word = layoutWordmark(this.opts.word, vw, vh, this.cell, this.opts.layout)
    const word = this.word
    if (word.cells.length) {
      const first = word.cells[0]
      const unit = word.unit / this.cell
      let minX = Infinity
      let maxX = -Infinity
      for (const c of word.cells) {
        minX = Math.min(minX, c.x)
        maxX = Math.max(maxX, c.x + word.unit)
      }
      this.lattice = {
        unit,
        left: first.x / this.cell - first.col * unit,
        top: this.height - (first.y / this.cell - first.row * unit),
        half: (maxX - minX) / 2 / this.cell,
      }
    } else {
      this.lattice = { unit: 0, left: 0, top: 0, half: 0 }
    }
    this.order = rasterize(word, this.cell, this.width, this.height).order
    this.drawMask()
    // With WebGL the shader draws the letters; the flat 2D face is only the fallback.
    if (this.faceMode) this.drawFace()
    else this.clearFace()
  }

  private clearFace() {
    const face = this.face
    if (!face) return
    face.width = face.height = 1
  }

  /**
   * Renders the wordmark into a 2x mask for the shader: red = stroke cells,
   * blue = shaded counter cells, green = wide blur that clears the background
   * scene around them. The shader dithers the letters themselves.
   */
  private drawMask() {
    const mask = this.mask
    const word = this.word
    if (!mask || !word) return
    const w = (mask.width = this.width * 2)
    const h = (mask.height = this.height * 2)
    const ctx = mask.getContext("2d")
    if (!ctx) return
    const k = 2 / this.cell
    const u = word.unit * k
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, w, h)

    // Clearance: draw only the blurred shadow, by moving the cells far off-canvas.
    const away = w + u * 20
    ctx.save()
    ctx.fillStyle = "#0f0"
    ctx.shadowColor = "#0f0"
    ctx.shadowBlur = u * 1.6
    ctx.shadowOffsetX = away
    for (const c of word.cells) ctx.fillRect(c.x * k - away, c.y * k, u, u)
    ctx.restore()

    ctx.globalCompositeOperation = "lighter"
    for (const c of word.cells) {
      ctx.fillStyle = c.shade ? "#00f" : "#f00"
      ctx.fillRect(c.x * k, c.y * k, u, u)
    }
    ctx.globalCompositeOperation = "source-over"
    this.uploadMask()
  }

  /**
   * Draws the wordmark at full device resolution: solid cells in paper, shaded
   * cells as a checker of dither pixels. This no-WebGL fallback is always settled
   * (the inline first frame draws the outline on over it).
   */
  private drawFace() {
    const face = this.face
    const word = this.word
    if (!face || !word) return
    const w = this.width * this.cell
    const h = this.height * this.cell
    if (face.width !== w || face.height !== h) {
      face.width = w
      face.height = h
      face.style.width = `${w / this.dpr}px`
      face.style.height = `${h / this.dpr}px`
    }
    const ctx = face.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // A 2×2-cell checker, anchored at the canvas origin like the stage's dither grid.
    // Cached: resizes and theme changes redraw the face.
    const key = `${this.cell}|${this.paperHex}`
    if (this.checker?.key !== key) {
      const tile = document.createElement("canvas")
      tile.width = tile.height = this.cell * 2
      const tc = tile.getContext("2d")!
      tc.fillStyle = this.paperHex
      tc.fillRect(0, 0, this.cell, this.cell)
      tc.fillRect(this.cell, this.cell, this.cell, this.cell)
      this.checker = { key, pattern: ctx.createPattern(tile, "repeat")! }
    }
    const checker = this.checker.pattern

    for (const c of word.cells) {
      ctx.fillStyle = c.shade ? checker : this.paperHex
      ctx.fillRect(c.x, c.y, word.unit, word.unit)
    }
    this.firstFrame(false)
  }

  private uploadMask() {
    const gl = this.gl
    if (!gl || !this.mask || !this.texture) return
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.mask)
    if (this.orderTex && this.order) {
      // Rows top to bottom, one byte per pixel; the shader flips y itself.
      gl.bindTexture(gl.TEXTURE_2D, this.orderTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.width, this.height, 0, gl.RED, gl.UNSIGNED_BYTE, this.order)
    }
    this.invalidate()
  }

  /**
   * The intro runs on the wall clock from the inline first frame's start, so WebGL picks
   * the outline up exactly where that script has got to. The fill starts once the
   * outline is complete and WebGL is running, whichever is later.
   */
  private advanceIntro(now: number) {
    if (this.introDone) return
    // The inline script's first callback runs before this one in the same frame, so its
    // start is normally set; if it never runs (no #ff), start here.
    const t0 = (this.introStart ??= this.introClock?.() ?? now)
    this.outline = outlineThreshold(now - t0)
    // The fill waits for the first frame WebGL can actually draw (after the compile).
    if (!this.plain) {
      this.intro = 0
      return
    }
    this.glStart ??= now
    const fillStart = Math.max(t0 + OUTLINE_MS, this.glStart)
    this.intro = Math.min(1, Math.max(0, (now - fillStart) / FILL_MS))
    if (this.intro >= 1) this.settleIntro()
  }

  /** True while the intro, a crossfade or the easing pointer still has frames to draw. */
  private settling() {
    const m = this.mouse
    return (
      this.intro < 1 ||
      this.outline < 255 ||
      this.blend < 1 ||
      Math.abs(m.target - m.on) > 0.002 ||
      Math.abs(m.tx - m.x) > 0.05 ||
      Math.abs(m.ty - m.y) > 0.05
    )
  }

  private tick = (now: number) => {
    // start()/invalidate() stamp performance.now(), which can be later than this
    // frame's timestamp: never let time run backwards.
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000))
    this.last = now
    // Held (the intro's outline is still drawing): no drawing and no main-thread
    // compile yet, though a background build may finish meanwhile.
    if (this.holdUntil) {
      this.pollBuilds()
      if (!this.holdUntil(now)) {
        this.raf = this.faceMode ? 0 : requestAnimationFrame(this.tick)
        return
      }
      this.holdUntil = null
      if (!this.plain && !this.building.length && !this.faceMode && !this.build(0)) this.failGl()
    }
    this.pollBuilds()
    // Letters' shader still compiling in the background: check again next frame.
    if (!this.plain) {
      this.raf = this.faceMode ? 0 : requestAnimationFrame(this.tick)
      return
    }
    this.maybeBuildScenes()
    // Measured before advancing, so the tick that finishes a transition still draws
    // its final frame (otherwise a sleeping loop would keep a part-blended frame).
    const wasSettling = this.settling()
    if (this.animate) this.time += dt
    // A crossfade waits until the scenes' program is ready (it fades in from there).
    if (this.blend < 1 && this.ready(this.scene))
      this.blend = Math.min(1, this.blend + dt / CROSSFADE_SECONDS)
    this.advanceIntro(now)

    const m = this.mouse
    const k = Math.min(1, dt * 8)
    m.x += (m.tx - m.x) * k
    m.y += (m.ty - m.y) * k
    m.on += (m.target - m.on) * Math.min(1, dt * 4)

    // The intro, crossfades and the easing pointer draw every frame until they settle.
    const interactive = this.settling()
    // Scenes and the letters' band wave move on their own (fuller rate while a scene
    // moves); with reduced motion everything settles and the loop sleeps.
    const ambient = this.animate
    const sceneMoving = this.scene !== 0 || (this.blend < 1 && this.prevScene !== 0)
    // Transitions draw every frame; scene motion alone draws at AMBIENT_FPS; a still
    // page stops drawing.
    const due = now - this.lastDraw >= 1000 / (sceneMoving ? AMBIENT_FPS : WAVE_FPS) - 2
    if (this.dirty || wasSettling || interactive || (ambient && due)) {
      this.draw()
      this.lastDraw = now
    }
    this.dirty = false
    // Sleep when nothing changes; invalidate() wakes the loop again.
    this.raf = interactive || ambient ? requestAnimationFrame(this.tick) : 0
  }

  private draw() {
    const gl = this.gl
    const plain = this.plain
    if (!gl || !plain || gl.isContextLost()) return
    gl.viewport(0, 0, this.width, this.height)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.orderTex)
    gl.activeTexture(gl.TEXTURE0)

    // A scene whose program is not ready yet shows as Plain.
    const show = (key: number) => this.programs.get(key) ?? plain
    if (this.blend < 1) {
      // Crossfade as a dither dissolve: the previous scene in full, then the new one over
      // a growing, scattered share of the pixels (it waits while its program compiles).
      this.drawWith(show(this.prevScene), 1)
      if (this.ready(this.scene) && this.blend > 0) this.drawWith(show(this.scene), this.blend)
    } else {
      this.drawWith(show(this.scene), 1)
    }
    // A context lost during this draw showed nothing: wait for the fallback or a restore.
    if (!gl.isContextLost()) this.firstFrame(true)
  }

  /** One full-screen pass with `prog`, covering a `dissolve` share of the pixels (1 = all). */
  private drawWith(prog: Program, dissolve: number) {
    const gl = this.gl!
    const u = prog.u
    gl.useProgram(prog.program)
    gl.uniform2f(u.uRes, this.width, this.height)
    gl.uniform1f(u.uTime, this.time)
    gl.uniform1i(u.uMask, 0)
    gl.uniform3f(u.uMouse, this.mouse.x, this.mouse.y, this.mouse.on)
    gl.uniform3fv(u.uInk, this.ink)
    gl.uniform3fv(u.uPaper, this.paper)
    gl.uniform1f(u.uIntro, this.intro)
    gl.uniform1i(u.uOrder, 1)
    gl.uniform1f(u.uOutline, this.outline)
    gl.uniform1f(u.uDissolve, dissolve)
    const lat = this.lattice
    gl.uniform1f(u.uUnit, lat.unit)
    gl.uniform2f(u.uOrigin, lat.left, lat.top)
    gl.uniform1f(u.uHalfWidth, lat.half)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Runs onFirstFrame once, after the first frame that actually put the wordmark on screen. */
  private firstFrame(gl: boolean) {
    const cb = this.onFirstFrame
    this.onFirstFrame = undefined
    cb?.(gl)
  }
}
