/**
 * Native `banyan-indexer` sidecar, built and staged per CLI target.
 *
 * Every platform package ships the sidecar for its own target next to the
 * `opencode` executable, because the client resolves it from
 * `dirname(process.execPath)` first. The sidecar is an optimisation: when it is
 * missing the indexer falls back to the TypeScript parsers, so a local
 * `--single` build without cargo still produces a working binary.
 *
 * Cross-compilation goes through `cargo-zigbuild` (zig ships a libc and a
 * linker per target, so musl and glibc both work without a per-target sysroot).
 */
import { $ } from "bun"
import { copyFile, mkdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export type CliTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

const NATIVE_DIR = path.resolve(import.meta.dir, "..", "..", "banyancode", "native")
export const NATIVE_BINARY = "banyan-indexer"

/** Rust target triple per CLI target. `avx2: false` shares the triple. */
export const rustTriple = (item: CliTarget): string => {
  if (item.os === "linux") {
    const arch = item.arch === "arm64" ? "aarch64" : "x86_64"
    return `${arch}-unknown-linux-${item.abi === "musl" ? "musl" : "gnu"}`
  }
  if (item.os === "darwin") return `${item.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
  if (item.os === "win32") return `${item.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
  throw new Error(`No Rust target triple for ${item.os}-${item.arch}`)
}

export const sidecarFileName = (item: CliTarget): string =>
  item.os === "win32" ? `${NATIVE_BINARY}.exe` : NATIVE_BINARY

const hostIsMusl = (): boolean => {
  if (process.platform !== "linux") return false
  try {
    return existsSync("/etc/alpine-release")
  } catch {
    return false
  }
}

const isHostTarget = (item: CliTarget): boolean => {
  if (item.os !== process.platform || item.arch !== process.arch) return false
  if (item.os !== "linux") return true
  // A glibc host cannot produce or run the musl artifact; only the libc that
  // matches this machine counts as "host" for verification purposes.
  return hostIsMusl() === (item.abi === "musl")
}

const exists = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

const commandAvailable = (command: string, args: string[]): boolean => {
  try {
    const result = Bun.spawnSync({ cmd: [command, ...args], stdout: "ignore", stderr: "ignore" })
    return result.exitCode === 0
  } catch {
    return false
  }
}

export interface BuildSidecarOptions {
  /**
   * Release/pack builds must carry the sidecar. A `--single` dev build may go
   * without it and falls back to the TypeScript parsers with a warning.
   */
  readonly required: boolean
}

/**
 * Build (or reuse) the sidecar for `item` and return its path. Returns
 * `undefined` only when the sidecar is optional and the toolchain is missing.
 */
export const buildNativeIndexer = async (
  item: CliTarget,
  options: BuildSidecarOptions,
): Promise<string | undefined> => {
  if (process.env.BANYANCODE_SKIP_NATIVE_INDEXER === "1") {
    if (options.required) {
      throw new Error(
        "BANYANCODE_SKIP_NATIVE_INDEXER=1 but this is a release build: every platform package must ship banyan-indexer. Unset it or build with --single.",
      )
    }
    console.warn("[native-indexer] BANYANCODE_SKIP_NATIVE_INDEXER=1, shipping without the sidecar (TypeScript fallback)")
    return undefined
  }

  const triple = rustTriple(item)
  const host = isHostTarget(item)
  const out = host
    ? path.join(NATIVE_DIR, "target", "release", sidecarFileName(item))
    : path.join(NATIVE_DIR, "target", triple, "release", sidecarFileName(item))

  if (await exists(out)) return out

  if (!commandAvailable("cargo", ["--version"])) {
    if (options.required) {
      throw new Error(
        `banyan-indexer is required for the ${item.os}-${item.arch}${item.abi ? `-${item.abi}` : ""} package but cargo is not on PATH.\n` +
          "Install Rust (https://rustup.rs) and rerun the build, or use --single for a local build that falls back to the TypeScript parser.",
      )
    }
    console.warn("[native-indexer] cargo not found, shipping without the sidecar (TypeScript fallback)")
    return undefined
  }

  if (host) {
    console.log(`[native-indexer] cargo build --release (${triple})`)
    await $`cargo build --release`.cwd(NATIVE_DIR)
  } else if (item.os === "linux" && commandAvailable("cargo", ["zigbuild", "--help"])) {
    // zigbuild has no --version flag, so probe with --help. Only Linux targets use it:
    // macOS cross-builds with the system clang, and zig cannot emit the MSVC ABI.
    console.log(`[native-indexer] cargo zigbuild --release --target ${triple}`)
    await $`rustup target add ${triple}`
    await $`cargo zigbuild --release --target ${triple}`.cwd(NATIVE_DIR)
  } else {
    // No zigbuild: a native toolchain for the target may still exist (a Windows
    // x64 runner cross-building windows-arm64 with the MSVC ARM64 toolset, for
    // example). Try it, and only then fail.
    console.warn(`[native-indexer] cargo-zigbuild not found, trying cargo build --target ${triple}`)
    const added = Bun.spawnSync({ cmd: ["rustup", "target", "add", triple], stdout: "ignore", stderr: "ignore" })
    const built = added.exitCode === 0
      ? Bun.spawnSync({ cmd: ["cargo", "build", "--release", "--target", triple], cwd: NATIVE_DIR, stdout: "inherit", stderr: "inherit" })
      : undefined
    if (built?.exitCode !== 0) {
      if (options.required) {
        throw new Error(
          `banyan-indexer for ${triple} could not be cross-compiled.\n` +
            "Install cargo-zigbuild (`cargo install cargo-zigbuild`) with zig on PATH, or build this target on its own platform.\n" +
            "Release builds must ship the sidecar for every target.",
        )
      }
      console.warn(`[native-indexer] cannot build the sidecar for ${triple}, shipping without it (TypeScript fallback)`)
      return undefined
    }
  }

  if (!(await exists(out))) {
    throw new Error(`banyan-indexer build produced no binary at ${out} (target ${triple})`)
  }
  return out
}

/** Copy the sidecar next to the CLI binary inside the platform package. */
export const stageNativeIndexer = async (binDir: string, item: CliTarget, source: string): Promise<string> => {
  await mkdir(binDir, { recursive: true })
  const destination = path.join(binDir, sidecarFileName(item))
  await copyFile(source, destination)
  return destination
}

/**
 * Run `banyan-indexer --version`. Only meaningful for a host-target binary: a
 * cross-compiled one cannot execute here, so callers pass `runnable: false` and
 * verify existence instead.
 */
export const verifyNativeIndexer = async (file: string, runnable: boolean): Promise<void> => {
  if (!(await exists(file))) throw new Error(`Missing native indexer sidecar: ${file}`)
  const size = (await stat(file)).size
  if (size === 0) throw new Error(`Native indexer sidecar is empty: ${file}`)
  if (!runnable) return
  const result = Bun.spawnSync({ cmd: [file, "--version"], stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`banyan-indexer --version failed for ${file}: ${result.stderr.toString().slice(0, 400)}`)
  }
  const output = result.stdout.toString().trim()
  if (!output.startsWith(NATIVE_BINARY)) {
    throw new Error(`banyan-indexer --version printed an unexpected banner: ${output.slice(0, 200)}`)
  }
}

export const nativeIndexerRunnable = (item: CliTarget): boolean => isHostTarget(item)
