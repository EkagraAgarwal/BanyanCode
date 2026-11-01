import { Buffer } from "node:buffer"
import type { ChildProcessWithoutNullStreams } from "node:child_process"

/**
 * Minimal JSON-RPC 2.0 transport over a child process' stdio, matching the
 * subset `vscode-jsonrpc` provided to the v1 LSP client: requests with
 * timeouts, notifications, and server-to-client requests. Hand-rolled because
 * `vscode-jsonrpc` is not a dependency of this package and the framing is
 * trivial; it also keeps the runtime free of extra event-loop machinery.
 */

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface Connection {
  readonly request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>
  readonly notify: (method: string, params?: unknown) => Promise<void>
  readonly onRequest: (method: string, handler: (params: unknown) => unknown | Promise<unknown>) => void
  readonly onNotification: (method: string, handler: (params: unknown) => void) => void
  readonly dispose: () => void
  readonly closed: Promise<void>
}

const MAX_HEADER_BYTES = 8 * 1024

export const connect = (child: ChildProcessWithoutNullStreams): Connection => {
  const stdout = child.stdout
  const stdin = child.stdin
  const pending = new Map<number, Pending>()
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  let nextId = 1
  let buffer: Buffer = Buffer.alloc(0)
  let closed = false
  let markClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    markClosed = resolve
  })

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(error)
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    failAll(new Error("LSP connection closed"))
    markClosed()
  }

  const send = (message: unknown): Promise<void> => {
    if (closed) return Promise.resolve()
    const body = Buffer.from(JSON.stringify(message), "utf8")
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
      body,
    ])
    return new Promise<void>((resolve) => {
      if (stdin.writable === false) return resolve()
      stdin.write(frame, () => resolve())
    })
  }

  const respond = async (id: unknown, method: string, params: unknown) => {
    const handler = requestHandlers.get(method)
    if (!handler) {
      await send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      const result = await handler(params)
      await send({ jsonrpc: "2.0", id, result: result ?? null })
    } catch (error) {
      await send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  const dispatch = (message: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }) => {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        void respond(message.id, message.method, message.params)
        return
      }
      const handler = notificationHandlers.get(message.method)
      if (!handler) return
      try {
        handler(message.params)
      } catch {
        // Notification handlers must never take down the transport.
      }
      return
    }
    const id = typeof message.id === "number" ? message.id : undefined
    if (id === undefined) return
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? "LSP request failed"))
    else entry.resolve(message.result)
  }

  const drain = (chunk: Buffer) => {
    buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (buffer.byteLength > MAX_HEADER_BYTES) buffer = Buffer.alloc(0)
        return
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii")
      if (header.length > MAX_HEADER_BYTES) {
        buffer = Buffer.alloc(0)
        return
      }
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number.parseInt(match[1]!, 10)
      const start = headerEnd + 4
      if (buffer.byteLength < start + length) return
      const body = buffer.subarray(start, start + length).toString("utf8")
      buffer = buffer.subarray(start + length)
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        // Malformed payloads must not kill the connection (socket-handler lesson).
        continue
      }
      if (message && typeof message === "object") dispatch(message as never)
    }
  }

  stdout.on("data", (chunk: Buffer) => drain(Buffer.from(chunk)))
  stdout.on("error", close)
  stdout.on("end", close)
  stdin.on("error", () => close())
  // Keep stderr drained; servers write progress/logs there and a full pipe
  // would stall them.
  child.stderr?.resume()

  const request = <T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) return reject(new Error("LSP connection closed"))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      void send({ jsonrpc: "2.0", id, method, params: params ?? null })
    })

  return {
    request,
    notify: (method, params) => send({ jsonrpc: "2.0", method, params: params ?? null }),
    onRequest: (method, handler) => {
      requestHandlers.set(method, handler)
    },
    onNotification: (method, handler) => {
      notificationHandlers.set(method, handler)
    },
    dispose: () => {
      close()
      stdout.removeAllListeners()
      stdin.removeAllListeners()
    },
    closed: closedPromise,
  }
}
