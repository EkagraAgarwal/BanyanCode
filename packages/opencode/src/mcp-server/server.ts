// Bootstrap for `banyancode mcp serve`.
//
// Mirrors the shape of packages/opencode/src/cli/cmd/acp.ts:19-30:
// an in-process Server.listen on loopback, with an SDK v2 client built
// against it via ServerAuth.headers. Read-only code tools register here;
// task lifecycle and verify/memory registration land with their phases.

import path from "path"
import { stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export type McpBootstrapOptions = {
  cwd?: string
  attach?: string
  allowYolo?: boolean
}

export type McpBootstrap = {
  mcp: McpServer
  sdk: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
  baseUrl: string
  cwd: string
  cleanup: () => Promise<void>
}

// Stdout belongs to the MCP protocol in stdio mode. All diagnostics go
// to stderr so no non-JSON-RPC bytes ever land on stdout.
export function log(message: string) {
  process.stderr.write(`[mcp-server] ${message}\n`)
}

export async function resolveCwd(input?: string): Promise<string> {
  const raw = input ?? process.cwd()
  const resolved = path.resolve(raw)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    throw new Error(`--cwd does not exist: ${raw}`)
  }
  if (!info.isDirectory()) throw new Error(`--cwd is not a directory: ${raw}`)
  return resolved
}

// Resolved-path guard: every per-request path argument must resolve
// inside the project root (see the path-traversal lesson in AGENTS.md).
export function assertInsideRoot(root: string, input: string): string {
  const resolved = path.resolve(root, input)
  const relative = path.relative(root, resolved)
  if (relative === "") return resolved
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes --cwd: ${input}`)
  }
  return resolved
}

export async function createMcpServer(opts: McpBootstrapOptions = {}): Promise<McpBootstrap> {
  const cwd = await resolveCwd(opts.cwd)
  const { ServerAuth } = await import("@/server/auth")
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")

  const mcp = new McpServer({ name: "banyancode", version: InstallationVersion })
  const { registerCodeTools } = await import("./tools-code")

  if (opts.attach) {
    const baseUrl = opts.attach
    const sdk = createOpencodeClient({ baseUrl, headers: ServerAuth.headers() })
    registerCodeTools(mcp, { sdk, cwd })
    log(`attached to running server at ${baseUrl} (cwd ${cwd})`)
    return { mcp, sdk, baseUrl, cwd, cleanup: async () => {} }
  }

  // Fresh in-process server: loopback bind, random per-process password
  // that is never printed. The server reads OPENCODE_SERVER_PASSWORD via
  // a per-listener ConfigProvider, so set env before listen.
  const password = randomBytes(32).toString("base64url")
  process.env.OPENCODE_SERVER_PASSWORD = password
  const { Server } = await import("@/server/server")
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: [] })
  const baseUrl = `http://${listener.hostname}:${listener.port}`
  const sdk = createOpencodeClient({ baseUrl, headers: ServerAuth.headers({ password }) })
  registerCodeTools(mcp, { sdk, cwd })
  log(`in-process server listening on ${baseUrl} (cwd ${cwd})`)
  return {
    mcp,
    sdk,
    baseUrl,
    cwd,
    cleanup: async () => {
      await listener.stop(true).catch(() => {})
    },
  }
}

export * as McpBootstrapServer from "./server"
