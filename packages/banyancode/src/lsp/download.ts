import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, join } from "node:path"
import { readFile, rm } from "node:fs/promises"
import { ls, mkdirp, writeStream } from "./fs.js"
import { run } from "./process.js"

/**
 * Binary detection and download helpers used by the built-in server
 * definitions. v1 relied on `which`, `Module.resolve`, `Npm.which`,
 * `Archive.extractZip`, `Process.run` and `Filesystem.writeStream`; the
 * counterparts live here so the plugin keeps v1's behavior without pulling
 * host packages into the plugin.
 */

export const which = (cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const pathValue = env.PATH ?? env.Path ?? ""
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""]
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, extension && !cmd.toLowerCase().endsWith(extension.toLowerCase()) ? cmd + extension : cmd)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export const moduleResolve = (id: string, dir: string): string | undefined => {
  try {
    return createRequire(join(dir, "package.json")).resolve(id)
  } catch {
    return undefined
  }
}

const sanitize = (value: string) => value.replace(/[<>:"|?*\x00-\x1f]/g, (char) => (process.platform === "win32" ? "_" : char))

const installs = new Map<string, Promise<string | undefined>>()

const matchBin = async (binDir: string, name: string): Promise<string | undefined> => {
  const files = await ls(binDir)
  if (files.includes(name)) return join(binDir, name)
  if (process.platform === "win32") {
    const match = files.find((file) => file === `${name}.cmd` || file === `${name}.exe` || file === `${name}.bat`)
    if (match) return join(binDir, match)
  }
  return undefined
}

const pickBin = async (dir: string, pkg: string, bin?: string): Promise<string | undefined> => {
  const binDir = join(dir, "node_modules", ".bin")
  const files = await ls(binDir)
  if (bin) {
    // A hinted bin (pyright exposes two) must match; never fall back to an
    // arbitrary sibling binary.
    return matchBin(binDir, bin)
  }
  if (files.length === 0) return undefined
  if (files.length === 1) return join(binDir, files[0]!)
  const manifest = await readFile(join(dir, "node_modules", pkg, "package.json"), "utf8")
    .then((text) => JSON.parse(text) as { bin?: string | Record<string, string> })
    .catch(() => undefined)
  if (manifest?.bin) {
    const name =
      typeof manifest.bin === "string" ? (pkg.startsWith("@") ? pkg.split("/")[1]! : pkg) : Object.keys(manifest.bin)[0]
    if (name) {
      const matched = await matchBin(binDir, name)
      if (matched) return matched
    }
  }
  return join(binDir, files[0]!)
}

export const installPackage = async (
  pkg: string,
  bin: string | undefined,
  cacheRoot: string,
): Promise<string | undefined> => {
  const dir = join(cacheRoot, "lsp-packages", sanitize(pkg))
  const found = await pickBin(dir, pkg, bin)
  if (found && existsSync(found)) return found
  const key = `${dir}:${bin ?? ""}`
  const pending = installs.get(key)
  if (pending) return pending
  const task = (async () => {
    await mkdirp(dir)
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    const result = await run([npm, "install", "--prefix", dir, "--no-audit", "--no-fund", "--ignore-scripts", pkg]).catch(
      () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    )
    if (result.code !== 0) return undefined
    const installed = await pickBin(dir, pkg, bin)
    return installed && existsSync(installed) ? installed : undefined
  })().finally(() => installs.delete(key))
  installs.set(key, task)
  return task
}

/** v1 `Archive.extractZip` (PowerShell on Windows, `unzip` elsewhere). */
export const extractZip = async (zipPath: string, destDir: string): Promise<void> => {
  const result =
    process.platform === "win32"
      ? await run([
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
        ])
      : await run(["unzip", "-o", "-q", zipPath, "-d", destDir])
  if (result.code !== 0) throw new Error(`Failed to extract ${zipPath}`)
}

export const extractTar = async (archive: string, destDir: string, args: string[] = []): Promise<boolean> => {
  const result = await run(["tar", "-xf", archive, ...args], { cwd: destDir }).catch(() => ({ code: 1 }))
  return result.code === 0
}

export const download = async (url: string, dest: string): Promise<boolean> => {
  const response = await fetch(url).catch(() => undefined)
  if (!response?.ok || !response.body) return false
  await writeStream(dest, response.body as ReadableStream<Uint8Array>)
  return true
}

export const downloadJson = async <T>(url: string): Promise<T | undefined> => {
  const response = await fetch(url).catch(() => undefined)
  if (!response?.ok) return undefined
  return (await response.json().catch(() => undefined)) as T | undefined
}

export const removeFile = (p: string): Promise<void> => rm(p, { force: true })
