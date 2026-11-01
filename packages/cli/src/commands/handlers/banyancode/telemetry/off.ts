import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { onError } from "../client"
import { println, Style } from "../ui"
import { writeTelemetrySetting } from "./shared"

const handler = Effect.fn("cli.telemetry.off")(function* () {
  yield* Effect.promise(() => writeTelemetrySetting("off"))
  println(Style.TEXT_WARNING + "Telemetry disabled" + Style.TEXT_NORMAL)
})

export default Runtime.handler(Commands.commands.telemetry.commands.off, () =>
  handler().pipe(Effect.catch(onError())),
)
