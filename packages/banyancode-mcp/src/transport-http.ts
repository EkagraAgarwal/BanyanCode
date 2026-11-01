// Stateless Streamable HTTP transport for `banyancode mcp serve --http`.
//
// Stateless: no Mcp-Session-Id, every POST is dispatched by the shared handler
// against the shared task engine, so cross-call state lives only in explicit
// task handles. Security gates run in front of the handler: bearer auth (401)
// and an Origin check against localhost (403, DNS rebinding protection). A
// non-loopback bind is refused unless both the hostname and the token were
// explicit.

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createMcpHandler, localhostAllowedOrigins, originValidationResponse } from "@modelcontextprotocol/server"
import type { McpServer } from "@modelcontextprotocol/server"
import { log } from "./logging"

export const DEFAULT_HTTP_HOSTNAME = "127.0.0.1" as const
export const MCP_TOKEN_ENV = "BANYANCODE_MCP_TOKEN" as const

export type HttpServeOptions = {
  /**
   * Builds a fresh McpServer per request: the SDK allows one transport per
   * Server instance, so a stateless HTTP entry cannot reuse one. The task
   * engine behind the servers is shared.
   */
  create: () => McpServer
  port?: number
  hostname?: string
  token?: string
  onShutdown?: () => Promise<void> | void
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

export function resolveHttpToken(input: { flag?: string; env?: NodeJS.ProcessEnv }): {
  token: string
  explicit: boolean
} {
  if (input.flag !== undefined && input.flag !== "") return { token: input.flag, explicit: true }
  const fromEnv = input.env?.[MCP_TOKEN_ENV]
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, explicit: true }
  return { token: randomBytes(32).toString("base64url"), explicit: false }
}

export function assertHttpBindAllowed(input: {
  hostname: string
  hostnameExplicit: boolean
  tokenExplicit: boolean
}): void {
  if (isLoopbackHost(input.hostname)) return
  if (!input.hostnameExplicit || !input.tokenExplicit) {
    throw new Error(
      `mcp serve --http: refusing non-loopback bind on ${input.hostname} — ` +
        `pass --hostname explicitly together with an explicit bearer token (--token or ${MCP_TOKEN_ENV}).`,
    )
  }
}

const unauthorized = (message: string): Response =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="${message}"` },
    },
  )

export function checkBearerAuth(authorization: string | null | undefined, token: string): Response | undefined {
  if (typeof authorization !== "string") return unauthorized("missing Authorization header")
  const prefix = "Bearer "
  if (!authorization.startsWith(prefix)) return unauthorized("Authorization scheme must be Bearer")
  const presented = Buffer.from(authorization.slice(prefix.length))
  const expected = Buffer.from(token)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return unauthorized("invalid bearer token")
  }
  return undefined
}

function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export type HttpListener = { url: string; hostname: string; port: number; close: () => Promise<void> }

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
          if (Array.isArray(value)) for (const item of value) headers.append(key, item)
          else headers.set(key, value)
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

export type HttpHandle = {
  url: string
  port: number
  hostname: string
  token: string
  close: () => Promise<void>
}

// Start without owning the process: tests and embedders call this directly,
// `serveHttp` adds signal handling and the "run forever" wrapper.
export async function startHttp(options: HttpServeOptions): Promise<HttpHandle> {
  const hostname = options.hostname ?? DEFAULT_HTTP_HOSTNAME
  const hostnameExplicit = options.hostname !== undefined
  const { token, explicit } = resolveHttpToken({ flag: options.token, env: process.env })
  assertHttpBindAllowed({ hostname, hostnameExplicit, tokenExplicit: explicit })
  if (!explicit) log(`generated bearer token for this process (pass --token to set your own)`)

  const handler = createMcpHandler(() => options.create())
  const listener = await listenHttp(
    async (req) => {
      const authFailure = checkBearerAuth(req.headers.get("authorization"), token)
      if (authFailure) return authFailure
      const originFailure = originValidationResponse(req, localhostAllowedOrigins())
      if (originFailure) return originFailure
      return handler.fetch(req)
    },
    { port: options.port, hostname },
  )
  let closed = false
  return {
    url: listener.url,
    port: listener.port,
    hostname: listener.hostname,
    token,
    close: async () => {
      if (closed) return
      closed = true
      await handler.close().catch(() => undefined)
      await listener.close().catch(() => undefined)
      await Promise.resolve(options.onShutdown?.()).catch(() => undefined)
    },
  }
}

export async function serveHttp(options: HttpServeOptions): Promise<never> {
  const http = await startHttp(options)
  log(`http transport listening on ${http.url}`)
  if (!resolveHttpToken({ flag: options.token, env: process.env }).explicit) {
    log(`generated bearer token for this process: ${http.token}`)
  }
  process.on("SIGINT", () => void http.close().then(() => process.exit(0)))
  process.on("SIGTERM", () => void http.close().then(() => process.exit(0)))
  await new Promise(() => {})
  throw new Error("unreachable")
}

export * as TransportHttp from "./transport-http"
