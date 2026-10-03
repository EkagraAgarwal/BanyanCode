// Stateless Streamable HTTP transport for `banyancode mcp serve --http` (gap-plan D3).
//
// Stateless means: no `Mcp-Session-Id` anywhere — `createMcpHandler` is used
// with its defaults (no `sessionIdGenerator`), so every POST is served by a
// fresh per-request server from the factory and nothing is keyed off a
// connection. Cross-call state lives only in explicit handles (task IDs)
// owned by the shared TaskEngine (one engine serves every request).
//
// Security gates run IN FRONT of the handler — the entry itself is
// deliberately validation-free by SDK design:
//  1. bearer auth (401): `Authorization: Bearer <token>`, constant-time compare.
//  2. Origin check (403): SDK `originValidationResponse` against
//     `localhostAllowedOrigins()` (DNS rebinding protection). A missing Origin
//     passes (non-browser clients); a present-but-foreign one is rejected.
// The `Mcp-Method`/`Mcp-Name` routable headers (SEP-2243, `HeaderMismatchError`
// code -32020) are enforced by the SDK's inbound ladder inside
// `createMcpHandler`; the acceptance tests pin that behavior through real HTTP.
//
// Bind policy: loopback by default; a bearer token is always required
// (explicit via --token/BANYANCODE_MCP_TOKEN, else a random per-process token
// logged to stderr). A non-loopback bind is refused unless --hostname was
// passed explicitly AND the token is explicit.

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  McpServer,
  createMcpHandler,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { createMcpServer, isToolGroupEnabled, log, type McpBootstrapOptions } from "./server"

export const DEFAULT_HTTP_HOSTNAME = "127.0.0.1" as const
export const MCP_TOKEN_ENV = "BANYANCODE_MCP_TOKEN" as const

export type McpServerFactory = () => McpServer | Promise<McpServer>

export type HttpServeOptions = McpBootstrapOptions & {
  port?: number
  hostname?: string
  token?: string
}

// --- pure policy helpers (unit-testable without sockets) --------------------

// Loopback-class hosts. Bracketed ::1 included (Host headers carry brackets).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

// Token resolution: explicit flag wins, then env, else a random per-process
// token (still a real secret — logged to stderr so the operator can hand it
// to the client). `explicit` drives the non-loopback gate below.
export function resolveHttpToken(input: {
  flag?: string
  env?: NodeJS.ProcessEnv
}): { token: string; explicit: boolean } {
  if (input.flag !== undefined && input.flag !== "") return { token: input.flag, explicit: true }
  const fromEnv = input.env?.[MCP_TOKEN_ENV]
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, explicit: true }
  return { token: randomBytes(32).toString("base64url"), explicit: false }
}

// Refuse a non-loopback bind unless the operator asked for it explicitly
// (--hostname) AND supplied a real credential (not a generated one).
export function assertHttpBindAllowed(input: {
  hostname: string
  hostnameExplicit: boolean
  tokenExplicit: boolean
}): void {
  if (isLoopbackHost(input.hostname)) return
  if (!input.hostnameExplicit || !input.tokenExplicit) {
    throw new Error(
      `mcp serve --http: refusing non-loopback bind on ${input.hostname} — ` +
        `pass --hostname explicitly together with an explicit bearer token ` +
        `(--token or ${MCP_TOKEN_ENV}).`,
    )
  }
}

function unauthorized(message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="${message}"` },
    },
  )
}

export function checkBearerAuth(authorization: string | null | undefined, token: string): Response | undefined {
  if (typeof authorization !== "string") return unauthorized("missing Authorization header")
  const prefix = "Bearer "
  if (!authorization.startsWith(prefix)) return unauthorized("Authorization scheme must be Bearer")
  const presented = authorization.slice(prefix.length)
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized("invalid bearer token")
  return undefined
}

// --- fetch-level gate --------------------------------------------------------

// One handler for the process lifetime; the factory inside it is invoked per
// request, so every exchange gets a fresh server while the engine (task
// handles, queue, sweep) is shared.
export function createHttpFetchHandler(
  factory: McpServerFactory,
  input: { token: string },
): {
  fetch: (req: Request) => Promise<Response>
  close: () => Promise<void>
} {
  const handler = createMcpHandler(factory)
  return {
    fetch: async (req: Request): Promise<Response> => {
      const authFailure = checkBearerAuth(req.headers.get("authorization"), input.token)
      if (authFailure) return authFailure
      const originFailure = originValidationResponse(req, localhostAllowedOrigins())
      if (originFailure) return originFailure
      return handler.fetch(req)
    },
    close: () => handler.close(),
  }
}

// --- per-request factory over the shared bootstrap ---------------------------
//
// Mirrors the registration section of `wire()` in server.ts against a FRESH
// McpServer per call, sharing the bootstrap engine (the stateful core: task
// table, queue, event drain). Registration is pure — closures over the same
// sdk and engine — so every request sees identical tools. If server.ts ever
// exports its own factory (see the D1 report), this mirror collapses to it.

function readSessionMetadata(data: unknown): Record<string, string> {
  const root = (data ?? {}) as { metadata?: unknown; info?: { metadata?: unknown } }
  const raw = root.metadata ?? root.info?.metadata ?? {}
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

// --- node:http listener -------------------------------------------------------

function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export type HttpListener = {
  url: string
  hostname: string
  port: number
  close: () => Promise<void>
}

export async function listenHttp(
  fetch: (req: Request) => Promise<Response>,
  input: { port?: number; hostname?: string },
): Promise<HttpListener> {
  const hostname = input.hostname ?? DEFAULT_HTTP_HOSTNAME
  const port = input.port ?? 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readNodeBody(req)
        const url = `http://${req.headers.host ?? `${hostname}:${port}`}${req.url ?? "/"}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v)
          } else {
            headers.set(key, value)
          }
        }
        const webReq = new Request(url, {
          method: req.method ?? "GET",
          headers,
          body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
        })
        const webRes = await fetch(webReq)
        const outBody = Buffer.from(await webRes.arrayBuffer())
        const outHeaders: Record<string, string> = {}
        webRes.headers.forEach((value, key) => {
          outHeaders[key] = value
        })
        res.writeHead(webRes.status, outHeaders)
        res.end(outBody)
      } catch {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }))
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  const boundPort = typeof address === "object" && address !== null ? address.port : port
  return {
    url: `http://${hostname}:${boundPort}/mcp`,
    hostname,
    port: boundPort,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

// --- top-level serve ----------------------------------------------------------

export async function serveHttp(opts: HttpServeOptions = {}): Promise<void> {
  const hostname = opts.hostname ?? DEFAULT_HTTP_HOSTNAME
  const hostnameExplicit = opts.hostname !== undefined
  const { token, explicit: tokenExplicit } = resolveHttpToken({ flag: opts.token, env: process.env })
  assertHttpBindAllowed({ hostname, hostnameExplicit, tokenExplicit })
  if (!tokenExplicit) log(`generated bearer token for this process (pass --token to set your own)`)

  const bootstrap = await createMcpServer(opts)
  // The sessions client resolves once; per-request servers share it and the
  // engine. The factory below is async-capable per the McpServerFactory
  // contract, so no sync/async split is needed.
  const { createSdkSessionClient, splitModelRef } = await import("./session-client")
  const { buildRuleset } = await import("./policy")
  // buildRuleset returns a readonly array; copy to the mutable PermissionRuleset.
  const ruleset = buildRuleset(bootstrap.config.permission, bootstrap.cwd).map((row) => ({ ...row }))
  const defaultModel =
    bootstrap.config.defaultModel !== undefined ? splitModelRef(bootstrap.config.defaultModel) : undefined
  const sessions = await createSdkSessionClient({
    sdk: bootstrap.sdk,
    directory: bootstrap.cwd,
    ...(bootstrap.config.defaultAgent !== undefined ? { defaultAgent: bootstrap.config.defaultAgent } : {}),
    ...(defaultModel !== undefined
      ? { defaultModel: { providerID: defaultModel.providerID, id: defaultModel.modelID } }
      : {}),
    permission: ruleset,
    metadata: { origin: "mcp" },
  })
  const { registerCodeTools } = await import("./tools-code")
  const { registerVerifyMemoryTools } = await import("./tools-verify-memory")
  const { registerTaskTools } = await import("./tools-task")
  const factory: McpServerFactory = async () => {
    const mcp = new McpServer({ name: "banyancode", version: InstallationVersion })
    if (isToolGroupEnabled(bootstrap.config.toolGroups, "code")) {
      registerCodeTools(mcp, { sdk: bootstrap.sdk, cwd: bootstrap.cwd })
    }
    if (
      isToolGroupEnabled(bootstrap.config.toolGroups, "verify") ||
      isToolGroupEnabled(bootstrap.config.toolGroups, "memory")
    ) {
      registerVerifyMemoryTools(mcp, {
        sdk: bootstrap.sdk,
        cwd: bootstrap.cwd,
        outputChars: bootstrap.config.outputChars,
      })
    }
    if (bootstrap.engine !== undefined && isToolGroupEnabled(bootstrap.config.toolGroups, "task")) {
      registerTaskTools(mcp, {
        engine: bootstrap.engine,
        sessions,
        directory: bootstrap.cwd,
        updateMetadata: async (input) => {
          const directory = bootstrap.cwd
          const got = await bootstrap.sdk.session.get({ sessionID: input.sessionID, directory })
          if (!("data" in got) || got.data === undefined || got.data === null) {
            throw new Error(`session.get returned no data for ${input.sessionID}`)
          }
          const merged = { ...readSessionMetadata(got.data), ...input.metadata }
          const updated = await bootstrap.sdk.session.update({ sessionID: input.sessionID, directory, metadata: merged })
          if ("error" in updated && updated.error !== undefined && updated.error !== null) {
            throw new Error(`session.update failed for ${input.sessionID}: ${JSON.stringify(updated.error)}`)
          }
        },
        getMcpClientName: () => mcp.server.getClientVersion()?.name ?? "unknown",
        config: {
          permission: bootstrap.config.permission,
          allowYolo: bootstrap.config.permission === "yolo",
          ...(bootstrap.config.allowedAgents !== undefined ? { allowedAgents: bootstrap.config.allowedAgents } : {}),
          ...(bootstrap.config.allowedModels !== undefined ? { allowedModels: bootstrap.config.allowedModels } : {}),
          resultMaxTokens: bootstrap.config.resultMaxTokens,
          outputChars: bootstrap.config.outputChars,
        },
      })
    }
    return mcp
  }

  const gated = createHttpFetchHandler(factory, { token })
  const listener = await listenHttp(gated.fetch, { port: opts.port, hostname })
  log(`http transport listening on ${listener.url}`)

  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    await gated.close().catch(() => {})
    await listener.close().catch(() => {})
    await bootstrap.cleanup()
  }
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)))
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)))

  await new Promise<void>(() => {})
}

export * as McpTransportHttp from "./transport-http"
