/**
 * Install-telemetry helpers shared by the `telemetry` subcommands.
 *
 * v1 read the setting from `<config>/banyancode.json` and the install id from
 * `<state>/install.json`. v2's plugin uses the same files and the same
 * `Global.Path` roots, so these commands stay local (no server boot — the
 * point of `telemetry off` is to stop the next server from pinging).
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"

export type TelemetrySetting = "on" | "off"

export const configFile = () => path.join(Global.Path.config, "banyancode.json")

export const installFile = () => path.join(Global.Path.state, "install.json")

export const readTelemetrySetting = async (): Promise<TelemetrySetting | undefined> => {
  const content = await readFile(configFile(), "utf8").catch(() => undefined)
  if (content === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>).banyancode_telemetry
    return value === "on" || value === "off" ? value : undefined
  } catch {
    return undefined
  }
}

export const readInstallId = async (): Promise<string | undefined> => {
  const content = await readFile(installFile(), "utf8").catch(() => undefined)
  if (content === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const id = (parsed as Record<string, unknown>).install_id
    return typeof id === "string" ? id : undefined
  } catch {
    return undefined
  }
}

/** v1 `writeTelemetrySetting`: read-merge-write the global config, preserving unknown keys. */
export const writeTelemetrySetting = async (setting: TelemetrySetting) => {
  const file = configFile()
  const raw = await readFile(file, "utf8").catch(() => undefined)
  let config: Record<string, unknown> = {}
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>
    } catch {}
  }
  config.banyancode_telemetry = setting
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2))
}

/** v1 `telemetryEnabled`, including the `DO_NOT_TRACK` opt-out. */
export const telemetryEnabled = (env: NodeJS.ProcessEnv = process.env, setting?: TelemetrySetting) => {
  if (env.BANYANCODE_TELEMETRY === "off") return false
  if (env.DO_NOT_TRACK === "1") return false
  if (setting === "off") return false
  return true
}

export const configFileExists = () => existsSync(configFile())
