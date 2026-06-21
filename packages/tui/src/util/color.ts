export function toHex(color: { r: number; g: number; b: number; a?: number } | string | undefined | null): string {
  if (typeof color === "string") return color
  if (!color) return "#ffffff" // Fallback
  
  const toComponent = (v: number) => {
    const val = v <= 1 ? Math.round(v * 255) : Math.round(v)
    return Math.max(0, Math.min(255, val))
  }
  
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}
