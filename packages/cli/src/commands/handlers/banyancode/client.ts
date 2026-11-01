/**
 * Shared connection helper for the BanyanCode CLI subcommands.
 *
 * Every command reaches the plugin over the host's plugin RPC surface, the
 * same way `stats` / `session` / `debug` do: `ServerConnection.resolve()`
 * attaches to (or starts) the local server, then `client.rpc(definition)`
 * dispatches `POST /api/rpc/:rpcID/:method`.
 */
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect } from "effect"
import { EOL } from "node:os"
import { ServerConnection } from "../../../services/server-connection"

export type Connection = {
  readonly client: ReturnType<typeof OpenCode.make>
  readonly endpoint: ServerConnection.Resolved["endpoint"]
}

export const connect = Effect.fn("cli.banyancode.connect")(function* () {
  const server = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  return { client, endpoint: server.endpoint } satisfies Connection
})

/**
 * RPC calls are location-scoped: the plugin instance for the CLI's working
 * directory must answer, not the server's startup location. Every call passes
 * this so `banyancode codegraph …` in project A never reads project B's graph.
 */
export const here = () => ({ location: { directory: process.cwd() } })

/** v1's `effectCmd` surfaced the raw message; unwrap RPC failures the same way. */
export function describe(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

/**
 * True when the server has no such RPC namespace/method, i.e. the plugin is
 * not loaded (`BANYANCODE_ENABLE=0`, or a host built without the plugin).
 */
export function unavailable(error: unknown) {
  if (typeof error !== "object" || error === null || !("type" in error)) return false
  return error.type === "rpc.unavailable" || error.type === "rpc.method_not_found"
}

export const rpcMessage = (rpcID: string, method: string) =>
  `${rpcID}.${method} is not registered. Is the BanyanCode plugin loaded (BANYANCODE_ENABLE=0 disables it)?`

/** v1 command error path: message on stderr, exit code 1, no stack trace. */
export const onError =
  (rpc?: { readonly id: string; readonly method: string }) =>
  (error: unknown) =>
    Effect.sync(() => {
      process.stderr.write((rpc && unavailable(error) ? rpcMessage(rpc.id, rpc.method) : describe(error)) + EOL)
      process.exitCode = 1
    })
