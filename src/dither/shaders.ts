import { LINE_GAP, ROWS, X_HEIGHT, X_TOP } from "../wordmark"

// Full-screen triangle, no vertex buffers.
export const VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`


/** Background scenes, in shader id order. 0 is the empty field. */
export const SCENES = [
  { id: "plain", label: "Plain" },
  { id: "ocean", label: "Ocean" },
  { id: "peaks", label: "Peaks" },
  { id: "dunes", label: "Dunes" },
  { id: "night", label: "Night" },
] as const

export type SceneId = (typeof SCENES)[number]["id"]

// A crisp 1-bit wordmark whose lower strokes dissolve into a Bayer gradient, over an
// optional procedural scene with slow motion. Everything is quantized with an 8×8 Bayer matrix.
// Scene brightness stays low (mostly under 0.4) and is knocked back around the
// letters, so the wordmark always reads first.
const FRAGMENT_SOURCE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uRes;
uniform float uTime;      // scene time (stops with reduced motion)
uniform sampler2D uMask;  // r = stroke cells, g = clearance blur, b = shaded counter cells
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uIntro;
uniform sampler2D uOrder; // outline draw order per dither pixel, 1..255 (src/outline.ts)
uniform float uOutline;   // outline progress 0..255: pixels with order <= this are drawn
uniform vec3 uMouse;      // pointer in dither px, z = presence 0..1 (letters' spotlight only)
uniform float uDissolve;  // share of pixels this pass covers (crossfades); 1 = all
uniform float uUnit;      // wordmark unit in dither px (0 = no wordmark)
uniform vec2 uOrigin;     // top-left of the wordmark's unit lattice (dither px, y-up)
uniform float uHalfWidth; // half the wordmark's width (dither px)

out vec4 outColor;

// ---------- noise ----------

// Integer hash of a lattice point: exact at any magnitude, so long sessions don't band.
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967296.0);
}

#if SCENES
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = r * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}
#endif

float bayer8(ivec2 p) {
  int x = p.x & 7, y = p.y & 7, e = x ^ y;
  int v = ((e & 1) << 5) | ((y & 1) << 4) | ((e & 2) << 2) | ((y & 2) << 1) | ((e & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

#if SCENES
// Disc with a short glow that ends cleanly (no long tail of stray dots).
// On the light theme a solid disc would print as a black blot, so it becomes an
// engraved ring instead, leaving the wordmark as the only heavy mass.
float orb(vec2 p, vec2 c, float r, float core, float glow) {
  float d = length(p - c);
  float g = smoothstep(r * 3.2, r, d);
  float disc = smoothstep(r, r - 0.004, d);
  float lightTheme = step(dot(uPaper, vec3(1.0)), dot(uInk, vec3(1.0)));
  float rim = disc * smoothstep(r - 0.011, r - 0.007, d);
  return core * mix(disc, rim, lightTheme) + glow * (1.0 - 0.5 * lightTheme) * (1.0 - lightTheme * disc) * g * g;
}

// Sparse single-pixel stars that blink on and off (in dither px).
float stars(vec2 fc, float t, float density, float cell) {
  vec2 id = floor(fc / cell);
  float h = hash(id + 17.0);
  if (h < 1.0 - density) return 0.0;
  vec2 f = fract(fc / cell) * cell;
  float on = step(f.x, 1.0) * step(f.y, 1.0);
  // Mostly lit, dipping out now and then.
  return on * step(-0.6, sin(t * (0.6 + h * 1.4) + h * 60.0));
}

// ---------- scenes (p: y-up, height-normalized, origin at centre; a: aspect) ----------
// Composition rules, so each place reads at a glance in 1 bit:
// skies are black at the top and glow toward the horizon, land is silhouette,
// light sources are crisp discs, and nothing fills the frame with a flat low level
// (a flat level shows up as a uniform grid of Bayer dots).

// The landscape fills the bottom of the frame, below the wordmark; the wordmark sits in open sky.
float horizonY(float a) { return a < 0.9 ? -0.31 : -0.26; }

// Black at the top, rising to \`peak\` at the horizon. The small offset makes the glow
// end at exactly zero instead of trailing off into a sparse 1/64 dot screen.
float skyGlow(float s, float peak, float falloff) {
  return max(peak * exp(-max(s, 0.0) * falloff) - 0.03, 0.0);
}

// Light sources shrink on narrow screens and stay inside the frame.
float orbRadius(float r, float a) { return r * clamp(a, 0.6, 1.0); }

#if SCENE == 1
float ocean(vec2 p, vec2 fc, float t, float a) {
  float hz = horizonY(a);
  vec2 moon = vec2(0.38 * min(a, 1.6), 0.34);
  if (p.y > hz) {
    float s = p.y - hz;
    float sky = skyGlow(s, 0.3, 11.0);
    sky += orb(p, moon, orbRadius(0.04, a), 0.95, 0.12);
    sky += stars(fc, t, 0.025, 5.0) * smoothstep(0.12, 0.35, s);
    return sky;
  }
  float d = hz - p.y;                      // 0 at the horizon, growing toward the viewer
  float z = 1.0 / (d * 6.0 + 0.03);        // perspective depth
  // Thin wave crests: long near the horizon, shorter and sparser up close.
  float w = noise(vec2(p.x * z * 1.4 + t * 0.03, z * 2.2 - t * 0.35));
  float crest = smoothstep(0.72, 0.9, w) * (0.28 - 0.2 * smoothstep(0.0, 0.3, d));
  float sea = 0.42 * exp(-d * 70.0) + crest;
  // Moonlight path: widens toward the viewer, made of moving glints. It fades out
  // before the bottom edge so it never glitters around the controls.
  float rx = (p.x - moon.x) / (0.01 + d * 0.28);
  float path = smoothstep(1.0, 0.0, abs(rx)) * smoothstep(0.06, 0.16, p.y + 0.5);
  if (path > 0.0) {
    float glint = smoothstep(0.55, 0.8, noise(vec2(p.x * 38.0 + t * 0.2, z * 7.0 - t * 0.9)));
    sea += path * (0.08 + 0.85 * glint);
  }
  return sea;
}

#endif
#if SCENE == 2
float ridge(float x, float seed, float freq) {
  float n = fbm(vec2(x * freq + seed, seed * 0.37));
  float r = 1.0 - abs(noise(vec2(x * freq * 2.1 + seed * 3.0, seed)) * 2.0 - 1.0);
  return n * 0.55 + r * 0.45;
}

float peaks(vec2 p, vec2 fc, float t, float a) {
  float hz = horizonY(a);
  // Dawn: the sky brightens toward the ridges, with a low sun resting on the far ridge.
  float L = skyGlow(p.y - (hz + 0.04), 0.55, 16.0);
  L += orb(p, vec2(-min(0.42 * min(a, 1.6), 0.5 * a - 0.12), hz + 0.09), orbRadius(0.06, a), 0.95, 0.15);
  // Three ridges, far to near: pale far away, black silhouette up close.
  float bases[3] = float[3](hz + 0.0, hz - 0.07, hz - 0.15);
  float amps[3] = float[3](0.26, 0.18, 0.11);
  float lums[3] = float[3](0.14, 0.05, 0.0);
  float freqs[3] = float[3](1.1, 1.8, 2.6);
  for (int i = 0; i < 3; i++) {
    // ridge() stays below ~0.96, so a ridge never rises above base + amp: skip the sky.
    if (p.y < bases[i] + amps[i]) {
      float h = bases[i] + amps[i] * (ridge(p.x, float(i) * 7.3 + 2.0, freqs[i]) - 0.5) * 2.0;
      if (p.y < h) L = lums[i];
    }
    // Fog drifting along the foot of the two far ridges.
    float fogY = p.y - (bases[i] - amps[i] * 0.45);
    if (i < 2 && abs(fogY) < 0.21) {
      float fog = smoothstep(0.42, 0.68, fbm(vec2(p.x * 1.8 - t * (0.07 + float(i) * 0.03), p.y * 6.0 + float(i) * 4.0)));
      float bandY = fogY * 12.0;
      L += fog * exp(-bandY * bandY) * 0.26;
    }
  }
  return L;
}

#endif
#if SCENE == 3
// ---------- cacti (404 page only: CACTI) ----------
#if CACTI

float segment(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}

// A saguaro standing at the origin, s high: trunk plus two upturned arms (side flips them).
float saguaro(vec2 q, float s, float side) {
  q.x *= side;
  float w = 0.1 * s, arm = 0.075 * s;
  float d = segment(q, vec2(0.0, -0.2 * s), vec2(0.0, s - w), w);
  d = min(d, segment(q, vec2(0.0, 0.36 * s), vec2(-0.3 * s, 0.36 * s), arm));
  d = min(d, segment(q, vec2(-0.3 * s, 0.36 * s), vec2(-0.3 * s, 0.7 * s), arm));
  d = min(d, segment(q, vec2(0.0, 0.52 * s), vec2(0.26 * s, 0.52 * s), arm));
  d = min(d, segment(q, vec2(0.26 * s, 0.52 * s), vec2(0.26 * s, 0.82 * s), arm));
  return d;
}

// One cactus, lit from the sun like the letters: a crisp 1-pixel outline, and the body
// stepped through hard Bayer levels from the sunlit side (1) round to the far side (0).
// Returns -1 outside it. ground: the visible dune surface under it (its foot sinks in).
// Against the sun's disc (dark theme) it is backlit: a plain black silhouette.
float cactus(vec2 p, vec2 base, float s, float side, float ground, vec2 sun, float sunR) {
  vec2 q = p - base;
  if (abs(q.x) > 0.5 * s || q.y > s || p.y < ground - 0.003) return -1.0;
  float d = saguaro(q, s, side);
  if (d > 0.0) return -1.0;
  float px = 1.0 / uRes.y;
  float lightTheme = step(dot(uPaper, vec3(1.0)), dot(uInk, vec3(1.0)));
  if (lightTheme < 0.5 && length(p - sun) < sunR + 2.0 * px) return 0.0;
  if (d > -px) return 1.0;
  // Forward differences: two more distance evaluations instead of four.
  vec2 n = normalize(vec2(saguaro(q + vec2(px, 0.0), s, side) - d, saguaro(q + vec2(0.0, px), s, side) - d));
  // n points out of the nearest edge: the edge facing the sun is the lit one.
  float lit = dot(n, normalize(sun - p));
  return lit > 0.45 ? 1.0 : lit > 0.0 ? 0.5 : lit > -0.45 ? 0.25 : 0.0;
}

#endif

float dune(float x, float base, float amp, float f, float ph) {
  return base + amp * (sin(x * f + ph) * 0.65 + sin(x * f * 2.3 + ph * 1.7) * 0.25 + sin(x * f * 5.1 + ph) * 0.1);
}

float dunes(vec2 p, vec2 fc, float t, float a) {
  float hz = horizonY(a);
  float L = skyGlow(p.y - hz, 0.5, 16.0);
  vec2 sun = vec2(min(0.44 * min(a, 1.6), 0.5 * a - 0.13), hz + 0.07);
  L += orb(p, sun, orbRadius(0.07, a), 0.95, 0.14);

  // Three dune bands: bright crests on the sunlit face falling into shadow.
  float bases[3] = float[3](hz + 0.0, hz - 0.08, hz - 0.17);
  float amps[3] = float[3](0.04, 0.08, 0.12);
  float fs[3] = float[3](3.4, 2.3, 1.5);
  float lit[3] = float[3](0.3, 0.26, 0.22);
  for (int i = 0; i < 3; i++) {
    // dune() never rises above base + amp: skip the sky.
    if (p.y >= bases[i] + amps[i]) continue;
    float ph = float(i) * 2.1 + 0.6;
    float h = dune(p.x, bases[i], amps[i], fs[i], ph);
    if (p.y < h) {
      float slope = dune(p.x + 0.004, bases[i], amps[i], fs[i], ph) - h;
      float face = smoothstep(-0.0004, 0.0004, slope);
      float down = clamp((h - p.y) * 20.0, 0.0, 1.0);
      L = mix(0.0, lit[i] * (1.0 - down), face);
    }
  }
#if CACTI
  // Cacti (404 page) on the visible ridge line, against the glowing horizon: tall on the
  // left, one in front of the sun, a small one right of centre (wide screens only: on a
  // phone it would crowd the sun's). x as a share of the half-width.
  {
    float halfW = 0.5 * a;
    vec3 cx = vec3(-0.8 * halfW, sun.x - 0.04, 0.34 * halfW);
    vec3 cs = vec3(0.17, 0.12, a < 0.9 ? 0.0 : 0.075) * clamp(a, 0.7, 1.0);
    vec3 cside = vec3(-1.0, 1.0, 1.0);
    for (int i = 0; i < 3; i++) {
      if (cs[i] <= 0.0) continue;
      float x = cx[i];
      float g = -1.0, gp = -1.0;
      for (int k = 0; k < 3; k++) {
        float ph = float(k) * 2.1 + 0.6;
        g = max(g, dune(x, bases[k], amps[k], fs[k], ph));
        gp = max(gp, dune(p.x, bases[k], amps[k], fs[k], ph));
      }
      float c = cactus(p, vec2(x, g), cs[i], cside[i], gp, sun, orbRadius(0.07, a));
      if (c >= 0.0) L = c;
    }
  }
#endif
  // Sand haze drifting along the far dunes.
  float hazeY = (p.y - hz + 0.03) * 10.0;
  if (abs(hazeY) > 2.5) return L;
  float haze = smoothstep(0.45, 0.7, fbm(vec2(p.x * 2.4 + t * 0.14, p.y * 10.0)));
  L += haze * 0.22 * exp(-hazeY * hazeY);
  return L;
}

#endif
#if SCENE == 4
float night(vec2 p, vec2 fc, float t, float a) {
  float hz = horizonY(a);
  float L = 0.0;
  // Hills only reach hz + 0.1; above that there is nothing to compute for them.
  if (p.y < hz + 0.2) {
    float hill = hz + 0.02 + 0.08 * (fbm(vec2(p.x * 1.4, 3.0)) - 0.5) * 2.0;
    if (p.y < hill) return 0.0; // black hills
    L = skyGlow(p.y - hill, 0.2, 26.0);
  }
  L += stars(fc, t, 0.03, 5.0) + stars(fc + 41.0, t * 0.8, 0.02, 7.0);
  // The aurora's lower edge never dips below 0.21.
  if (p.y < 0.19) return L;
  // Aurora: curtains above the wordmark that fold and drift slowly.
  float x = p.x * 1.2 + 0.7 * fbm(vec2(p.x * 0.6 + t * 0.01, t * 0.02));
  float yb = 0.27 + 0.06 * sin(x * 2.0 + t * 0.07);
  float above = p.y - yb;
  // Sharp lower edge, long soft fade upward, like real curtains.
  float curtain = smoothstep(-0.02, 0.0, above) * exp(-max(above, 0.0) * 6.0);
  // Distinct vertical rays that shimmer slowly.
  float rays = noise(vec2(x * 30.0, t * 0.12));
  rays = rays * rays * rays;
  float fold = 0.5 + 0.5 * sin(x * 6.0 + t * 0.15);
  L += curtain * (0.04 + 0.75 * rays) * (0.35 + 0.65 * fold);
  return L;
}

#endif
#endif

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = fc / uRes;
  float unit = uRes.y;
  float aspect = uRes.x / uRes.y;



  vec2 p = (fc - 0.5 * uRes) / unit;

  // Crossfades draw the previous scene's program, then this one over a growing,
  // scattered share of the pixels: a dither dissolve (rank is independent of the Bayer).
  if (uDissolve < 1.0 && hash(fc + 911.0) >= uDissolve) discard;

  // This program's background scene (SCENE; none in the letters-only program).
  float bg = 0.0;
#if SCENE == 1
  bg = ocean(p, fc, uTime, aspect);
#elif SCENE == 2
  bg = peaks(p, fc, uTime, aspect);
#elif SCENE == 3
  bg = dunes(p, fc, uTime, aspect);
#elif SCENE == 4
  bg = night(p, fc, uTime, aspect);
#endif

  vec4 m = texture(uMask, uv);
  float stroke = step(0.5, m.r);
  float counter = step(0.5, m.b) * (1.0 - stroke);

  // Knock the scene back around the letters so the wordmark always reads first.
  float clearance = smoothstep(0.04, 0.45, m.g);
  bg *= 1.0 - 0.92 * clearance;

  // Only the background fades in with the intro; the letters develop on their own.
  float L = bg * smoothstep(0.0, 1.0, uIntro);

  if (uUnit > 0.0 && (stroke > 0.0 || counter > 0.0)) {
    // Which unit block this pixel is in, and where inside it.
    vec2 g = vec2(fc.x - uOrigin.x, uOrigin.y - fc.y) / uUnit;
    vec2 block = floor(g);
    float row = mod(block.y, ${ROWS + LINE_GAP}.0);

    // Position across the word (x, -1..1) and down its x-height (y, -1..1), y down.
    vec2 q = vec2((fc.x - 0.5 * uRes.x) / uHalfWidth,
                  (row + fract(g.y) - ${X_TOP}.0 - ${X_HEIGHT / 2}) / ${X_HEIGHT / 2});

    // Bands: top-to-bottom dither tones that run together across the whole word
    // (q.y is the line's x-height position, shared by every letter). The pointer
    // slides and tilts them, never rotates them: pointer up → bands rise (more
    // dissolve), pointer down → bands sink (more solid), pointer sideways → the bands
    // tilt so the solid part reaches lower on that side. All smooth, nothing flips.
    vec2 cOff = vec2((uMouse.x - 0.5 * uRes.x) / max(uHalfWidth, 1.0),
                     (uMouse.y - 0.5 * uRes.y) / (0.5 * uRes.y));
    cOff = clamp(cOff, vec2(-1.3, -1.0), vec2(1.3, 1.0)) * uMouse.z;
    // (The sideways tilt is kept small: with the wave on top, a strong tilt reads as rotation.)
    float t = 0.5 + 0.5 * q.y + 0.32 * cOff.y - 0.13 * cOff.x * q.x;
    // A gentle wave along the band edges, continuous across the whole word. It
    // drifts slowly on its own, and moving the pointer sideways rolls it along.
    float phase = uTime * 0.7 + cOff.x * 1.1;
    t += 0.09 * sin(q.x * 6.5 - phase) + 0.04 * sin(q.x * 13.0 + phase * 1.3);
    t = clamp(t, 0.0, 1.0);
    // Four Bayer levels that tile cleanly in a narrow stroke: 1, 0.75, 0.5, 0.25.
    float level = 1.0 - 0.75 * floor(smoothstep(0.2, 0.95, t) * 3.999) / 3.0;

    // Intro, phase 2: once the outline has drawn on, the fill dithers in left to right,
    // each unit block stepping up through Bayer order, and the counters follow a beat later.
    // Latest start 0.66 + 0.28 long: every block is fully in by 94% of the intro.
    float delay = 0.06 + 0.40 * (0.5 + 0.5 * q.x) + 0.10 * hash(block + 7.0) + 0.10 * counter;
    float develop = floor(smoothstep(delay, delay + 0.28, uIntro) * 4.0) / 4.0;

    if (stroke > 0.0) {
      // A crisp 1-pixel outline traces every letter, so the dithered side stays legible.
      vec2 px = 1.0 / uRes;
      float inside = step(0.5, texture(uMask, uv + vec2(px.x, 0.0)).r)
        * step(0.5, texture(uMask, uv - vec2(px.x, 0.0)).r)
        * step(0.5, texture(uMask, uv + vec2(0.0, px.y)).r)
        * step(0.5, texture(uMask, uv - vec2(0.0, px.y)).r);
      // Intro, phase 1: the outline draws on, pixel by pixel in the shared order (the
      // inline first frame in the HTML draws the same pixels at the same moments).
      float ord = texelFetch(uOrder, ivec2(int(fc.x), int(uRes.y) - 1 - int(fc.y)), 0).r * 255.0;
      float drawn = step(floor(ord + 0.5), uOutline);
      // Solid on the lit side, stepping down through dither tones to the far side.
      L = mix(mix(L, 1.0, drawn), mix(L, level, develop), inside);
    } else {
      // Counters: always one step darker than the stroke beside them.
      L = mix(L, 0.5 * level, develop);
    }
  }

  L = clamp(L, 0.0, 1.0);

  float on = step(bayer8(ivec2(fc)), L);
  outColor = vec4(mix(uInk, uPaper, on), 1.0);
}
`

export interface FragmentOptions {
  /** The background scene (its index in SCENES), or 0 for the letters only. */
  scene: number
  /** Include the cacti (the 404 page's dunes). */
  cacti?: boolean
}

/**
 * The fragment shader for one background: the letters alone (all Plain needs) or the
 * letters over one scene. Each compiles only when it is shown, so a visitor never waits
 * for scenes they do not see; compile time is what they wait for.
 */
export const fragmentShader = (o: FragmentOptions) =>
  FRAGMENT_SOURCE.replace(
    "#version 300 es\n",
    `#version 300 es\n#define SCENES ${o.scene ? 1 : 0}\n#define SCENE ${o.scene}\n#define CACTI ${o.cacti && o.scene === 3 ? 1 : 0}\n`,
  )
