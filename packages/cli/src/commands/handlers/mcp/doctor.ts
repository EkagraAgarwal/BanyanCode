import { Effect, Option } from "effect"
import { main } from "@banyancode/mcp"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { baseArgs } from "./args"

export default Runtime.handler(
  Commands.commands.mcp.commands.doctor,
  Effect.fn("cli.mcp.doctor")(function* (input) {
    const cwd = Option.getOrUndefined(input.cwd)
    const config = Option.getOrUndefined(input.config)
    const code = yield* Effect.promise(() =>
      main([
        "doctor",
        ...baseArgs({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(config !== undefined ? { config } : {}),
        }),
      ]),
    )
    if (code !== 0) process.exitCode = code
  }),
)
