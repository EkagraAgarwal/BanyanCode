import { Effect, Option } from "effect"
import { main } from "@banyancode/mcp"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { baseArgs } from "./args"

export default Runtime.handler(
  Commands.commands.mcp.commands.install,
  Effect.fn("cli.mcp.install")(function* (input) {
    const cwd = Option.getOrUndefined(input.cwd)
    const code = yield* Effect.promise(() =>
      main([
        "install",
        input.client,
        ...baseArgs({ ...(cwd !== undefined ? { cwd } : {}) }),
        ...(input.yes ? ["--yes"] : []),
      ]),
    )
    if (code !== 0) yield* Effect.fail(new Error(`mcp install exited with code ${code}`))
  }),
)
