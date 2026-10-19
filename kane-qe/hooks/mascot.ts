// The kane mascot, in the design of LambdaTest/kane-cli#202: the helmet whose eyes glance left, then right, then blink.
//
// One drawing, an 8 by 6 pixel version of each pose (PIXELS), shown two ways:
//  - a terminal's cell grid (one cell holds two pixel rows, so three rows tall);
//  - an SVG of one square per pixel, for surfaces that show images.

export type Pose = 'c' | 'lm' | 'l' | 'rm' | 'r' | 'xh' | 'x'
export type Frame = readonly string[]

/** The length of one step of the loop, in ms. */
export const STEP_MS = 120
/** The loop follows the GIF: rest, glance left, glance right, rest, blink, rest. */
const LOOP: readonly Pose[] = ['c', 'c', 'c', 'c', 'lm', 'l', 'l', 'l', 'lm', 'rm', 'r', 'r', 'r', 'r', 'rm', 'c', 'c', 'c', 'x', 'c', 'c', 'c']

/** The pose to show: resting, or step `n` of the loop. */
export function poseAt(think: boolean, n: number): Pose {
  return think ? (LOOP[n % LOOP.length] ?? 'c') : 'c'
}

export const MASCOT = {
  width: 8,
  height: 6,
  palette: {"1": "#cdb8ff", "2": "#ae96ff", "3": "#8d7af6", "4": "#6d64ea", "5": "#4f50d4", "v": "#0c0e19", "w": "#1d2236", "g": "#5a6c9c", "h": "#a6e4ff", "k": "#ffffff"} as Record<string, string>,
} as const

const PIXELS: Record<'c' | 'l' | 'r' | 'x', Frame> = {
  "c": [
    "..1..3..",
    ".122233.",
    "2vvvvvv4",
    "2vkvvkv4",
    "33444455",
    ".344555."
  ],
  "l": [
    "..1..3..",
    ".122233.",
    "2vvvvvv4",
    "2kvvkvv4",
    "33444455",
    ".344555."
  ],
  "r": [
    "..1..3..",
    ".122233.",
    "2vvvvvv4",
    "2vvkvvk4",
    "33444455",
    ".344555."
  ],
  "x": [
    "..1..3..",
    ".122233.",
    "2vvvvvv4",
    "2vgvvgv4",
    "33444455",
    ".344555."
  ]
}

/** The pixel frame for a pose; the in-between poses use the nearest full one. */
export function pixelFrame(pose: Pose): Frame {
  return PIXELS[pose === 'lm' ? 'l' : pose === 'rm' ? 'r' : pose === 'xh' ? 'x' : pose]
}

const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584
const SPACE = 0x20

function rgb(key: string | undefined): number | undefined {
  const hex = key === undefined ? undefined : MASCOT.palette[key]
  return hex === undefined ? undefined : Number.parseInt(hex.slice(1), 16)
}

function base64(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    out += b === undefined ? '=' : A[(n >> 6) & 63]!
    out += c === undefined ? '=' : A[n & 63]!
  }
  return out
}

/** A frame as a terminal Raster's cells: two pixel rows per cell, drawn with half blocks. */
export function rasterCells(frame: Frame): string {
  const words: number[] = []
  for (let y = 0; y < MASCOT.height; y += 2) {
    for (let x = 0; x < MASCOT.width; x++) {
      const top = rgb(frame[y]?.[x])
      const bottom = rgb(frame[y + 1]?.[x])
      if (top !== undefined && bottom !== undefined) words.push(UPPER, top, bottom)
      else if (top !== undefined) words.push(UPPER, top, DEFAULT)
      else if (bottom !== undefined) words.push(LOWER, bottom, DEFAULT)
      else words.push(SPACE, DEFAULT, DEFAULT)
    }
  }
  return pack(words)
}

/** Cell words (code point, foreground, background) as a Raster takes them: little-endian u32s, base64. */
function pack(words: readonly number[]): string {
  const bytes = new Uint8Array(words.length * 4)
  words.forEach((w, i) => {
    bytes[i * 4] = w & 255
    bytes[i * 4 + 1] = (w >> 8) & 255
    bytes[i * 4 + 2] = (w >> 16) & 255
    bytes[i * 4 + 3] = (w >> 24) & 255
  })
  return base64(bytes)
}

/** The spinner drawn before a step while its test runs: one cell, stepping with the mascot. */
const SPIN = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
export const spinnerGlyph = (n: number): string => SPIN[((n % SPIN.length) + SPIN.length) % SPIN.length]!
/** That spinner as a one-cell terminal Raster, in `color` (`#rrggbb`). */
export function spinnerCells(n: number, color: string): string {
  return pack([spinnerGlyph(n).codePointAt(0)!, Number.parseInt(color.slice(1), 16), DEFAULT])
}

export const RASTER = { columns: MASCOT.width, rows: MASCOT.height / 2 } as const

/** The mascot's size where it is drawn as a picture: its 8 by 6 pixels, six units each. */
export const PICTURE = { width: MASCOT.width * 6, height: MASCOT.height * 6 } as const

/** The mascot for surfaces that show images: the pose's pixel frame, one square per pixel, as an SVG. */
export function mascotSvg(pose: Pose): string {
  const frame = pixelFrame(pose)
  const cells: string[] = []
  frame.forEach((row, y) => {
    ;[...row].forEach((key, x) => {
      const fill = MASCOT.palette[key]
      if (fill !== undefined) cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`)
    })
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE.width}" height="${PICTURE.height}" viewBox="0 0 ${MASCOT.width} ${MASCOT.height}" shape-rendering="crispEdges">` +
    cells.join('') +
    `</svg>`
  )
}
