import { Effect, Option } from "effect"
import { main } from "@banyancode/mcp"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { baseArgs } from "./args"

// `banyancode mcp serve` — v1's exact invocation. stdout belongs to the MCP
// transport in stdio mode; `main` only ever writes frames there and sends every
// diagnostic to stderr.
export default Runtime.handler(
  Commands.commands.mcp.commands.serve,
  Effect.fn("cli.mcp.serve")(function* (input) {
    const argv = [
      "serve",
      ...baseArgs({
        ...(Option.getOrUndefined(input.cwd) !== undefined ? { cwd: Option.getOrUndefined(input.cwd)! } : {}),
        ...(Option.getOrUndefined(input.config) !== undefined ? { config: Option.getOrUndefined(input.config)! } : {}),
        ...(Option.getOrUndefined(input.permission) !== undefined
          ? { permission: Option.getOrUndefined(input.permission)! }
          : {}),
      }),
    ]
    const attach = Option.getOrUndefined(input.attach)
    if (attach !== undefined && attach !== "") argv.push("--attach", attach)
    else argv.push("--service-file", (yield* ServiceConfig.options()).file)
    const password = Option.getOrUndefined(input.password)
    if (password !== undefined && password !== "") argv.push("--password", password)
    const maxTasks = Option.getOrUndefined(input.maxTasks)
    if (maxTasks !== undefined) argv.push("--max-tasks", String(maxTasks))
    const tools = Option.getOrUndefined(input.tools)
    if (tools !== undefined && tools !== "") argv.push("--tools", tools)
    const port = Option.getOrUndefined(input.port)
    if (port !== undefined) argv.push("--port", String(port))
    const hostname = Option.getOrUndefined(input.hostname)
    if (hostname !== undefined && hostname !== "") argv.push("--hostname", hostname)
    const token = Option.getOrUndefined(input.token)
    if (token !== undefined && token !== "") argv.push("--token", token)
    if (input.allowYolo) argv.push("--allow-yolo")
    if (input.http) argv.push("--http")
    if (input.noStart) argv.push("--no-start")
    if (input.noRehydrate) argv.push("--no-rehydrate")

    const code = yield* Effect.promise(() => main(argv))
    if (code !== 0) return yield* Effect.fail(new Error(`banyancode mcp serve exited with code ${code}`))
  }),
)
