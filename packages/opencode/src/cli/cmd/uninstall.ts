import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Probe } from "../../installation/probe"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

export interface RemovalTargets {
  installs: Probe.BanyanInstall[]
  directories: Array<{ path: string; label: string; keep: boolean }>
}

export interface InstallRemovalResult {
  install: Probe.BanyanInstall
  status: "removed" | "skipped"
  message: string
}

export interface UninstallResult {
  installs: InstallRemovalResult[]
  remaining: string[]
  summary: string[]
}

export interface ExecuteUninstallOptions {
  run?: typeof Process.run
  findRemaining?: () => Promise<string[]>
  log?: (message: string) => void
}

const removeCommands: Record<Probe.BanyanInstallMethod, string[]> = {
  curl: [],
  npm: ["npm", "uninstall", "-g", "banyancode"],
  pnpm: ["pnpm", "uninstall", "-g", "banyancode"],
  bun: ["bun", "remove", "-g", "banyancode"],
  yarn: ["yarn", "global", "remove", "banyancode"],
  brew: ["brew", "uninstall", "banyancode"],
  choco: ["choco", "uninstall", "banyancode", "-y", "-r"],
  scoop: ["scoop", "uninstall", "banyancode"],
  snap: ["snap", "remove", "banyancode"],
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall banyancode and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall BanyanCode")

    const installs = await Probe.findAllBanyanCodeInstalls()
    prompts.log.info(
      installs.length === 0
        ? "No BanyanCode install was detected on PATH or in known global locations"
        : `Detected ${installs.length} BanyanCode install${installs.length === 1 ? "" : "s"}`,
    )

    const targets = collectRemovalTargets(args, installs)
    await showRemovalSummary(targets)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(targets)
    prompts.outro("Done")
  },
}

export function collectRemovalTargets(
  args: Pick<UninstallArgs, "keepConfig" | "keepData">,
  installs: Probe.BanyanInstall[],
) {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]
  return { installs, directories } satisfies RemovalTargets
}

async function showRemovalSummary(targets: RemovalTargets) {
  prompts.log.message("The following will be removed:")

  for (const install of targets.installs) {
    prompts.log.info(`  ✓ Install: ${formatInstall(install)}`)
  }

  for (const dir of targets.directories) {
    const exists = await pathExists(dir.path)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"
    prompts.log.info(
      `  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${formatSize(size)})${status}`,
    )
  }
}

export async function executeUninstall(
  targets: RemovalTargets,
  options: ExecuteUninstallOptions = {},
): Promise<UninstallResult> {
  const run = options.run ?? Process.run
  const findRemaining = options.findRemaining ?? (() => Probe.findBanyanCodeOnPath())
  const log = options.log ?? ((message: string) => prompts.log.message(message))
  const installs: InstallRemovalResult[] = []
  const directoryMessages: string[] = []

  for (const install of targets.installs) {
    try {
      if (install.method === "curl") {
        await fs.rm(install.path, { force: true })
      } else {
        const command = removeCommands[install.method]
        const result = await run(command, { nothrow: true })
        if (result.code !== 0) {
          const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim()
          throw new Error(`${command.join(" ")} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`)
        }
      }

      if (await pathExists(install.path)) throw new Error("install remains after the removal command completed")
      installs.push({ install, status: "removed", message: `✓ Removed ${formatInstall(install)}` })
    } catch (error) {
      installs.push({
        install,
        status: "skipped",
        message: `⚠ Skipped ${shortenPath(install.path)} — ${errorMessage(error)}`,
      })
    }
  }

  for (const dir of targets.directories) {
    if (dir.keep) {
      directoryMessages.push(`○ Kept ${dir.label}: ${shortenPath(dir.path)}`)
      continue
    }
    if (!(await pathExists(dir.path))) continue

    try {
      await fs.rm(dir.path, { recursive: true, force: true })
      directoryMessages.push(`✓ Removed ${dir.label}: ${shortenPath(dir.path)}`)
    } catch (error) {
      directoryMessages.push(`⚠ Failed to remove ${dir.label}: ${errorMessage(error)}`)
    }
  }

  const remaining = await findRemaining().catch((error) => {
    directoryMessages.push(`⚠ Could not check PATH for remaining installs: ${errorMessage(error)}`)
    return []
  })
  const summary = [
    ...installs.map((item) => item.message),
    ...directoryMessages,
    ...remaining.map((item) => `⚠ Remaining: ${shortenPath(item)}`),
  ]

  if (!options.log) UI.empty()
  log("Removal summary:")
  summary.forEach(log)
  if (!options.log) {
    UI.empty()
    prompts.log.success("Thank you for using BanyanCode!")
  }
  return { installs, remaining, summary }
}

function formatInstall(install: Probe.BanyanInstall) {
  const detail = install.version ? `${install.method}, v${install.version}` : install.method
  return `${shortenPath(install.path)} (${detail})`
}

async function pathExists(target: string) {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(target: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  if (target.startsWith(home)) return target.replace(home, "~")
  return target
}
