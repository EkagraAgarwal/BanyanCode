import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

const CANARY_SHA_SUFFIX = /-dev\.[0-9a-f]{7,}$/
// npm drops the leading zero from the CalVer month ("26.08.11" → "26.8.11");
// normalize so both forms compare equal.
const canonical = (version: string) => version.replace(/(^|\.)0+(?=\d)/g, "$1")

// Decides whether `banyancode upgrade` should skip. Canary versions are
// `YY.MM.PATCH-dev.<sha7>`; the sha is arbitrary (not orderable), so a plain
// numeric comparison wrongly treats an old sha as "newer" (e.g. 5013cc3 vs
// 1dd17c0) and skips the published build. When the installed and latest
// versions share the same base and are both canaries, the dist-tag is the
// source of truth — upgrade unless they are exactly equal.
export function shouldSkipUpgrade(installed: string, latest: string): boolean {
  if (canonical(installed) === canonical(latest)) return true
  const installedCanary = CANARY_SHA_SUFFIX.test(installed)
  const latestCanary = CANARY_SHA_SUFFIX.test(latest)
  const sameBase =
    canonical(installed.replace(CANARY_SHA_SUFFIX, "")) === canonical(latest.replace(CANARY_SHA_SUFFIX, ""))
  if (installedCanary && latestCanary && sameBase) return false
  return installed.localeCompare(latest, undefined, { numeric: true }) > 0
}

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade banyancode to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`banyancode is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const latest = await Installation.latest(method)
    const target = args.target ? args.target.replace(/^v/, "") : latest

    if (InstallationVersion === target) {
      prompts.log.warn(
        InstallationVersion === latest
          ? `You are on ${InstallationVersion}; latest on this channel is also ${latest}. Skipping.`
          : `You are on ${InstallationVersion}; latest on this channel is ${latest}. Requested target is already installed. Skipping.`,
      )
      prompts.outro("Done")
      return
    }

    if (!args.target) {
      if (shouldSkipUpgrade(InstallationVersion, latest)) {
        prompts.log.warn(`You are on ${InstallationVersion}; latest on this channel is ${latest}. Skipping.`)
        prompts.outro("Done")
        return
      }
      prompts.log.warn(`Upgrade available: ${InstallationVersion} → ${latest}. Proceeding...`)
    } else {
      prompts.log.info(`From ${InstallationVersion} → ${target}`)
    }
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
