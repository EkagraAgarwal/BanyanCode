// Stdio transport entry for `banyancode mcp serve`.
//
// Stdout discipline: stdout belongs to the JSON-RPC stream owned by the
// stdio transport. This module never writes to stdout (no
// console.log/println); diagnostics go to stderr via log().
//
// Dual-era (gap-plan D0): serving goes through v2 `serveStdio` with a
// factory over the prebuilt McpServer. The opening exchange pins the
// connection era — a 2026-07-28 `server/discover` opening serves modern
// per-request `_meta`, a legacy `initialize` opening serves 2025-era
// clients — from the same tool registrations. The default
// `legacy: "serve"` keeps both; a legacy-only or modern-only server is
// not an option (modern-only clients fail against legacy-only servers).

import { stdin, stdout } from "node:process"
import { StdioServerTransport, serveStdio as serveMcpStdio } from "@modelcontextprotocol/server/stdio"
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
  // One stdio connection pins one factory instance for its lifetime, so the
  // prebuilt server is served directly. serveStdio owns the transport: it
  // starts it, receives every inbound message, and closes it when done.
  //
  // The streams are passed explicitly from node:process rather than relying
  // on the transport defaults: v2 reads its default stdio streams through
  // an environment-conditioned `process` shim, and any run under
  // `--conditions=browser` (dev CLI, stdio e2e spawn) resolves the browser
  // stub whose stdin/stdout getters throw. Explicit streams bypass the
  // stub under every condition set; the packaged binary is unaffected.
  const transport = new StdioServerTransport(stdin, stdout)
  const handle = serveMcpStdio(() => mcp, { transport })

  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    try {
      await handle.close()
    } catch {
      // closing a broken stdio pipe must not throw past the CLI handler
    }
    await runCleanup()
  }
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)))
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)))

  log("stdio transport connected")

  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => void shutdown().then(() => resolve()))
    process.stdin.on("error", () => void shutdown().then(() => resolve()))
    process.stdin.resume()
  })
}

export * as McpTransportStdio from "./transport-stdio"
