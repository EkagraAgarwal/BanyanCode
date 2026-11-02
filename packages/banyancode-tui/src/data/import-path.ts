import { fileURLToPath } from "node:url"

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (!raw.startsWith("file://")) return platform === "win32" ? raw : raw.replace(/\\(.)/g, "$1")
  try {
    return fileURLToPath(raw)
  } catch {
    return raw
  }
}

/** Accepts quoted paths and `file://` URLs, the shapes a terminal paste produces. */
export function normalizeImportPath(value: string, platform: string) {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const unquoted =
    trimmed.length >= 2 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1).trim() : trimmed
  return pastedFilepath(unquoted, platform)
}
