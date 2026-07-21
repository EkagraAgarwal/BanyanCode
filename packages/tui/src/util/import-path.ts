import { fileURLToPath } from "url"

export function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export function normalizeImportPath(value: string, platform: string) {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const unquoted =
    trimmed.length >= 2 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1).trim() : trimmed
  return pastedFilepath(unquoted, platform)
}
