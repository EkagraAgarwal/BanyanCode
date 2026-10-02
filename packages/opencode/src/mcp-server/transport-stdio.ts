// Stdio transport entry for `banyancode mcp serve`.
//
// Stdout discipline: stdout belongs to the JSON-RPC stream owned by
// StdioServerTransport. This module never writes to stdout (no
// console.log/println); diagnostics go to stderr via log().

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer, log, type McpBootstrapOptions } from "./server"

export async function serveStdio(opts: McpBootstrapOptions = {}): Promise<void> {
  const { mcp, cleanup } = await createMcpServer(opts)
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
    await cleanup()
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
