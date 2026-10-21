#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()
const base = `banyancode-${platform}-${arch}`
const sourceBinary = platform === "windows" ? "banyancode.exe" : "banyancode"
const targetBinary = path.join(__dirname, "bin", "banyancode.exe")

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()

  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64")
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      return [`${base}-musl`, base]
    }

    if (arch === "x64")
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    return [base, `${base}-musl`]
  }

  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  // require.resolve walks up the directory tree, so a stale platform package
  // in an ancestor node_modules (e.g. ~/node_modules from an old local
  // install) would win over the pinned version. Only accept an exact match;
  // otherwise fall through to installPackage, which fetches the pinned one.
  const expected = packageJson.optionalDependencies?.[name]
  const found = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version
  if (expected && found !== expected) throw new Error(`${name}@${found} does not match ${expected}`)
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary)
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
  return binaryPath
}

// Run npm portably. Node refuses to spawn npm.cmd on Windows without a shell,
// so the fallback install never ran there. Prefer npm's own CLI script
// (npm_execpath is set for lifecycle scripts) via the running node; otherwise
// use a shell on Windows with quoted args (temp paths may contain spaces).
function runNpm(args, stdio) {
  const cli = process.env.npm_execpath
  if (cli && cli.endsWith(".js")) return childProcess.spawnSync(process.execPath, [cli, ...args], { stdio, windowsHide: true })
  if (process.platform !== "win32") return childProcess.spawnSync("npm", args, { stdio, windowsHide: true })
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? '"' + arg.replace(/"/g, '""') + '"' : arg))
  return childProcess.spawnSync("npm", quoted, { stdio, windowsHide: true, shell: true })
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "banyancode-install-"))
  try {
    const result = runNpm(
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      "inherit",
    )
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", name)
    copyBinary(path.join(packageDir, "bin", sourceBinary), targetBinary)
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
}

function main() {
  for (const name of packageNames()) {
    try {
      copyBinary(resolveBinary(name), targetBinary)
      if (verifyBinary()) return
    } catch {
      if (installPackage(name) && verifyBinary()) return
    }
  }

  throw new Error(
    `It seems your package manager failed to install the right banyancode CLI package. Try manually installing ${packageNames()
      .map((name) => JSON.stringify(name))
      .join(" or ")}.\n` +
      `\n` +
      `If the postinstall script itself was skipped: npm 11+ blocks lifecycle scripts unless\n` +
      `they are approved, and pnpm skips them by default. Install or upgrade with:\n` +
      `  npm install -g --allow-scripts=banyancode banyancode\n` +
      `  npm config set allow-scripts=banyancode --location=user\n` +
      `  pnpm approve-builds   (or add banyancode to onlyBuiltDependencies)\n` +
      `\n` +
      `Or run the postinstall script manually:\n` +
      `  cd node_modules/banyancode && node postinstall.mjs`,
  )
}

// Best-effort pre-copy. The JS shim (bin/banyancode.js) resolves the platform
// package at runtime, so an npm install must never fail because of this script.
// On success the native binary is copied to bin/banyancode.exe, which the shim
// uses as a magic-checked fast path.
try {
  main()
} catch (error) {
  console.error(`banyancode postinstall: ${error.message}`)
  console.error(
    "banyancode postinstall: continuing anyway — the JS shim (bin/banyancode.js) will resolve the platform package at runtime.",
  )
  process.exit(0)
}
