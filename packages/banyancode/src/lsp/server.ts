import type { ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { buffer } from "node:stream/consumers"
import { Path } from "@opencode/util/global"
import {
  chmodSafe,
  exists,
  findUp,
  mkdirp,
  nearestRoot,
  readText,
  remove,
  statOf,
} from "./fs.js"
import { run, spawn, text, type Child } from "./process.js"
import {
  download,
  downloadJson,
  extractTar,
  extractZip,
  installPackage,
  moduleResolve,
  removeFile,
  which,
} from "./download.js"
import type { Handle, Info, RootFunction } from "./types.js"

/**
 * Built-in language server definitions and detection.
 *
 * Port of v1 `packages/opencode/src/lsp/server.ts` (38 servers, same roots,
 * same spawn arguments, same auto-download behavior). Differences are limited
 * to local helpers: `@opencode/util/global` for the bin directory, a local
 * `which`/`Module.resolve`/npm install shim, and `node:child_process` instead
 * of `cross-spawn`.
 */

const pathExists = (p: string) => exists(p)
const runSafe = (cmd: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
  run(cmd, opts ?? {}).catch(() => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
const output = (cmd: string[]) => text(cmd).catch(() => ({ code: 1, text: "", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))

const bin = () => Path.bin
const npmCache = () => path.join(Path.cache, "lsp")

/** npm-installed language server binary (v1 `Npm.which`). */
const npmWhich = (pkg: string, name?: string) => installPackage(pkg, name, npmCache())

const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
  return async (file, ctx) => {
    if (excludePatterns) {
      const excluded = await nearestRoot(excludePatterns, path.dirname(file), ctx.directory)
      if (excluded) return undefined
    }
    const found = await nearestRoot(includePatterns, path.dirname(file), ctx.directory)
    if (!found) return ctx.directory
    return path.dirname(found)
  }
}

const StrictNearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
  return async (file, ctx) => {
    if (excludePatterns) {
      const excluded = await nearestRoot(excludePatterns, path.dirname(file), ctx.directory)
      if (excluded) return undefined
    }
    const found = await nearestRoot(includePatterns, path.dirname(file), ctx.directory)
    if (!found) return undefined
    return path.dirname(found)
  }
}

export const Deno: Info = {
  id: "deno",
  root: async (file, ctx) => {
    const found = await nearestRoot(["deno.json", "deno.jsonc"], path.dirname(file), ctx.directory)
    if (!found) return undefined
    return path.dirname(found)
  },
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  async spawn(root) {
    const deno = which("deno")
    if (!deno) return
    return { process: spawn([deno, "lsp"], { cwd: root }) }
  },
}

export const DEFAULT_TSSERVER_MAX_MEMORY_MB = 2048

export function resolveTypescriptMaxMemoryMb(raw?: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TSSERVER_MAX_MEMORY_MB
  return Math.floor(Math.min(Math.max(raw, 256), 16384))
}

export const Typescript: Info = {
  id: "typescript",
  root: NearestRoot(
    ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
    ["deno.json", "deno.jsonc"],
  ),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  async spawn(root, ctx) {
    const tsserver = moduleResolve("typescript/lib/tsserver.js", ctx.directory)
    if (!tsserver) return
    const binary = await npmWhich("typescript-language-server")
    if (!binary) return
    return {
      process: spawn([binary, "--stdio"], { cwd: root, env: process.env }),
      // Memory is bounded through typescript-language-server's supported
      // initializationOptions; V8 flags on the spawn argv are not honored here.
      initialization: {
        tsserver: {
          path: tsserver,
          maxTsServerMemory: DEFAULT_TSSERVER_MAX_MEMORY_MB,
        },
      },
    }
  },
}

export const Vue: Info = {
  id: "vue",
  extensions: [".vue"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn(root, _ctx, flags) {
    let binary = which("vue-language-server")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("@vue/language-server")
      if (!binary) return
    }
    return {
      process: spawn([binary, "--stdio"], { cwd: root, env: process.env }),
      initialization: {},
    }
  },
}

export const ESLint: Info = {
  id: "eslint",
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
  autoDownload: true,
  async spawn(root, ctx, flags) {
    const eslint = moduleResolve("eslint", ctx.directory)
    if (!eslint) return
    const serverPath = path.join(bin(), "vscode-eslint", "server", "out", "eslintServer.js")
    if (!(await exists(serverPath))) {
      if (flags.disableLspDownload) return
      const zipPath = path.join(bin(), "vscode-eslint.zip")
      if (!(await download("https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip", zipPath))) return
      const ok = await extractZip(zipPath, bin())
        .then(() => true)
        .catch(() => false)
      if (!ok) return
      await removeFile(zipPath)

      const extractedPath = path.join(bin(), "vscode-eslint-main")
      const finalPath = path.join(bin(), "vscode-eslint")
      if (await pathExists(finalPath)) await remove(finalPath, true)
      await fs.rename(extractedPath, finalPath)
      const npm = process.platform === "win32" ? "npm.cmd" : "npm"
      await runSafe([npm, "install"], { cwd: finalPath })
      await runSafe([npm, "run", "compile"], { cwd: finalPath })
    }
    return { process: spawn(["node", serverPath, "--stdio"], { cwd: root, env: process.env }) }
  },
}

export const Oxlint: Info = {
  id: "oxlint",
  root: NearestRoot([
    ".oxlintrc.json",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package.json",
  ]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
  async spawn(root, ctx) {
    const ext = process.platform === "win32" ? ".cmd" : ""
    const serverTarget = path.join("node_modules", ".bin", "oxc_language_server" + ext)
    const lintTarget = path.join("node_modules", ".bin", "oxlint" + ext)

    const resolveBin = async (target: string) => {
      const local = path.join(root, target)
      if (await exists(local)) return local
      const first = await nearestRoot([target], root, ctx.worktree)
      if (first) return first
      return undefined
    }

    let lintBin = await resolveBin(lintTarget)
    if (!lintBin) lintBin = which("oxlint")
    if (lintBin) {
      const proc = spawn([lintBin, "--help"], { cwd: root })
      await proc.exited
      const help = await buffer(proc.stdout as never).catch(() => Buffer.alloc(0))
      if (help.toString().includes("--lsp")) {
        return { process: spawn([lintBin, "--lsp"], { cwd: root }) }
      }
    }

    let serverBin = await resolveBin(serverTarget)
    if (!serverBin) serverBin = which("oxc_language_server")
    if (serverBin) return { process: spawn([serverBin], { cwd: root }) }
    return undefined
  },
}

export const Biome: Info = {
  id: "biome",
  root: NearestRoot([
    "biome.json",
    "biome.jsonc",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]),
  extensions: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".vue",
    ".astro",
    ".svelte",
    ".css",
    ".graphql",
    ".gql",
    ".html",
  ],
  async spawn(root) {
    const localBin = path.join(root, "node_modules", ".bin", "biome")
    let binary: string | undefined
    if (await exists(localBin)) binary = localBin
    if (!binary) binary = which("biome")
    if (!binary) {
      const resolved = moduleResolve("biome", root)
      if (!resolved) return
      binary = await npmWhich("biome")
      if (!binary) return
    }
    return { process: spawn([binary, "lsp-proxy", "--stdio"], { cwd: root, env: process.env }) }
  },
}

export const Gopls: Info = {
  id: "gopls",
  root: async (file, ctx) => {
    const work = await NearestRoot(["go.work"])(file, ctx)
    if (work) return work
    return NearestRoot(["go.mod", "go.sum"])(file, ctx)
  },
  extensions: [".go"],
  async spawn(root, _ctx, flags) {
    let binary = which("gopls")
    if (!binary) {
      if (!which("go")) return
      if (flags.disableLspDownload) return
      const proc = spawn(["go", "install", "golang.org/x/tools/gopls@latest"], {
        env: { ...process.env, GOBIN: bin() },
      })
      const exit = await proc.exited
      if (exit !== 0) return
      binary = path.join(bin(), "gopls" + (process.platform === "win32" ? ".exe" : ""))
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const Rubocop: Info = {
  id: "ruby-lsp",
  root: NearestRoot(["Gemfile"]),
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  async spawn(root, _ctx, flags) {
    let binary = which("rubocop")
    if (!binary) {
      const ruby = which("ruby")
      const gem = which("gem")
      if (!ruby || !gem) return
      if (flags.disableLspDownload) return
      const proc = spawn(["gem", "install", "rubocop", "--bindir", bin()])
      const exit = await proc.exited
      if (exit !== 0) return
      binary = path.join(bin(), "rubocop" + (process.platform === "win32" ? ".exe" : ""))
    }
    return { process: spawn([binary, "--lsp"], { cwd: root }) }
  },
}

export const Ty: Info = {
  id: "ty",
  extensions: [".py", ".pyi"],
  root: NearestRoot([
    "pyproject.toml",
    "ty.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "pyrightconfig.json",
  ]),
  async spawn(root, _ctx, flags) {
    if (!flags.experimentalLspTy) return undefined

    let binary = which("ty")
    const initialization: Record<string, string> = {}
    const potentialVenvPaths = [process.env["VIRTUAL_ENV"], path.join(root, ".venv"), path.join(root, "venv")].filter(
      (p): p is string => p !== undefined,
    )
    for (const venvPath of potentialVenvPaths) {
      const isWindows = process.platform === "win32"
      const python = isWindows ? path.join(venvPath, "Scripts", "python.exe") : path.join(venvPath, "bin", "python")
      if (await exists(python)) {
        initialization["pythonPath"] = python
        break
      }
    }
    if (!binary) {
      for (const venvPath of potentialVenvPaths) {
        const isWindows = process.platform === "win32"
        const candidate = isWindows ? path.join(venvPath, "Scripts", "ty.exe") : path.join(venvPath, "bin", "ty")
        if (await exists(candidate)) {
          binary = candidate
          break
        }
      }
    }
    if (!binary) return
    return { process: spawn([binary, "server"], { cwd: root }), initialization }
  },
}

export const Pyright: Info = {
  id: "pyright",
  extensions: [".py", ".pyi"],
  root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
  async spawn(root, _ctx, flags) {
    let binary = which("pyright-langserver")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("pyright", "pyright-langserver")
      if (!binary) return
    }
    const initialization: Record<string, string> = {}
    const potentialVenvPaths = [process.env["VIRTUAL_ENV"], path.join(root, ".venv"), path.join(root, "venv")].filter(
      (p): p is string => p !== undefined,
    )
    for (const venvPath of potentialVenvPaths) {
      const isWindows = process.platform === "win32"
      const python = isWindows ? path.join(venvPath, "Scripts", "python.exe") : path.join(venvPath, "bin", "python")
      if (await exists(python)) {
        initialization["pythonPath"] = python
        break
      }
    }
    return { process: spawn([binary, "--stdio"], { cwd: root, env: process.env }), initialization }
  },
}

export const ElixirLS: Info = {
  id: "elixir-ls",
  extensions: [".ex", ".exs"],
  root: NearestRoot(["mix.exs", "mix.lock"]),
  autoDownload: true,
  async spawn(root, _ctx, flags) {
    let binary = which("elixir-ls")
    if (!binary) {
      binary = path.join(
        bin(),
        "elixir-ls-master",
        "release",
        process.platform === "win32" ? "language_server.bat" : "language_server.sh",
      )
      if (!(await exists(binary))) {
        const elixir = which("elixir")
        if (!elixir) return
        if (flags.disableLspDownload) return
        const zipPath = path.join(bin(), "elixir-ls.zip")
        if (!(await download("https://github.com/elixir-lsp/elixir-ls/archive/refs/heads/master.zip", zipPath))) return
        const ok = await extractZip(zipPath, bin())
          .then(() => true)
          .catch(() => false)
        if (!ok) return
        await remove(zipPath, true)
        const cwd = path.join(bin(), "elixir-ls-master")
        const env = { MIX_ENV: "prod", ...process.env }
        await runSafe(["mix", "deps.get"], { cwd, env })
        await runSafe(["mix", "compile"], { cwd, env })
        await runSafe(["mix", "elixir_ls.release2", "-o", "release"], { cwd, env })
      }
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const Zls: Info = {
  id: "zls",
  extensions: [".zig", ".zon"],
  root: NearestRoot(["build.zig"]),
  autoDownload: true,
  async spawn(root, _ctx, flags) {
    let binary = which("zls")
    if (!binary) {
      if (!which("zig")) return
      if (flags.disableLspDownload) return
      const release = await downloadJson<{ assets?: { name?: string; browser_download_url?: string }[] }>(
        "https://api.github.com/repos/zigtools/zls/releases/latest",
      )
      if (!release) return

      const platform = process.platform
      const arch = process.arch
      let zlsArch: string = arch
      if (arch === "arm64") zlsArch = "aarch64"
      else if (arch === "x64") zlsArch = "x86_64"
      else if (arch === "ia32") zlsArch = "x86"

      let zlsPlatform: string = platform
      if (platform === "darwin") zlsPlatform = "macos"
      else if (platform === "win32") zlsPlatform = "windows"
      const ext = platform === "win32" ? "zip" : "tar.xz"
      const assetName = `zls-${zlsArch}-${zlsPlatform}.${ext}`
      const supported = [
        "zls-x86_64-linux.tar.xz",
        "zls-x86_64-macos.tar.xz",
        "zls-x86_64-windows.zip",
        "zls-aarch64-linux.tar.xz",
        "zls-aarch64-macos.tar.xz",
        "zls-aarch64-windows.zip",
        "zls-x86-linux.tar.xz",
        "zls-x86-windows.zip",
      ]
      if (!supported.includes(assetName)) return
      const asset = release.assets?.find((item) => item.name === assetName)
      if (!asset?.browser_download_url) return
      const tempPath = path.join(bin(), assetName)
      if (!(await download(asset.browser_download_url, tempPath))) return
      if (ext === "zip") {
        const ok = await extractZip(tempPath, bin())
          .then(() => true)
          .catch(() => false)
        if (!ok) return
      } else {
        await runSafe(["tar", "-xf", tempPath], { cwd: bin() })
      }
      await removeFile(tempPath)
      binary = path.join(bin(), "zls" + (platform === "win32" ? ".exe" : ""))
      if (!(await exists(binary))) return
      if (platform !== "win32") await chmodSafe(binary, 0o755)
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const CSharp: Info = {
  id: "csharp",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".cs", ".csx"],
  autoDownload: true,
  async spawn(root, _ctx, flags) {
    const binary = await getRoslynLanguageServer(flags.disableLspDownload)
    if (!binary) return
    return { process: spawn([binary, "--stdio", "--autoLoadProjects"], { cwd: root }) }
  },
}

export const Razor: Info = {
  id: "razor",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".razor", ".cshtml"],
  async spawn(root, _ctx, flags) {
    const binary = await getRoslynLanguageServer(flags.disableLspDownload)
    if (!binary) return
    const razor = await findVscodeRazorExtension()
    if (!razor) return
    return {
      process: spawn(
        [
          binary,
          "--stdio",
          "--autoLoadProjects",
          `--razorSourceGenerator=${razor.compiler}`,
          `--razorDesignTimePath=${razor.targets}`,
          "--extension",
          razor.extension,
        ],
        { cwd: root },
      ),
    }
  },
}

let roslynLanguageServerInstall: Promise<string | undefined> | undefined

const getRoslynLanguageServer = async (disableLspDownload: boolean) => {
  const existing = which("roslyn-language-server")
  if (existing) return existing
  const global = await roslynLanguageServerGlobalPath()
  if (global) return global
  roslynLanguageServerInstall ||= installRoslynLanguageServer(disableLspDownload).finally(() => {
    roslynLanguageServerInstall = undefined
  })
  return roslynLanguageServerInstall
}

const installRoslynLanguageServer = async (disableLspDownload: boolean) => {
  if (!which("dotnet")) return
  if (disableLspDownload) return
  const proc = spawn(["dotnet", "tool", "install", "--global", "roslyn-language-server", "--prerelease"])
  const exit = await proc.exited
  if (exit !== 0) return
  const resolved = which("roslyn-language-server")
  if (resolved) return resolved
  return roslynLanguageServerGlobalPath()
}

const roslynLanguageServerGlobalPath = async () => {
  const candidate = path.join(
    process.env.DOTNET_CLI_HOME ?? os.homedir(),
    ".dotnet",
    "tools",
    "roslyn-language-server" + (process.platform === "win32" ? ".cmd" : ""),
  )
  return (await pathExists(candidate)) ? candidate : undefined
}

const findVscodeRazorExtension = async () => {
  const roots = [
    process.env.VSCODE_EXTENSIONS,
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"),
    path.join(os.homedir(), ".vscode-server-insiders", "extensions"),
  ].filter((item): item is string => item !== undefined)

  for (const root of [...new Set(roots)]) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("ms-dotnettools.csharp-"))
        .map(async (entry) => ({
          path: path.join(root, entry.name, ".razorExtension"),
          modified: (await statOf(path.join(root, entry.name)))?.mtimeMs ?? 0,
        })),
    )
    for (const candidate of candidates.sort((a, b) => b.modified - a.modified).map((item) => item.path)) {
      const result = {
        compiler: path.join(candidate, "Microsoft.CodeAnalysis.Razor.Compiler.dll"),
        targets: path.join(candidate, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets"),
        extension: path.join(candidate, "Microsoft.VisualStudioCode.RazorExtension.dll"),
      }
      if (
        (await pathExists(result.compiler)) &&
        (await pathExists(result.targets)) &&
        (await pathExists(result.extension))
      ) {
        return result
      }
    }
  }
  return undefined
}

export const FSharp: Info = {
  id: "fsharp",
  root: NearestRoot([".slnx", ".sln", ".fsproj", "global.json"]),
  extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
  autoDownload: true,
  async spawn(root, _ctx, flags) {
    let binary = which("fsautocomplete")
    if (!binary) {
      if (!which("dotnet")) return
      if (flags.disableLspDownload) return
      const proc = spawn(["dotnet", "tool", "install", "fsautocomplete", "--tool-path", bin()])
      const exit = await proc.exited
      if (exit !== 0) return
      binary = path.join(bin(), "fsautocomplete" + (process.platform === "win32" ? ".exe" : ""))
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const SourceKit: Info = {
  id: "sourcekit-lsp",
  extensions: [".swift", ".objc", "objcpp"],
  root: NearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
  async spawn(root) {
    const sourcekit = which("sourcekit-lsp")
    if (sourcekit) return { process: spawn([sourcekit], { cwd: root }) }
    if (!which("xcrun")) return
    const located = await output(["xcrun", "--find", "sourcekit-lsp"])
    if (located.code !== 0) return
    return { process: spawn([located.text.trim()], { cwd: root }) }
  },
}

export const RustAnalyzer: Info = {
  id: "rust",
  root: async (file, ctx) => {
    const crateRoot = await NearestRoot(["Cargo.toml", "Cargo.lock"])(file, ctx)
    if (crateRoot === undefined) return undefined
    let currentDir = crateRoot
    while (currentDir !== path.dirname(currentDir)) {
      const cargoTomlPath = path.join(currentDir, "Cargo.toml")
      try {
        const cargoTomlContent = await readText(cargoTomlPath)
        if (cargoTomlContent.includes("[workspace]")) return currentDir
      } catch {
        // File doesn't exist or can't be read, continue searching up.
      }
      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
      if (!currentDir.startsWith(ctx.worktree)) break
    }
    return crateRoot
  },
  extensions: [".rs"],
  async spawn(root) {
    const binary = which("rust-analyzer")
    if (!binary) return
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const Clangd: Info = {
  id: "clangd",
  root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd"]),
  autoDownload: true,
  extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
  async spawn(root, _ctx, flags) {
    const args = ["--background-index", "--clang-tidy"]
    const fromPath = which("clangd")
    if (fromPath) return { process: spawn([fromPath, ...args], { cwd: root }) }

    const ext = process.platform === "win32" ? ".exe" : ""
    const direct = path.join(bin(), "clangd" + ext)
    if (await exists(direct)) return { process: spawn([direct, ...args], { cwd: root }) }

    const entries = await fs.readdir(bin(), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith("clangd_")) continue
      const candidate = path.join(bin(), entry.name, "bin", "clangd" + ext)
      if (await exists(candidate)) return { process: spawn([candidate, ...args], { cwd: root }) }
    }

    if (flags.disableLspDownload) return

    const release = await downloadJson<{
      tag_name?: string
      assets?: { name?: string; browser_download_url?: string }[]
    }>("https://api.github.com/repos/clangd/clangd/releases/latest")
    if (!release) return
    const tag = release.tag_name
    if (!tag) return
    const tokens: Record<string, string> = { darwin: "mac", linux: "linux", win32: "windows" }
    const token = tokens[process.platform]
    if (!token) return
    const assets = release.assets ?? []
    const valid = (item: { name?: string; browser_download_url?: string }) => {
      if (!item.name || !item.browser_download_url) return false
      if (!item.name.includes(token)) return false
      return item.name.includes(tag)
    }
    const asset =
      assets.find((item) => valid(item) && item.name?.endsWith(".zip")) ??
      assets.find((item) => valid(item) && item.name?.endsWith(".tar.xz")) ??
      assets.find((item) => valid(item))
    if (!asset?.name || !asset.browser_download_url) return

    const archive = path.join(bin(), asset.name)
    if (!(await download(asset.browser_download_url, archive))) return
    const zip = asset.name.endsWith(".zip")
    const tar = asset.name.endsWith(".tar.xz")
    if (!zip && !tar) return
    if (zip) {
      const ok = await extractZip(archive, bin())
        .then(() => true)
        .catch(() => false)
      if (!ok) return
    }
    if (tar) await runSafe(["tar", "-xf", archive], { cwd: bin() })
    await removeFile(archive)

    const binary = path.join(bin(), "clangd_" + tag, "bin", "clangd" + ext)
    if (!(await exists(binary))) return
    if (process.platform !== "win32") await chmodSafe(binary, 0o755)
    await fs.unlink(path.join(bin(), "clangd")).catch(() => {})
    await fs.symlink(binary, path.join(bin(), "clangd")).catch(() => {})
    return { process: spawn([binary, ...args], { cwd: root }) }
  },
}

export const Svelte: Info = {
  id: "svelte",
  extensions: [".svelte"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn(root, _ctx, flags) {
    let binary = which("svelteserver")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("svelte-language-server")
      if (!binary) return
    }
    return { process: spawn([binary, "--stdio"], { cwd: root, env: process.env }), initialization: {} }
  },
}

export const Astro: Info = {
  id: "astro",
  extensions: [".astro"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn(root, ctx, flags) {
    const tsserver = moduleResolve("typescript/lib/tsserver.js", ctx.directory)
    if (!tsserver) return
    const tsdk = path.dirname(tsserver)
    let binary = which("astro-ls")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("@astrojs/language-server")
      if (!binary) return
    }
    return {
      process: spawn([binary, "--stdio"], { cwd: root, env: process.env }),
      initialization: { typescript: { tsdk } },
    }
  },
}

const isModuleOf = (pomContent: string, modulePath: string) => {
  const normalized = modulePath.replace(/\\/g, "/").replace(/\/$/, "")
  if (!normalized) return false
  const modulesBlocks = pomContent.match(/<modules>([\s\S]*?)<\/modules>/g) ?? []
  for (const block of modulesBlocks) {
    const stripped = block.replace(/<!--[\s\S]*?-->/g, "")
    for (const match of stripped.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const decl = match[1]!.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")
      if (decl === normalized) return true
    }
  }
  return false
}

export const JDTLS: Info = {
  id: "jdtls",
  autoDownload: true,
  root: async (file, ctx) => {
    const settingsMarkers = ["settings.gradle", "settings.gradle.kts"]
    const gradleMarkers = ["gradlew", "gradlew.bat"]
    const [wrapperRoot, settingsRoot] = await Promise.all([
      StrictNearestRoot(gradleMarkers, settingsMarkers)(file, ctx),
      StrictNearestRoot(settingsMarkers)(file, ctx),
    ])
    if (wrapperRoot) return wrapperRoot
    if (settingsRoot) return settingsRoot
    const buildRoot = await StrictNearestRoot(["build.gradle", "build.gradle.kts"])(file, ctx)
    if (buildRoot) return buildRoot

    const pomFiles = await findUp("pom.xml", path.dirname(file), ctx.directory)
    if (pomFiles.length > 0) {
      let root = path.dirname(pomFiles[0]!)
      for (let index = 1; index < pomFiles.length; index++) {
        const parentDir = path.dirname(pomFiles[index]!)
        const rel = path.relative(parentDir, root)
        const content = await fs.readFile(pomFiles[index]!, "utf-8").catch(() => null)
        if (content && isModuleOf(content, rel)) root = parentDir
        else break
      }
      return root
    }

    return StrictNearestRoot([".project", ".classpath"])(file, ctx)
  },
  extensions: [".java"],
  async spawn(root, _ctx, flags) {
    const java = which("java")
    if (!java) return
    const version = await runSafe(["java", "-version"]).then((result) => {
      const match = /"(\d+)\.\d+\.\d+"/.exec(result.stderr.toString())
      return !match ? undefined : Number.parseInt(match[1]!, 10)
    })
    if (version == null || version < 21) return

    const distPath = path.join(bin(), "jdtls")
    const launcherDir = path.join(distPath, "plugins")
    if (!(await pathExists(launcherDir))) {
      if (flags.disableLspDownload) return
      await mkdirp(distPath)
      const archiveName = "release.tar.gz"
      if (
        !(await download(
          "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz",
          path.join(distPath, archiveName),
        ))
      ) {
        return
      }
      if (!(await extractTar(archiveName, distPath))) return
      await removeFile(path.join(distPath, archiveName))
    }
    const jarFileName =
      (await fs.readdir(launcherDir).catch(() => [])).find((item) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(item))?.trim() ??
      ""
    const launcherJar = path.join(launcherDir, jarFileName)
    if (!(await pathExists(launcherJar))) return
    const configFile = path.join(
      distPath,
      process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux",
    )
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "banyancode-jdtls-data"))
    return {
      process: spawn(
        [
          java,
          "-jar",
          launcherJar,
          "-configuration",
          configFile,
          "-data",
          dataDir,
          "-Declipse.application=org.eclipse.jdt.ls.core.id1",
          "-Dosgi.bundles.defaultStartLevel=4",
          "-Declipse.product=org.eclipse.jdt.ls.core.product",
          "-Dlog.level=ALL",
          "--add-modules=ALL-SYSTEM",
          "--add-opens java.base/java.util=ALL-UNNAMED",
          "--add-opens java.base/java.lang=ALL-UNNAMED",
        ],
        { cwd: root },
      ),
    }
  },
}

export const KotlinLS: Info = {
  id: "kotlin-ls",
  extensions: [".kt", ".kts"],
  autoDownload: true,
  root: async (file, ctx) => {
    const settingsRoot = await NearestRoot(["settings.gradle.kts", "settings.gradle"])(file, ctx)
    if (settingsRoot) return settingsRoot
    const wrapperRoot = await NearestRoot(["gradlew", "gradlew.bat"])(file, ctx)
    if (wrapperRoot) return wrapperRoot
    const buildRoot = await NearestRoot(["build.gradle.kts", "build.gradle"])(file, ctx)
    if (buildRoot) return buildRoot
    return NearestRoot(["pom.xml"])(file, ctx)
  },
  async spawn(root, _ctx, flags) {
    const distPath = path.join(bin(), "kotlin-ls")
    const launcher = process.platform === "win32" ? path.join(distPath, "kotlin-lsp.cmd") : path.join(distPath, "kotlin-lsp.sh")
    if (!(await exists(launcher))) {
      if (flags.disableLspDownload) return
      const release = await downloadJson<{ name?: string }>("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest")
      if (!release) return
      const version = release.name?.replace(/^v/, "")
      if (!version) return
      const arch = process.arch
      let kotlinArch: string = arch
      if (arch === "arm64") kotlinArch = "aarch64"
      else if (arch === "x64") kotlinArch = "x64"
      let kotlinPlatform: string = process.platform
      if (process.platform === "darwin") kotlinPlatform = "mac"
      else if (process.platform === "win32") kotlinPlatform = "win"
      const supported = ["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]
      const combo = `${kotlinPlatform}-${kotlinArch}`
      if (!supported.includes(combo)) return
      const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`
      await mkdirp(distPath)
      const archivePath = path.join(distPath, "kotlin-ls.zip")
      if (!(await download(`https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`, archivePath))) return
      const ok = await extractZip(archivePath, distPath)
        .then(() => true)
        .catch(() => false)
      if (!ok) return
      await removeFile(archivePath)
      if (process.platform !== "win32") await chmodSafe(launcher, 0o755)
    }
    if (!(await exists(launcher))) return
    return { process: spawn([launcher, "--stdio"], { cwd: root }) }
  },
}

export const YamlLS: Info = {
  id: "yaml-ls",
  extensions: [".yaml", ".yml"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn(root, _ctx, flags) {
    let binary = which("yaml-language-server")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("yaml-language-server")
      if (!binary) return
    }
    return { process: spawn([binary, "--stdio"], { cwd: root, env: process.env }) }
  },
}

export const LuaLS: Info = {
  id: "lua-ls",
  root: NearestRoot([
    ".luarc.json",
    ".luarc.jsonc",
    ".luacheckrc",
    ".stylua.toml",
    "stylua.toml",
    "selene.toml",
    "selene.yml",
  ]),
  extensions: [".lua"],
  async spawn(root, _ctx, flags) {
    let binary = which("lua-language-server")
    if (!binary) {
      if (flags.disableLspDownload) return
      const release = await downloadJson<{
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      }>("https://api.github.com/repos/LuaLS/lua-language-server/releases/latest")
      if (!release) return
      const arch = process.arch
      let lualsArch: string = arch
      if (arch === "arm64") lualsArch = "arm64"
      else if (arch === "x64") lualsArch = "x64"
      else if (arch === "ia32") lualsArch = "ia32"
      let lualsPlatform: string = process.platform
      if (process.platform === "darwin") lualsPlatform = "darwin"
      if (process.platform === "win32") lualsPlatform = "win32"
      const ext = process.platform === "win32" ? "zip" : "tar.gz"
      const assetName = `lua-language-server-${release.tag_name}-${lualsPlatform}-${lualsArch}.${ext}`
      const supported = [
        "darwin-arm64.tar.gz",
        "darwin-x64.tar.gz",
        "linux-x64.tar.gz",
        "linux-arm64.tar.gz",
        "win32-x64.zip",
        "win32-ia32.zip",
      ]
      if (!supported.includes(`${lualsPlatform}-${lualsArch}.${ext}`)) return
      const asset = release.assets?.find((item) => item.name === assetName)
      if (!asset?.browser_download_url) return
      const tempPath = path.join(bin(), assetName)
      if (!(await download(asset.browser_download_url, tempPath))) return
      const installDir = path.join(bin(), `lua-language-server-${lualsArch}-${lualsPlatform}`)
      if (await pathExists(installDir)) await remove(installDir, true)
      await mkdirp(installDir)
      if (ext === "zip") {
        const ok = await extractZip(tempPath, installDir)
          .then(() => true)
          .catch(() => false)
        if (!ok) return
      } else if (!(await extractTar(tempPath, installDir))) {
        return
      }
      await removeFile(tempPath)
      binary = path.join(installDir, "bin", "lua-language-server" + (process.platform === "win32" ? ".exe" : ""))
      if (!(await exists(binary))) return
      if (process.platform !== "win32" && !(await chmodSafe(binary, 0o755).then(() => true))) return
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const PHPIntelephense: Info = {
  id: "php intelephense",
  extensions: [".php"],
  root: NearestRoot(["composer.json", "composer.lock", ".php-version"]),
  async spawn(root, _ctx, flags) {
    let binary = which("intelephense")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("intelephense")
      if (!binary) return
    }
    return {
      process: spawn([binary, "--stdio"], { cwd: root, env: process.env }),
      initialization: { telemetry: { enabled: false } },
    }
  },
}

export const Prisma: Info = {
  id: "prisma",
  extensions: [".prisma"],
  root: NearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
  async spawn(root) {
    const prisma = which("prisma")
    if (!prisma) return
    return { process: spawn([prisma, "language-server"], { cwd: root }) }
  },
}

export const Dart: Info = {
  id: "dart",
  extensions: [".dart"],
  root: NearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
  async spawn(root) {
    const dart = which("dart")
    if (!dart) return
    return { process: spawn([dart, "language-server", "--lsp"], { cwd: root }) }
  },
}

export const Ocaml: Info = {
  id: "ocaml-lsp",
  extensions: [".ml", ".mli"],
  root: NearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
  async spawn(root) {
    const binary = which("ocamllsp")
    if (!binary) return
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const BashLS: Info = {
  id: "bash",
  extensions: [".sh", ".bash", ".zsh", ".ksh"],
  root: async (_file, ctx) => ctx.directory,
  async spawn(root, _ctx, flags) {
    let binary = which("bash-language-server")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("bash-language-server")
      if (!binary) return
    }
    return { process: spawn([binary, "start"], { cwd: root, env: process.env }) }
  },
}

export const TerraformLS: Info = {
  id: "terraform",
  extensions: [".tf", ".tfvars"],
  root: NearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
  async spawn(root, _ctx, flags) {
    let binary = which("terraform-ls")
    if (!binary) {
      if (flags.disableLspDownload) return
      const release = await downloadJson<{ version?: string; builds?: { arch?: string; os?: string; url?: string }[] }>(
        "https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest",
      )
      if (!release) return
      const tfArch = process.arch === "arm64" ? "arm64" : "amd64"
      const tfPlatform = process.platform === "win32" ? "windows" : process.platform
      const build = (release.builds ?? []).find((item) => item.arch === tfArch && item.os === tfPlatform)
      if (!build?.url) return
      const tempPath = path.join(bin(), "terraform-ls.zip")
      if (!(await download(build.url, tempPath))) return
      const ok = await extractZip(tempPath, bin())
        .then(() => true)
        .catch(() => false)
      if (!ok) return
      await removeFile(tempPath)
      binary = path.join(bin(), "terraform-ls" + (process.platform === "win32" ? ".exe" : ""))
      if (!(await exists(binary))) return
      if (process.platform !== "win32") await chmodSafe(binary, 0o755)
    }
    return {
      process: spawn([binary, "serve"], { cwd: root }),
      initialization: { experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true } },
    }
  },
}

export const TexLab: Info = {
  id: "texlab",
  extensions: [".tex", ".bib"],
  root: NearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
  async spawn(root, _ctx, flags) {
    let binary = which("texlab")
    if (!binary) {
      if (flags.disableLspDownload) return
      const release = await downloadJson<{
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      }>("https://api.github.com/repos/latex-lsp/texlab/releases/latest")
      if (!release) return
      const version = release.tag_name?.replace("v", "")
      if (!version) return
      const texArch = process.arch === "arm64" ? "aarch64" : "x86_64"
      const texPlatform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
      const ext = process.platform === "win32" ? "zip" : "tar.gz"
      const assetName = `texlab-${texArch}-${texPlatform}.${ext}`
      const asset = (release.assets ?? []).find((item) => item.name === assetName)
      if (!asset?.browser_download_url) return
      const tempPath = path.join(bin(), assetName)
      if (!(await download(asset.browser_download_url, tempPath))) return
      if (ext === "zip") {
        const ok = await extractZip(tempPath, bin())
          .then(() => true)
          .catch(() => false)
        if (!ok) return
      } else {
        await runSafe(["tar", "-xzf", tempPath], { cwd: bin() })
      }
      await removeFile(tempPath)
      binary = path.join(bin(), "texlab" + (process.platform === "win32" ? ".exe" : ""))
      if (!(await exists(binary))) return
      if (process.platform !== "win32") await chmodSafe(binary, 0o755)
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const DockerfileLS: Info = {
  id: "dockerfile",
  extensions: [".dockerfile", "Dockerfile"],
  root: async (_file, ctx) => ctx.directory,
  async spawn(root, _ctx, flags) {
    let binary = which("docker-langserver")
    if (!binary) {
      if (flags.disableLspDownload) return
      binary = await npmWhich("dockerfile-language-server-nodejs")
      if (!binary) return
    }
    return { process: spawn([binary, "--stdio"], { cwd: root, env: process.env }) }
  },
}

export const Gleam: Info = {
  id: "gleam",
  extensions: [".gleam"],
  root: NearestRoot(["gleam.toml"]),
  async spawn(root) {
    const gleam = which("gleam")
    if (!gleam) return
    return { process: spawn([gleam, "lsp"], { cwd: root }) }
  },
}

export const Clojure: Info = {
  id: "clojure-lsp",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  root: NearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
  async spawn(root) {
    let binary = which("clojure-lsp")
    if (!binary && process.platform === "win32") binary = which("clojure-lsp.exe")
    if (!binary) return
    return { process: spawn([binary, "listen"], { cwd: root }) }
  },
}

export const Nixd: Info = {
  id: "nixd",
  extensions: [".nix"],
  root: async (file, ctx) => {
    const flakeRoot = await NearestRoot(["flake.nix"])(file, ctx)
    if (flakeRoot && flakeRoot !== ctx.directory) return flakeRoot
    if (ctx.worktree && ctx.worktree !== ctx.directory) return ctx.worktree
    return ctx.directory
  },
  async spawn(root) {
    const nixd = which("nixd")
    if (!nixd) return
    return { process: spawn([nixd], { cwd: root, env: process.env }) }
  },
}

export const Tinymist: Info = {
  id: "tinymist",
  extensions: [".typ", ".typc"],
  root: NearestRoot(["typst.toml"]),
  async spawn(root, _ctx, flags) {
    let binary = which("tinymist")
    if (!binary) {
      if (flags.disableLspDownload) return
      const release = await downloadJson<{
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      }>("https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest")
      if (!release) return
      const tinymistArch = process.arch === "arm64" ? "aarch64" : "x86_64"
      let tinymistPlatform: string
      let ext: string
      if (process.platform === "darwin") {
        tinymistPlatform = "apple-darwin"
        ext = "tar.gz"
      } else if (process.platform === "win32") {
        tinymistPlatform = "pc-windows-msvc"
        ext = "zip"
      } else {
        tinymistPlatform = "unknown-linux-gnu"
        ext = "tar.gz"
      }
      const assetName = `tinymist-${tinymistArch}-${tinymistPlatform}.${ext}`
      const asset = (release.assets ?? []).find((item) => item.name === assetName)
      if (!asset?.browser_download_url) return
      const tempPath = path.join(bin(), assetName)
      if (!(await download(asset.browser_download_url, tempPath))) return
      if (ext === "zip") {
        const ok = await extractZip(tempPath, bin())
          .then(() => true)
          .catch(() => false)
        if (!ok) return
      } else {
        await runSafe(["tar", "-xzf", tempPath, "--strip-components=1"], { cwd: bin() })
      }
      await removeFile(tempPath)
      binary = path.join(bin(), "tinymist" + (process.platform === "win32" ? ".exe" : ""))
      if (!(await exists(binary))) return
      if (process.platform !== "win32") await chmodSafe(binary, 0o755)
    }
    return { process: spawn([binary], { cwd: root }) }
  },
}

export const HLS: Info = {
  id: "haskell-language-server",
  extensions: [".hs", ".lhs"],
  root: NearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
  async spawn(root) {
    const binary = which("haskell-language-server-wrapper")
    if (!binary) return
    return { process: spawn([binary, "--lsp"], { cwd: root }) }
  },
}

export const JuliaLS: Info = {
  id: "julials",
  extensions: [".jl"],
  root: NearestRoot(["Project.toml", "Manifest.toml", "*.jl"]),
  async spawn(root) {
    const julia = which("julia")
    if (!julia) return
    return {
      process: spawn([julia, "--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"], {
        cwd: root,
      }),
    }
  },
}

/** Every built-in definition (v1 iterated `Object.values(LSPServer)`). */
export const builtinServers: readonly Info[] = [
  Deno,
  Typescript,
  Vue,
  ESLint,
  Oxlint,
  Biome,
  Gopls,
  Rubocop,
  Ty,
  Pyright,
  ElixirLS,
  Zls,
  CSharp,
  Razor,
  FSharp,
  SourceKit,
  RustAnalyzer,
  Clangd,
  Svelte,
  Astro,
  JDTLS,
  KotlinLS,
  YamlLS,
  LuaLS,
  PHPIntelephense,
  Prisma,
  Dart,
  Ocaml,
  BashLS,
  TerraformLS,
  TexLab,
  DockerfileLS,
  Gleam,
  Clojure,
  Nixd,
  Tinymist,
  HLS,
  JuliaLS,
]

export type { Child, ChildProcessWithoutNullStreams, Handle }
