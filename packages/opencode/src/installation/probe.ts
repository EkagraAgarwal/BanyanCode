import fs from "fs/promises"
import os from "os"
import path from "path"
import { Process } from "@/util/process"
import type { Method } from "."

export type BanyanInstallMethod = Exclude<Method, "unknown">

export interface BanyanInstall {
  method: BanyanInstallMethod
  path: string
  version?: string
}

export interface ProbeOptions {
  home?: string
  platform?: NodeJS.Platform
  run?: typeof Process.run
}

interface Candidate {
  method: BanyanInstallMethod
  path: string
  packageDirectory?: string
  rank: number
  version?: string
}

interface DetectedInstall {
  install: BanyanInstall
  rank: number
  identities: Set<string>
}

function homeDirectory(options: ProbeOptions) {
  return options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}

function executablePaths(base: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return [base]
  return [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.ps1`]
}

async function commandText(run: typeof Process.run, command: string[]) {
  const result = await run(command, { nothrow: true }).catch(() => undefined)
  if (!result || result.code !== 0) return ""
  return result.stdout.toString("utf8").trim()
}

function outputPaths(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
}

async function packageInfo(directory: string) {
  const content = await fs.readFile(path.join(directory, "package.json"), "utf8").catch(() => "")
  if (!content) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined
    const version = "version" in parsed && typeof parsed.version === "string" ? parsed.version : undefined
    return { name, version }
  } catch {
    return undefined
  }
}

async function findPackageDirectory(target: string) {
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat) return undefined
  const start = stat.isDirectory() ? target : path.dirname(target)
  const root = path.parse(start).root
  let current = start
  while (true) {
    const info = await packageInfo(current)
    if (info?.name === "banyancode") return current
    if (current === root) return undefined
    current = path.dirname(current)
  }
}

function classifyPath(input: { source: string; resolved: string; packageDirectory?: string; home: string }) {
  const combined = [input.source, input.resolved, input.packageDirectory ?? ""].join("|").toLowerCase()
  const normalizedHome = input.home.toLowerCase()
  if (combined.includes(path.join(normalizedHome, ".banyancode").toLowerCase())) return "curl" as const
  if (combined.includes(path.join(normalizedHome, ".bun").toLowerCase())) return "bun" as const
  if (combined.includes("chocolatey") || combined.includes(`${path.sep}choco${path.sep}`)) return "choco" as const
  if (combined.includes(`${path.sep}scoop${path.sep}`)) return "scoop" as const
  if (combined.includes(`${path.sep}homebrew${path.sep}`) || combined.includes(`${path.sep}cellar${path.sep}`)) {
    return "brew" as const
  }
  if (combined.includes(`${path.sep}snap${path.sep}`)) return "snap" as const
  if (combined.includes(`${path.sep}pnpm${path.sep}`) || combined.includes(".pnpm")) return "pnpm" as const
  if (combined.includes(`${path.sep}yarn${path.sep}`) || combined.includes(".yarn")) return "yarn" as const
  if (combined.includes(`${path.sep}node_modules${path.sep}banyancode`)) return "npm" as const
  if (input.source.toLowerCase() === path.join(input.home, ".local", "bin", "banyancode").toLowerCase()) {
    return "curl" as const
  }
  if (
    input.source.toLowerCase() ===
    path.join(path.parse(input.source).root, "usr", "local", "bin", "banyancode").toLowerCase()
  ) {
    return "curl" as const
  }
  return undefined
}

function versionFromText(output: string) {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1]
}

export async function findBanyanCodeOnPath(options: ProbeOptions = {}) {
  const run = options.run ?? Process.run
  const platform = options.platform ?? process.platform
  const output = await commandText(run, platform === "win32" ? ["where", "banyancode"] : ["which", "-a", "banyancode"])
  return [...new Set(outputPaths(output).map((item) => path.resolve(item)))]
}

export async function findAllBanyanCodeInstalls(options: ProbeOptions = {}): Promise<BanyanInstall[]> {
  const run = options.run ?? Process.run
  const platform = options.platform ?? process.platform
  const home = homeDirectory(options)
  const candidates: Candidate[] = []
  const addExecutable = (method: BanyanInstallMethod, base: string, packageDirectory?: string, rank = 2) => {
    candidates.push(...executablePaths(base, platform).map((item) => ({ method, path: item, packageDirectory, rank })))
  }

  for (const item of await findBanyanCodeOnPath({ ...options, home, platform, run })) {
    const resolved = await fs.realpath(item).catch(() => path.resolve(item))
    const packageDirectory = await findPackageDirectory(resolved)
    const method = classifyPath({ source: item, resolved, packageDirectory, home })
    if (method) candidates.push({ method, path: item, packageDirectory, rank: 1 })
  }

  addExecutable("curl", path.join(home, ".banyancode", "bin", "banyancode"))
  addExecutable("curl", path.join(home, ".local", "bin", "banyancode"))
  if (platform !== "win32") addExecutable("curl", path.join(path.parse(home).root, "usr", "local", "bin", "banyancode"))

  const bunPackage = path.join(home, ".bun", "install", "global", "node_modules", "banyancode")
  addExecutable("bun", path.join(home, ".bun", "install", "global", "node_modules", ".bin", "banyancode"), bunPackage)
  candidates.push({ method: "bun", path: bunPackage, packageDirectory: bunPackage, rank: 2 })

  const [npmRoot, pnpmRoot, yarnGlobal, brewPrefix, scoopPrefix, chocoList, snapList] = await Promise.all([
    commandText(run, ["npm", "root", "-g"]),
    commandText(run, ["pnpm", "root", "-g"]),
    commandText(run, ["yarn", "global", "dir"]),
    commandText(run, ["brew", "--prefix", "banyancode"]),
    commandText(run, ["scoop", "prefix", "banyancode"]),
    commandText(run, ["choco", "list", "--local-only", "--exact", "banyancode"]),
    commandText(run, ["snap", "list", "banyancode"]),
  ])

  const addPackageRoot = (method: "npm" | "pnpm" | "yarn", root: string) => {
    if (!root) return
    const packageDirectory = path.join(outputPaths(root)[0] ?? root, "banyancode")
    candidates.push({ method, path: packageDirectory, packageDirectory, rank: 3 })
  }
  addPackageRoot("npm", npmRoot)
  addPackageRoot("pnpm", pnpmRoot)
  if (yarnGlobal) addPackageRoot("yarn", path.join(outputPaths(yarnGlobal)[0] ?? yarnGlobal, "node_modules"))

  if (brewPrefix) {
    const prefix = outputPaths(brewPrefix)[0] ?? brewPrefix
    addExecutable("brew", path.join(prefix, "bin", "banyancode"), prefix, 3)
    candidates.push({ method: "brew", path: prefix, packageDirectory: prefix, rank: 3 })
  }
  if (scoopPrefix) {
    const prefix = outputPaths(scoopPrefix)[0] ?? scoopPrefix
    addExecutable("scoop", path.join(prefix, "banyancode"), prefix, 3)
    candidates.push({ method: "scoop", path: prefix, packageDirectory: prefix, rank: 3 })
  }
  if (chocoList.toLowerCase().includes("banyancode")) {
    const chocoHome =
      process.env.ChocolateyInstall ?? path.join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey")
    addExecutable("choco", path.join(chocoHome, "bin", "banyancode"), undefined, 3)
  }
  if (snapList.toLowerCase().includes("banyancode") && platform !== "win32") {
    addExecutable("snap", path.join(path.parse(home).root, "snap", "bin", "banyancode"), undefined, 3)
  }

  const detected = new Map<string, DetectedInstall>()
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate.path).catch(() => undefined)
    if (!stat) continue
    const resolved = await fs.realpath(candidate.path).catch(() => path.resolve(candidate.path))
    const packageDirectory = candidate.packageDirectory ?? (await findPackageDirectory(resolved))
    const packageRealPath = packageDirectory
      ? await fs.realpath(packageDirectory).catch(() => path.resolve(packageDirectory))
      : undefined
    const identities = new Set(
      [resolved.toLowerCase(), packageRealPath?.toLowerCase()].filter((item) => item !== undefined),
    )
    const current = [...identities].map((identity) => detected.get(identity)).find((item) => item !== undefined)
    const info = packageDirectory ? await packageInfo(packageDirectory) : undefined
    const install: BanyanInstall = {
      method: candidate.rank > (current?.rank ?? -1) ? candidate.method : (current?.install.method ?? candidate.method),
      path: current?.install.path ?? candidate.path,
      version: candidate.version ?? info?.version ?? current?.install.version,
    }
    const mergedIdentities = new Set([...(current?.identities ?? []), ...identities])
    const next =
      !current || candidate.rank >= current.rank
        ? { install, rank: Math.max(candidate.rank, current?.rank ?? candidate.rank), identities: mergedIdentities }
        : { ...current, identities: mergedIdentities }
    mergedIdentities.forEach((identity) => detected.set(identity, next))
  }

  const installs = [...new Set(detected.values())].map((item) => item.install)
  return Promise.all(
    installs.map(async (install) => {
      if (install.version) return install
      const stat = await fs.stat(install.path).catch(() => undefined)
      if (!stat?.isFile()) return install
      const output = await commandText(run, [install.path, "--version"])
      const version = versionFromText(output)
      return version ? { ...install, version } : install
    }),
  )
}

export * as Probe from "./probe"
