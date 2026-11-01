import type { Info as BanyanConfigInfo } from "../config/schema.js"

/**
 * LSP status for the TUI pill/panel.
 *
 * v2 has **no LSP runtime** (see `specs/banyancode/v2-parity-gaps.md`): the
 * host schema carries `lsp` config and an empty `lsp.updated` event, but no
 * client manager. This module therefore reports the BanyanCode config as the
 * source of truth and marks every entry `inert`, so the UI can render
 * "configured, not attached" instead of pretending a server is connected.
 *
 * `banyancode_lsp_idle_timeout_ms` has no consumer in v2 for the same reason
 * (v1 read it in `packages/opencode/src/lsp/lsp.ts:resolveLspIdleTimeoutMs`).
 */

export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export interface LspServerStatus {
  readonly id: string
  readonly status: "configured" | "connected" | "error"
  readonly languages?: readonly string[]
  readonly inert?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export interface LspStatus {
  readonly enabled: boolean
  readonly idleTimeoutMs: number
  readonly servers: readonly LspServerStatus[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const resolveIdleTimeoutMs = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LSP_IDLE_TIMEOUT_MS
  return Math.trunc(raw)
}

export const lspStatus = (config: BanyanConfigInfo): LspStatus => {
  const raw = config.banyancode_lsp
  const idleTimeoutMs = resolveIdleTimeoutMs(config.banyancode_lsp_idle_timeout_ms)
  if (raw === true) return { enabled: true, idleTimeoutMs, servers: [] }
  if (raw === false || raw === undefined) return { enabled: false, idleTimeoutMs, servers: [] }
  if (!isRecord(raw)) return { enabled: false, idleTimeoutMs, servers: [] }
  const servers = Object.entries(raw).map(([id, entry]): LspServerStatus => {
    const detail = (isRecord(entry) ? entry : {}) as Record<string, unknown>
    const disabled = detail.disabled === true
    return {
      id,
      status: "configured",
      languages: Array.isArray(detail.extensions)
        ? detail.extensions.filter((extension): extension is string => typeof extension === "string")
        : [],
      inert: true,
      disabled,
      ...(disabled
        ? { disabledReason: "Disabled by banyancode_lsp" }
        : { disabledReason: "LSP runtime is not available in this host build" }),
    }
  })
  return { enabled: true, idleTimeoutMs, servers }
}
