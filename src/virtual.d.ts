/** src/firstFrame.ts, bundled and minified by the first-frame plugin in vite.config.ts. */
declare module "virtual:first-frame" {
  const code: string
  export default code
}

interface Window {
  /** performance.now() when the inline first frame started the intro (src/firstFrame.ts). */
  rinxIntroStart?: number
}
