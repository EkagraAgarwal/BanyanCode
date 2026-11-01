import type { Info as BanyanConfigInfo } from "../config/schema.js"
import { DEFAULT_LSP_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs } from "../lsp/config.js"
import { snapshot, subscribe } from "../lsp/state.js"

/**
 * LSP status for the TUI pill/panel.
 *
 * The runtime lives in `src/lsp/**` (parity G1). When it is registered it
 * binds a live snapshot provider; this module reports that snapshot verbatim,
 * so attached servers show `connected` with their pid and configured servers
 * show `inert: true` until a file of their language is touched.
 *
 * The config-derived view is only a fallback for builds/tests where the LSP
 * runtime was not registered (for example a plugin scope created without the
 * `lsp` workstream). It never claims a server is connected.
 */

export { DEFAULT_LSP_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs }

export interface LspServerStatus {
  readonly id: string
  readonly name?: string
  readonly root?: string
  readonly status: "configured" | "connected" | "error"
  readonly languages?: readonly string[]
  readonly inert?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly clientCount?: number
  readonly pid?: number
}

export interface LspStatus {
  readonly enabled: boolean
  readonly idleTimeoutMs: number
  readonly servers: readonly LspServerStatus[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fromConfig = (config: BanyanConfigInfo): LspStatus => {
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
        : { disabledReason: "LSP runtime is not active in this session" }),
    }
  })
  return { enabled: true, idleTimeoutMs, servers }
}

const disabledByConfig = (live: LspStatus): LspStatus => ({
  enabled: false,
  idleTimeoutMs: live.idleTimeoutMs,
  servers: live.servers.map((server) => ({
    ...server,
    status: "configured" as const,
    inert: true,
    disabled: true,
    disabledReason: server.disabledReason ?? "Disabled by banyancode_lsp",
  })),
})

export const lspStatus = (config: BanyanConfigInfo): LspStatus => {
  const live = snapshot()
  if (!live) return fromConfig(config)
  if (config.banyancode_lsp === false) return disabledByConfig(live)
  return live
}

/**
 * Push-style hook for the system surface. The runtime notifies on attach /
 * detach / reload; a caller holding the `banyancode.system` RPC registration
 * can publish `lsp.status`-equivalent data (see the `lsp.updated` event note in
 * `src/system/rpc.ts`). Returning the unsubscribe makes scope cleanup simple.
 */
export const onLspStatus = subscribe
