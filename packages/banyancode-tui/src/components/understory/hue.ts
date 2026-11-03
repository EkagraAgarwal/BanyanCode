import { RGBA } from "@opentui/core"

/**
 * A branch's identity hue. Fixed lightness and chroma, hue stepped by the
 * golden angle so neighbouring spawns stay distinguishable. This is the
 * package-local helper the Agents tab owns; it deliberately does not extend the
 * shared theme package.
 */
const GOLDEN_ANGLE = 137.5
const BASE_HUE = 142

function oklchToRgb(lightness: number, chroma: number, hueDegrees: number): RGBA {
  const hue = (hueDegrees * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const encode = (value: number) =>
    Math.max(0, Math.min(1, value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055))
  return RGBA.fromValues(encode(linear[0]!), encode(linear[1]!), encode(linear[2]!), 1)
}

export function branchHue(index: number, mode: "dark" | "light"): RGBA {
  const hue = index * GOLDEN_ANGLE + BASE_HUE
  return mode === "light" ? oklchToRgb(0.5, 0.14, hue) : oklchToRgb(0.8, 0.115, hue)
}
