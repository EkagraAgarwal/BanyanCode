export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

export function formatAge(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function formatMoney(value: number): string {
  return money.format(value)
}

/** Compact elapsed time for a running row: `9s`, `1m 04s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function bar(done: number, total: number, width = 20): string {
  if (total <= 0) return "░".repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function percentBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent))
  return bar(clamped, 100, width)
}

export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (text.length <= maxWidth) return text
  if (maxWidth === 1) return "…"
  return `${text.slice(0, maxWidth - 1)}…`
}
