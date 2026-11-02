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
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { cliName } from "../../../brand"
import { ServerConnection } from "../../../services/server-connection"
import { ServiceConfig } from "../../../services/service-config"
import { Server } from "../../commands"
import { ConfigRpc } from "./rpc"

export type Connection = {
  readonly client: ReturnType<typeof OpenCode.make>
  readonly endpoint: ServerConnection.Resolved["endpoint"]
}

/**
 * `BANYANCODE_ENABLE=0` only reaches a service that is started afterwards. A
 * service already running was started with its own environment, so say so
 * instead of pretending the gate applied.
 */
const warnDisabled = Effect.gen(function* () {
  if (process.env.BANYANCODE_ENABLE !== "0") return
  const explicit = Option.getOrUndefined(Option.flatten(yield* Effect.serviceOption(Server)))
  if (explicit !== undefined) {
    process.stderr.write(
      `Warning: BANYANCODE_ENABLE=0 cannot be applied to the server at ${explicit}; it was started with its own environment.${EOL}`,
    )
    return
  }
  const options = yield* ServiceConfig.options()
  const running = yield* Service.discover({ ...options, version: undefined })
  if (running === undefined) return
  process.stderr.write(
    `Warning: BANYANCODE_ENABLE=0 applies to a newly started background service; the running service keeps its own environment. Run \`${cliName} service stop\` to apply it.${EOL}`,
  )
}).pipe(Effect.catchCause(() => Effect.void))

/**
 * RPC calls are location-scoped: the plugin instance for the CLI's working
 * directory must answer, not the server's startup location. Every call passes
 * this so `banyancode codegraph …` in project A never reads project B's graph.
 */
export const here = () => ({ location: { directory: process.cwd() } })

/**
 * Surface `banyancode.json` diagnostics the plugin already collected. The
 * plugin loads the merged config for the current location, so the CLI does not
 * have to duplicate the discovery rules. Best effort: a plugin without the RPC
 * (disabled build) stays quiet.
 */
export const warnConfig = (client: Connection["client"]) =>
  Effect.gen(function* () {
    const loaded = yield* Effect.tryPromise({
      try: () => client.rpc(ConfigRpc)["config.get"]({}, here()),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => undefined))
    if (loaded === undefined) return
    const errors = Array.isArray(loaded.errors) ? loaded.errors : []
    const unknownKeys = Array.isArray(loaded.unknownKeys) ? loaded.unknownKeys : []
    const lines = [
      ...errors.map((entry) => `${entry.file}: ${entry.message}`),
      ...unknownKeys.flatMap((entry) =>
        (Array.isArray(entry.keys) ? entry.keys : []).map(
          (key: string) => `${entry.file}: unknown key "${key}" (ignored)`,
        ),
      ),
    ]
    for (const line of lines) process.stderr.write(`Warning: ${line}${EOL}`)
  })

export const connect = Effect.fn("cli.banyancode.connect")(function* () {
  yield* warnDisabled
  const server = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  yield* warnConfig(client)
  return { client, endpoint: server.endpoint } satisfies Connection
})

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
