import path from "path"
import fsNode from "fs/promises"
import { existsSync } from "fs"
import { Global } from "@opencode-ai/core/global"

export async function ensureBanyanDirs() {
  const configDir = Global.Path.banyan.config
  const dirs = [
    configDir,
    Global.Path.banyan.data,
    Global.Path.banyan.cache,
    Global.Path.banyan.state,
    Global.Path.banyan.tmp,
    Global.Path.banyan.log,
    Global.Path.banyan.repos,
  ]
  for (const dir of dirs) {
    await fsNode.mkdir(dir, { recursive: true }).catch(() => {})
  }

  const configFile = path.join(configDir, "banyancode.json")
  if (!existsSync(configFile)) {
    const content = JSON.stringify({
      $schema: "https://banyan.dev/schema/banyancode.json",
    }, null, 2)
    await fsNode.writeFile(configFile, content).catch(() => {})
  }
}
