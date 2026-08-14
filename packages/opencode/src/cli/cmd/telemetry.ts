import type { Argv } from "yargs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import { readInstallIdentity, readTelemetrySetting, telemetryEnabled } from "../../installation/telemetry"

const configFile = () => path.join(Global.Path.banyan.config, "banyancode.json")

async function writeTelemetrySetting(setting: "on" | "off") {
  const file = configFile()
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  let config: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>
    } catch {}
  }
  config.banyancode_telemetry = setting
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2))
}

const StatusCommand = effectCmd({
  command: "status",
  describe: "show install telemetry status",
  instance: false,
  handler: Effect.fn("Cli.telemetry.status")(function* () {
    const setting = yield* Effect.promise(() => readTelemetrySetting(Global.Path.banyan.config))
    const identity = yield* Effect.promise(() => readInstallIdentity(Global.Path.banyan.state))
    const enabled = telemetryEnabled(process.env, setting)
    UI.println(UI.Style.TEXT_HIGHLIGHT + `Telemetry: ${enabled ? "enabled" : "disabled"}` + UI.Style.TEXT_NORMAL)
    UI.println(`  install_id: ${identity?.install_id ?? "(none — first run pending)"}`)
    UI.println(`  config: banyancode_telemetry = ${setting ?? "on (default)"}`)
    if (!enabled) {
      UI.println(UI.Style.TEXT_DIM + "  re-enable with: banyancode telemetry on" + UI.Style.TEXT_NORMAL)
    }
  }),
})

const OnCommand = effectCmd({
  command: "on",
  describe: "enable install telemetry (default)",
  instance: false,
  handler: Effect.fn("Cli.telemetry.on")(function* () {
    yield* Effect.promise(() => writeTelemetrySetting("on"))
    UI.println(UI.Style.TEXT_SUCCESS + "Telemetry enabled" + UI.Style.TEXT_NORMAL)
  }),
})

const OffCommand = effectCmd({
  command: "off",
  describe: "disable install telemetry",
  instance: false,
  handler: Effect.fn("Cli.telemetry.off")(function* () {
    yield* Effect.promise(() => writeTelemetrySetting("off"))
    UI.println(UI.Style.TEXT_WARNING + "Telemetry disabled" + UI.Style.TEXT_NORMAL)
  }),
})

export const TelemetryCommand = effectCmd({
  command: "telemetry",
  describe: "install telemetry subcommands (status/on/off)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.command(StatusCommand).command(OnCommand).command(OffCommand).demandCommand(),
  handler: Effect.fn("Cli.telemetry")(function* () {}),
})
