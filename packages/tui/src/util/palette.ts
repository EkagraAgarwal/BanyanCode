import { RGBA } from "@opentui/core"
import { tint } from "../theme"

export type Severity = "success" | "warning" | "error" | "info" | "neutral"

const FILL_ALPHA: Record<Severity, number> = {
  success: 0.18,
  warning: 0.18,
  error: 0.18,
  info: 0.18,
  neutral: 0.10,
}

export function severityFill(panel: RGBA, accent: RGBA, severity: Severity): RGBA {
  const alpha = FILL_ALPHA[severity]
  return tint(panel, accent, alpha)
}

export function pillFill(panel: RGBA, accent: RGBA, severity: Severity): RGBA {
  return tint(panel, accent, FILL_ALPHA[severity] * 0.6)
}
