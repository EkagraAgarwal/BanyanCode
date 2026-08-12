import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { shimScript } from "../../script/install-shim"

const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
const archMap: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "arm" }

// A binaries map that exercises every candidate branch (baseline/musl variants)
// plus the exact platform package for THIS test machine.
const fakeBinaries: Record<string, string> = {
  "banyancode-linux-x64": "1.0.0",
  "banyancode-linux-x64-baseline": "1.0.0",
  "banyancode-linux-x64-musl": "1.0.0",
  "banyancode-linux-x64-baseline-musl": "1.0.0",
  "banyancode-linux-arm64": "1.0.0",
  "banyancode-linux-arm64-musl": "1.0.0",
  "banyancode-darwin-x64": "1.0.0",
  "banyancode-darwin-x64-baseline": "1.0.0",
  "banyancode-darwin-arm64": "1.0.0",
  "banyancode-windows-x64": "1.0.0",
  "banyancode-windows-x64-baseline": "1.0.0",
}

const localPlatform = platformMap[process.platform] ?? process.platform
const localArch = archMap[process.arch] ?? process.arch
const localPkgName = `banyancode-${localPlatform}-${localArch}`
const localPkgVersion = "9.9.9"

describe("shimScript content", () => {
  test("starts with a node shebang and has no sh-exec polyglot line", () => {
    const script = shimScript(fakeBinaries)
    const [first] = script.split("\n")
    expect(first).toBe("#!/usr/bin/env node")
    expect(script).not.toContain("':' //;")
    expect(script).not.toContain("command -v nodejs")
  })

  test("embeds the platform-package name/version map", () => {
    const script = shimScript(fakeBinaries)
    expect(script).toContain("const PACKAGES =")
    for (const [name, version] of Object.entries(fakeBinaries)) {
      expect(script, name).toContain(JSON.stringify(name))
      expect(script, name).toContain(JSON.stringify(version))
    }
  })

  test("contains ELF and MZ native-magic checks", () => {
    const script = shimScript(fakeBinaries)
    // ELF magic: 0x7f 0x45 0x4c 0x46
    expect(script).toContain("0x7f")
    expect(script).toContain("0x45")
    expect(script).toContain("0x4c")
    expect(script).toContain("0x46")
    // MZ magic: 0x4d 0x5a
    expect(script).toContain("0x4d")
    expect(script).toContain("0x5a")
  })

  test("contains allow-scripts and manual postinstall guidance", () => {
    const script = shimScript(fakeBinaries)
    expect(script).toContain("--allow-scripts")
    expect(script).toContain("node postinstall.mjs")
    expect(script).toContain("pnpm approve-builds")
    expect(script).toContain("onlyBuiltDependencies")
  })

  test("contains baseline/musl candidate branches", () => {
    const script = shimScript(fakeBinaries)
    expect(script).toContain("-baseline")
    expect(script).toContain("-musl")
  })
})

function writeShim(tmp: string, script: string, relativeShimDir: string): string {
  const shimPath = path.join(tmp, relativeShimDir, "bin", "banyancode.js")
  fs.mkdirSync(path.dirname(shimPath), { recursive: true })
  fs.writeFileSync(shimPath, script)
  return shimPath
}

function writeFakePlatformPackage(tmp: string) {
  const pkgDir = path.join(tmp, "node_modules", localPkgName)
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: localPkgName, version: localPkgVersion }),
  )
  const bin = path.join(pkgDir, "bin", "banyancode")
  fs.writeFileSync(bin, "#!/usr/bin/env node\nconsole.log('STUB-OK ' + process.argv.slice(2).join(' '))\n")
  fs.chmodSync(bin, 0o755)
  return bin
}

function withTmpDir(fn: (tmp: string) => void) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"))
  try {
    fn(tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Functional spawn tests run on non-win32 only: on Windows a fake platform
// package's "binary" would need to be a real PE executable (a .js-content file
// named .exe cannot be spawned), which is out of scope for this fixture.
// Tests are synchronous (mkdtempSync + spawnSync) on purpose: async `await
// using` disposal inside skipIf'd tests trips a non-deterministic bun test-runner
// hook timeout on cold runs.
const skipOnWindows = test.skipIf(process.platform === "win32")

describe("install-shim functional", () => {
  skipOnWindows("resolves the fake platform package and spawns it with forwarded args", () => {
    withTmpDir((tmp) => {
      const shimPath = writeShim(tmp, shimScript({ [localPkgName]: localPkgVersion }), "node_modules/banyancode")
      writeFakePlatformPackage(tmp)

      const result = spawnSync(process.execPath, [shimPath, "--version"], { encoding: "utf8", timeout: 30_000 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("STUB-OK --version")
    })
  })

  skipOnWindows("does not spawn a stale text placeholder at the fast-path location", () => {
    withTmpDir((tmp) => {
      const shimPath = writeShim(tmp, shimScript({ [localPkgName]: localPkgVersion }), "node_modules/banyancode")

      // Stale text placeholder at the postinstall fast-path location — no ELF/MZ
      // magic, so the shim must NOT execute it and must fall through to the
      // platform package.
      fs.writeFileSync(path.join(path.dirname(shimPath), "banyancode.exe"), 'echo "stale placeholder"\nexit 1\n')
      writeFakePlatformPackage(tmp)

      const result = spawnSync(process.execPath, [shimPath, "--version"], { encoding: "utf8", timeout: 30_000 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("STUB-OK --version")
      expect(result.stdout).not.toContain("stale placeholder")
    })
  })

  skipOnWindows("falls back to the platform package when a fast-path file has ELF magic but is not executable", () => {
    withTmpDir((tmp) => {
      const shimPath = writeShim(tmp, shimScript({ [localPkgName]: localPkgVersion }), "node_modules/banyancode")

      // ELF magic bytes with no shebang and no exec bit — spawn must fail and the
      // shim must fall through to the fake platform package.
      const fakeFastPath = path.join(path.dirname(shimPath), "banyancode.exe")
      fs.writeFileSync(fakeFastPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
      fs.chmodSync(fakeFastPath, 0o644)
      writeFakePlatformPackage(tmp)

      const result = spawnSync(process.execPath, [shimPath, "--version"], { encoding: "utf8", timeout: 30_000 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("STUB-OK --version")
    })
  })
})
