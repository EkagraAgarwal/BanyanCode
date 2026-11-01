import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { onError } from "../client"
import { dim, println, Style } from "../ui"
import { readInstallId, readTelemetrySetting, telemetryEnabled } from "./shared"

const handler = Effect.fn("cli.telemetry.status")(function* () {
  const setting = yield* Effect.promise(readTelemetrySetting)
  const installId = yield* Effect.promise(readInstallId)
  const enabled = telemetryEnabled(process.env, setting)
  println(Style.TEXT_HIGHLIGHT + `Telemetry: ${enabled ? "enabled" : "disabled"}` + Style.TEXT_NORMAL)
  println(`  install_id: ${installId ?? "(none — first run pending)"}`)
  println(`  config: banyancode_telemetry = ${setting ?? "on (default)"}`)
  if (!enabled) println(dim("  re-enable with: banyancode telemetry on"))
})

export default Runtime.handler(Commands.commands.telemetry.commands.status, () =>
  handler().pipe(Effect.catch(onError())),
)
