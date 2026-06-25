/** @jsxImportSource @opentui/solid */
import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home.replaceAll("\\", "/"), input.replaceAll("\\", "/"))
  if (relative === "") return "~"
  const normalizedRelative = relative.replaceAll("\\", "/")
  if (normalizedRelative === ".." || normalizedRelative.startsWith("../") || path.isAbsolute(normalizedRelative)) {
    return input.replaceAll("\\", "/")
  }
  return "~/" + normalizedRelative
}
