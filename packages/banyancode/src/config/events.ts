/**
 * Process-local `config.updated` notifier.
 *
 * v1 published `banyancode.config.updated` from the config service so every
 * client (TUI, SDK, MCP) refreshed after a write. The v2 plugin writes through
 * `writer.ts`, which is plain async fs code and has no RPC registration in
 * scope, so the writer reports here and `server.ts` bridges the same call to
 * the plugin's `banyancode.config.updated` RPC event once the definition is
 * registered.
 *
 * The listener is process-wide on purpose: exactly one plugin instance owns a
 * project location, and tests that exercise the writer without a plugin simply
 * leave it unset.
 */

export interface ConfigUpdatedEvent {
  readonly scope?: "global" | "project"
  readonly file?: string
}

type Listener = (event: ConfigUpdatedEvent) => void

let listener: Listener | undefined

export const setConfigUpdatedListener = (next: Listener | undefined): void => {
  listener = next
}

/** Never throws: a subscriber failure must not fail a config write. */
export const notifyConfigUpdated = (event: ConfigUpdatedEvent): void => {
  try {
    listener?.(event)
  } catch {
    // intentionally ignored
  }
}
