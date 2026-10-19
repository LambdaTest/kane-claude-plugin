// The kane mascot, in the design of LambdaTest/kane-cli#202: the helmet whose eyes glance left, then right, then blink.
//
// Two drawings of the same poses:
//  - PNG: frames cut from that pull request's dark-theme GIF, shrunk to band size, for surfaces that show images.
//  - PIXELS: an 8 by 6 pixel version for a terminal's cell grid (one cell holds two pixel rows, so three rows tall).

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

export const PICTURE = { width: 50, height: 44 } as const
const PNG_W = 99
const PNG_H = 88
/** The poses that have a picture, each shipped as `assets/mascot/<pose>.png`. */
export const POSES: readonly Pose[] = ['c', 'lm', 'l', 'rm', 'r', 'xh', 'x']
/** The picture frames as base64 PNG, once read from the plugin's files. */
const PNG: Partial<Record<Pose, string>> = {}
/** Keeps a pose's picture, read from its file. */
export function setPicture(pose: Pose, base64: string) {
  PNG[pose] = base64
}


const EYE_DX: Record<Pose, number> = { c: 0, lm: -3, l: -6, rm: 3, r: 6, xh: 0, x: 0 }

/** A plain vector stand-in, drawn small behind the picture: it shows until the picture is read, or if a surface drops the embedded image. */
function standIn(dx: number): string {
  return `<g transform="translate(13 12) scale(0.76)">` +
    `<defs><linearGradient id="s" x1="0.1" y1="0.05" x2="0.9" y2="0.95"><stop offset="0" stop-color="#d6c4ff"/><stop offset="0.5" stop-color="#a48cfa"/><stop offset="1" stop-color="#6f7cf2"/></linearGradient>` +
    `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a36"/><stop offset="1" stop-color="#0d0d14"/></linearGradient></defs>` +
    `<rect x="25" y="9" width="15" height="18" rx="4.5" transform="rotate(-9 32 15)" fill="url(#s) #b79cff"/>` +
    `<rect x="56" y="9" width="15" height="18" rx="4.5" transform="rotate(9 64 15)" fill="url(#s) #a48cfa"/>` +
    `<rect x="6" y="38" width="10" height="24" rx="5" fill="#9f8bf8"/><rect x="80" y="38" width="10" height="24" rx="5" fill="#6f7cf2"/>` +
    `<ellipse cx="48" cy="50" rx="37" ry="35" fill="url(#s) #a48cfa"/>` +
    `<rect x="14" y="29" width="68" height="36" rx="15" fill="url(#v) #14121c"/>` +
    `<ellipse cx="48" cy="68" rx="13" ry="6.5" fill="#8e86f6"/>` +
    `<path d="M21 39 Q18.5 47 21.5 56" stroke="#ffffff" stroke-opacity="0.4" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
    `<g transform="translate(${dx} 0)"><rect x="27" y="42" width="18" height="10" rx="5" fill="#cdb8ff" fill-opacity="0.35"/><rect x="51" y="42" width="18" height="10" rx="5" fill="#cdb8ff" fill-opacity="0.35"/>` +
    `<rect x="29" y="44" width="14" height="6" rx="3" fill="#ffffff"/><rect x="53" y="44" width="14" height="6" rx="3" fill="#ffffff"/></g></g>`
}

/** The mascot for surfaces that show images: the picture for a pose, as an SVG; the vector stand-in alone until the picture is read. */
export function mascotSvg(pose: Pose): string {
  const png = PNG[pose]
  const data = png === undefined ? undefined : `data:image/png;base64,${png}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PICTURE.width}" height="${PICTURE.height}" viewBox="0 0 ${PNG_W} ${PNG_H}">` +
    standIn(EYE_DX[pose]) +
    (data === undefined ? '' : `<image href="${data}" xlink:href="${data}" x="0" y="0" width="${PNG_W}" height="${PNG_H}"/>`) +
    `</svg>`
  )
}
