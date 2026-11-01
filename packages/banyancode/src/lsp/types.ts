import type { ChildProcessWithoutNullStreams } from "node:child_process"

/** Minimal view of the location a language server is bound to. */
export interface Instance {
  readonly directory: string
  readonly worktree: string
}

export interface Handle {
  readonly process: ChildProcessWithoutNullStreams
  readonly initialization?: Record<string, unknown>
}

export type RootFunction = (file: string, ctx: Instance) => Promise<string | undefined>

/**
 * Built-in (or config-defined) language server definition. Mirrors v1
 * `packages/opencode/src/lsp/server.ts` `Info`.
 */
export interface Info {
  readonly id: string
  readonly extensions: string[]
  readonly global?: boolean
  /** True when the server downloads and manages its own binary at runtime. */
  readonly autoDownload?: boolean
  readonly root: RootFunction
  readonly spawn: (root: string, ctx: Instance, flags: Flags) => Promise<Handle | undefined>
}

export interface Flags {
  /** `OPENCODE_DISABLE_LSP_DOWNLOAD` / `BANYANCODE_DISABLE_LSP_DOWNLOAD`. */
  readonly disableLspDownload: boolean
  /** `OPENCODE_EXPERIMENTAL_LSP_TY` selects `ty` over `pyright`. */
  readonly experimentalLspTy: boolean
  /** `OPENCODE_EXPERIMENTAL_LSP_TOOL` / `BANYANCODE_EXPERIMENTAL_LSP_TOOL`. */
  readonly experimentalLspTool: boolean
}

export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface Diagnostic {
  readonly range: Range
  readonly severity?: number
  readonly code?: string | number
  readonly message: string
  readonly source?: string
}

export interface DocumentSymbol {
  readonly name: string
  readonly detail?: string
  readonly kind: number
  readonly range: Range
  readonly selectionRange: Range
}

export interface Symbol {
  readonly name: string
  readonly kind: number
  readonly location: { readonly uri: string; readonly range: Range }
}

/** Live status row reported through `banyancode.system.lsp.status`. */
export interface LspServerStatus {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly status: "configured" | "connected" | "error"
  readonly autoDownload: boolean
  readonly languages: readonly string[]
  readonly inert: boolean
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly clientCount?: number
  readonly pid?: number
}

export interface LspStatus {
  readonly enabled: boolean
  readonly idleTimeoutMs: number
  readonly servers: readonly LspServerStatus[]
}

export interface Location {
  readonly file: string
  readonly line: number
  readonly character: number
}
