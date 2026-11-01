import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { onError } from "../client"
import { println, Style } from "../ui"
import { writeTelemetrySetting } from "./shared"

const handler = Effect.fn("cli.telemetry.on")(function* () {
  yield* Effect.promise(() => writeTelemetrySetting("on"))
  println(Style.TEXT_SUCCESS + "Telemetry enabled" + Style.TEXT_NORMAL)
})

export default Runtime.handler(Commands.commands.telemetry.commands.on, () =>
  handler().pipe(Effect.catch(onError())),
)
