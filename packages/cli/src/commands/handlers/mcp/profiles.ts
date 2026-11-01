import { Effect, Option } from "effect"
import { main } from "@banyancode/mcp"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { baseArgs } from "./args"

export default Runtime.handler(
  Commands.commands.mcp.commands.profiles,
  Effect.fn("cli.mcp.profiles")(function* (input) {
    const cwd = Option.getOrUndefined(input.cwd)
    const config = Option.getOrUndefined(input.config)
    const permission = Option.getOrUndefined(input.permission)
    const code = yield* Effect.promise(() =>
      main([
        "profiles",
        ...baseArgs({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(permission !== undefined ? { permission } : {}),
        }),
      ]),
    )
    if (code !== 0) yield* Effect.fail(new Error(`mcp profiles failed (exit ${code})`))
  }),
)
