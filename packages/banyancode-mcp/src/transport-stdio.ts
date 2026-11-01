// Stdio transport for `banyancode mcp serve`.
//
// Stdout is the JSON-RPC stream: this module never writes to it. Diagnostics
// go to stderr (logging.ts). One stdio connection pins one McpServer instance
// for its lifetime; the task engine behind it is process-wide, which is what
// lets delegated tasks outlive the client.

import { stdin, stdout } from "node:process"
import { StdioServerTransport, serveStdio as serveMcpStdio } from "@modelcontextprotocol/server/stdio"
import type { McpBootstrap } from "./server"
import { log } from "./logging"

export type StdioServeOptions = {
  create: () => McpBootstrap
  onShutdown?: () => Promise<void> | void
}

export async function serveStdio(options: StdioServeOptions): Promise<void> {
  const bootstrap = options.create()
  const handle = serveMcpStdio(() => bootstrap.mcp, {
    transport: new StdioServerTransport(stdin, stdout),
  })
  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    await handle.close().catch(() => undefined)
    await bootstrap.close().catch(() => undefined)
    await Promise.resolve(options.onShutdown?.()).catch(() => undefined)
  }
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)))
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)))
  log("stdio transport connected")
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => void shutdown().then(resolve))
    process.stdin.on("error", () => void shutdown().then(resolve))
    process.stdin.resume()
  })
}

export * as TransportStdio from "./transport-stdio"
