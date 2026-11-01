import type { LspStatus } from "./types.js"

/**
 * Live LSP status registry.
 *
 * The LSP runtime and the `banyancode.system` status reader live in different
 * modules with no dependency edge (the plugin composes them independently).
 * The runtime binds a snapshot provider here; `src/system/lsp.ts` reads it so
 * `lsp.status` reports attached clients instead of the static "inert" view.
 *
 * Listeners are synchronous and few; nothing is queued or forked per event.
 */

export type StatusProvider = () => LspStatus

let provider: StatusProvider | undefined
const listeners = new Set<(status: LspStatus) => void>()

export const bind = (next: StatusProvider): (() => void) => {
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}

export const snapshot = (): LspStatus | undefined => provider?.()

export const notifyChange = (): void => {
  if (!provider) return
  const status = provider()
  for (const listener of [...listeners]) {
    try {
      listener(status)
    } catch {
      // A listener must never break the runtime.
    }
  }
}

export const subscribe = (listener: (status: LspStatus) => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
