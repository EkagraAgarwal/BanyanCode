/**
 * First-run bootstrap (v1 `cli/cmd/init-banyan.ts`): create the product
 * directories and write a default global `banyancode.json` only when it does
 * not exist. Called once from the CLI entry before command dispatch, so every
 * command and the TUI see the same first-run state v1 produced.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"

export const DEFAULT_CONFIG = {
  $schema: "https://banyan.dev/schema/banyancode.json",
} as const

export async function ensureBanyanDirs(): Promise<void> {
  const dirs = [
    Global.Path.config,
    Global.Path.data,
    Global.Path.cache,
    Global.Path.state,
    Global.Path.tmp,
    Global.Path.log,
    Global.Path.repos,
  ]
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }

  const file = path.join(Global.Path.config, "banyancode.json")
  if (existsSync(file)) return
  await writeFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2)).catch(() => {})
}
