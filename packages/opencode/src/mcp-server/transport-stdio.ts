// Stdio transport entry for `banyancode mcp serve`.
//
// Stdout discipline: stdout belongs to the JSON-RPC stream owned by
// StdioServerTransport. This module never writes to stdout (no
// console.log/println); diagnostics go to stderr via log().

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { InstanceRuntime } from "@/project/instance-runtime"
import { createMcpServer, log, type McpBootstrapOptions } from "./server"

export type StdioShutdownHooks = {
  stopListener: () => Promise<void>
  abortOwnedSessions?: () => Promise<void>
  disposeInstances?: () => Promise<void>
  closeDatabase?: () => Promise<void>
}

// Ordered, best-effort shutdown: listener stop, owned-session aborts, instance
// disposal, DB close. Each step runs even when an earlier one rejects. There is
// no explicit DB close primitive reachable from here — DB layers tear down via
// the listener scope close and instance disposal — so closeDatabase stays an
// optional hook for a future explicit teardown.
export function buildCleanupSteps(hooks: StdioShutdownHooks): () => Promise<void> {
  return async () => {
    await hooks.stopListener().catch(() => {})
    await hooks.abortOwnedSessions?.().catch(() => {})
    await hooks.disposeInstances?.().catch(() => {})
    await hooks.closeDatabase?.().catch(() => {})
  }
}

export type StdioServeOptions = McpBootstrapOptions & {
  abortOwnedSessions?: () => Promise<void>
}

export function buildShutdownCleanup(input: {
  attach?: string
  abortOwnedSessions?: () => Promise<void>
  serverCleanup: () => Promise<void>
  disposeInstances?: () => Promise<void>
  closeDatabase?: () => Promise<void>
}): () => Promise<void> {
  // Attached server owns the lifecycle — leave cleanup a no-op.
  if (input.attach) return input.serverCleanup
  return buildCleanupSteps({
    stopListener: input.serverCleanup,
    abortOwnedSessions: input.abortOwnedSessions,
    disposeInstances: input.disposeInstances ?? (() => InstanceRuntime.disposeAllInstances()),
    closeDatabase: input.closeDatabase,
  })
}

export async function serveStdio(opts: StdioServeOptions = {}): Promise<void> {
  const { mcp, cleanup } = await createMcpServer(opts)
  const runCleanup = buildShutdownCleanup({
    attach: opts.attach,
    abortOwnedSessions: opts.abortOwnedSessions,
    serverCleanup: cleanup,
  })
  const transport = new StdioServerTransport()

  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    try {
      await transport.close()
    } catch {
      // closing a broken stdio pipe must not throw past the CLI handler
    }
    await runCleanup()
  }
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)))
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)))

  await mcp.connect(transport)
  log("stdio transport connected")

  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => void shutdown().then(() => resolve()))
    process.stdin.on("error", () => void shutdown().then(() => resolve()))
    process.stdin.resume()
  })
}

export * as McpTransportStdio from "./transport-stdio"
