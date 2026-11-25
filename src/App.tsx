import "./App.css"
import { createEffect, createSignal, For, onSettled } from "solid-js"
import { DitherRenderer } from "./dither/renderer"
import { OUTLINE_MS, outlineThreshold } from "./outline"
import { SceneIcon, ThemeIcon, WordIcon } from "./pixelIcons"
import { currentPage, type Page } from "./page"
import { SCENES, type SceneId } from "./dither/shaders"

type Theme = "dark" | "light"

const THEMES: Record<Theme, { ink: string; paper: string }> = {
  dark: { ink: "#0b0b0b", paper: "#ecebe6" },
  light: { ink: "#f3f2ee", paper: "#141414" },
}

const THEME_KEY = "rinx-theme"
const SCENE_KEY = "rinx-scene"
const DEFAULT_SCENE: SceneId = "plain"

// Storage can be blocked (private mode, site settings); everything still works for the visit.
const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore: the choice just isn't remembered.
  }
}

const readStoredTheme = (): Theme | null => {
  const value = read(THEME_KEY)
  return value === "dark" || value === "light" ? value : null
}

const readStoredScene = (): SceneId | null => {
  const value = read(SCENE_KEY)
  return SCENES.some((s) => s.id === value) ? (value as SceneId) : null
}

export default function App() {
  // The 404 page is this same app: "404" over a fixed Dunes background, with a way home
  // instead of the scene picker.
  const page: Page =
    typeof document !== "undefined"
      ? currentPage()
      : { notFound: false, word: "rinx.dev", layout: {}, scene: null, cacti: false }
  const renderer = new DitherRenderer({
    word: page.word,
    layout: page.layout,
    cacti: page.cacti,
  })
  let canvas!: HTMLCanvasElement
  let face!: HTMLCanvasElement
  let group!: HTMLDivElement
  let indicator!: HTMLSpanElement
  const items: HTMLButtonElement[] = []
  let lastIndex = -1

  // Start from what the inline script in Document.tsx already applied.
  const initialTheme: Theme =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark"
  const [theme, setTheme] = createSignal<Theme>(initialTheme)
  const [scene, setScene] = createSignal<SceneId>(page.scene ?? DEFAULT_SCENE)
  const [glReady, setGlReady] = createSignal(true)
  // The pill's indicator only animates once the saved scene has been restored.
  const [ready, setReady] = createSignal(false)

  createEffect(
    () => theme(),
    (value) => {
      const { ink, paper } = THEMES[value]
      renderer.setColors(ink, paper)
      document.documentElement.dataset.theme = value
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ink)
    },
  )

  createEffect(
    () => SCENES.findIndex((s) => s.id === scene()),
    (index) => renderer.setScene(Math.max(0, index)),
  )

  // The indicator frame sits on the chosen thumbnail (same CSS variables as before).
  const placeIndicator = (index: number) => {
    const el = items[index]
    if (!el || !indicator) return
    // Read the layout first: a read between the writes would apply the new position
    // before the transition is enabled, and the frame would jump.
    const { offsetLeft, offsetTop, offsetWidth, offsetHeight } = el
    indicator.dataset.activationDirection = lastIndex < 0 || lastIndex === index ? "none" : index > lastIndex ? "right" : "left"
    const st = indicator.style
    st.setProperty("--segmented-control-indicator-left", `${offsetLeft}px`)
    st.setProperty("--segmented-control-indicator-top", `${offsetTop}px`)
    st.setProperty("--segmented-control-indicator-width", `${offsetWidth}px`)
    st.setProperty("--segmented-control-indicator-height", `${offsetHeight}px`)
    lastIndex = index
  }
  const sceneIndex = () => Math.max(0, SCENES.findIndex((s) => s.id === scene()))
  createEffect(sceneIndex, (index) => placeIndicator(index))

  const choose = (id: SceneId) => {
    setScene(id)
    write(SCENE_KEY, id)
  }
  // Radio-group keys: arrows move and select (wrapping), Home/End jump.
  const onKey = (e: KeyboardEvent) => {
    // Leave chords to the browser and assistive tech (Alt/Cmd+Arrow is back/forward).
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const n = SCENES.length
    const i = sceneIndex()
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i + n - 1) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    choose(SCENES[next].id)
    items[next]?.focus()
  }

  onSettled(() => {
    const motionQuery = matchMedia("(prefers-reduced-motion: reduce)")
    // The inline first frame is always Plain, so a saved scene crossfades in over it
    // (the scene effect runs after attach). With reduced motion it appears at once.
    const storedScene = page.scene ? null : readStoredScene()
    if (storedScene) {
      setScene(storedScene)
      if (motionQuery.matches) renderer.setScene(SCENES.findIndex((s) => s.id === storedScene))
    }

    const system = matchMedia("(prefers-color-scheme: light)")
    setTheme(readStoredTheme() ?? (system.matches ? "light" : "dark"))
    // Follow the system until the visitor picks a theme themselves.
    const onSystem = (e: MediaQueryListEvent) => {
      if (!readStoredTheme()) setTheme(e.matches ? "light" : "dark")
    }
    system.addEventListener("change", onSystem)

    const applyMotion = () => {
      renderer.setAnimate(!motionQuery.matches)
      if (motionQuery.matches) renderer.skipIntro()
    }
    applyMotion()
    motionQuery.addEventListener("change", applyMotion)

    // The inline first frame has been drawing the outline since it ran (the settled word
    // with reduced motion); WebGL carries on from that moment on the same clock.
    const ff = document.getElementById("ff")
    if (ff) {
      renderer.startIntroAt(() => window.rinxIntroStart)
      // WebGL continues the intro, so drop it once WebGL has drawn and been presented.
      // The flat fallback (no WebGL, or a context lost for good) has no intro: let the
      // inline outline finish drawing on over it first.
      const removeWhenDrawn = (now: number) => {
        const t = window.rinxIntroStart
        if (motionQuery.matches || (t !== undefined && outlineThreshold(now - t) >= 255)) ff.remove()
        else requestAnimationFrame(removeWhenDrawn)
      }
      renderer.onFirstFrame = (gl) =>
        gl ? requestAnimationFrame(() => requestAnimationFrame(() => ff.remove())) : removeWhenDrawn(performance.now())
    }
    renderer.onGlFailed = () => setGlReady(false)
    // Compiling the shader can hold the main thread and freeze the inline outline
    // mid-stroke, so WebGL holds off drawing (and compiling on the main thread) until
    // one frame after the outline is complete. Where the browser compiles in the
    // background (KHR_parallel_shader_compile) it starts right away, so the fill can
    // follow the outline with no pause.
    if (ff && !motionQuery.matches) {
      renderer.holdUntil = (now) => {
        const t = window.rinxIntroStart
        return t !== undefined && now - t >= OUTLINE_MS + 10
      }
    }
    if (!renderer.attach(canvas, face)) setGlReady(false)
    // The gap changes at the phone breakpoint; keep the frame on its thumbnail.
    const ro = new ResizeObserver(() => {
      lastIndex = -1
      placeIndicator(sceneIndex())
    })
    if (group) {
      placeIndicator(sceneIndex())
      ro.observe(group)
    }
    const readyFrame = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))

    return () => {
      system.removeEventListener("change", onSystem)
      motionQuery.removeEventListener("change", applyMotion)
      cancelAnimationFrame(readyFrame)
      ro.disconnect()
      renderer.detach()
    }
  })

  return (
    <main class="site" data-gl={glReady() ? "on" : "off"}>
      {/* The pointer slides the letters' dither bands; clicks do nothing. */}
      <canvas
        ref={canvas}
        class="stage"
        aria-hidden="true"
        onPointerMove={(e) => renderer.pointerMove(e.clientX, e.clientY)}
        onPointerDown={(e) => renderer.pointerMove(e.clientX, e.clientY)}
        onPointerLeave={() => renderer.pointerLeave()}
        onPointerCancel={() => renderer.pointerLeave()}
      />

      <canvas ref={face} class="face" aria-hidden="true" />

      <h1 class="wordmark">{page.notFound ? "404: page not found" : "rinx.dev"}</h1>

      <footer class="controls">
        {page.notFound ? (
          <>
            <a class="home" href="/" title="rinx.dev">
              <WordIcon />
              <span class="sr-only">Back to rinx.dev</span>
            </a>
            <span class="scene-name" aria-hidden="true">
              Lost in the dunes
            </span>
          </>
        ) : (
          <>
            {/* Scenes need WebGL; without it there is nothing to switch. */}
            <div
              ref={group}
              role="radiogroup"
              aria-label="Background"
              aria-orientation="horizontal"
              class="scenes"
              data-ready={ready() ? "" : undefined}
              data-disabled={glReady() ? undefined : ""}
              onKeyDown={onKey}
            >
              <span ref={indicator} data-slot="segmented-control-indicator" role="presentation" data-activation-direction="none" />
              <For each={SCENES}>
                {(s) => (
                  <button
                    ref={(el) => (items[SCENES.indexOf(s)] = el)}
                    type="button"
                    role="radio"
                    data-slot="segmented-control-item"
                    title={s.label}
                    aria-checked={scene() === s.id ? "true" : "false"}
                    tabindex={scene() === s.id ? 0 : -1}
                    data-checked={scene() === s.id ? "" : undefined}
                    disabled={!glReady()}
                    onClick={() => choose(s.id)}
                  >
                    <SceneIcon scene={s.id} />
                    <span class="sr-only">{s.label}</span>
                  </button>
                )}
              </For>
            </div>
            <span class="scene-name" aria-hidden="true">
              {SCENES.find((s) => s.id === scene())?.label}
            </span>
          </>
        )}

        <button
          type="button"
          class="theme-toggle"
          aria-label="Light theme"
          aria-pressed={theme() === "light" ? "true" : "false"}
          data-pressed={theme() === "light" ? "" : undefined}
          onClick={() => {
            const next: Theme = theme() === "light" ? "dark" : "light"
            setTheme(next)
            write(THEME_KEY, next)
          }}
        >
          <ThemeIcon />
        </button>
      </footer>
    </main>
  )
}
