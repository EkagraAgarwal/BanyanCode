#!/usr/bin/env bun
// The release target list: every npm platform package BanyanCode publishes.
//
// v1 shipped 11 platform packages (and 10 GitHub assets: the Windows
// `baseline` build exists only as an npm fallback for pre-AVX2 CPUs). v2 adds
// Windows ARM64, so the matrix now covers 12 packages / 11 release assets.
// Keep this list in sync with `allTargets` in packages/cli/script/build.ts.

export type Platform = {
  /** Build target suffix, e.g. `linux-x64` (build.ts `opencode-<target>`). */
  readonly target: string
  /** npm package suffix (`banyancode-<package>`). */
  readonly npm: string
  readonly os: "darwin" | "linux" | "win32"
  readonly cpu: "arm64" | "x64"
  /** Ships as a GitHub release asset. `windows-x64-baseline` is npm-only. */
  readonly shipping: boolean
  /** Archive extension for the GitHub asset. */
  readonly archive: "tar.gz" | "zip"
}

const platform = (target: string, os: Platform["os"], cpu: Platform["cpu"], shipping = true): Platform => ({
  target,
  npm: `banyancode-${target}`,
  os,
  cpu,
  shipping,
  archive: os === "linux" ? "tar.gz" : "zip",
})

export const PLATFORMS: readonly Platform[] = [
  platform("linux-x64", "linux", "x64"),
  platform("linux-x64-baseline", "linux", "x64"),
  platform("linux-x64-musl", "linux", "x64"),
  platform("linux-x64-baseline-musl", "linux", "x64"),
  platform("linux-arm64", "linux", "arm64"),
  platform("linux-arm64-musl", "linux", "arm64"),
  platform("darwin-x64", "darwin", "x64"),
  platform("darwin-x64-baseline", "darwin", "x64"),
  platform("darwin-arm64", "darwin", "arm64"),
  platform("windows-x64", "win32", "x64"),
  platform("windows-x64-baseline", "win32", "x64", false),
  platform("windows-arm64", "win32", "arm64"),
]

export const UMBRELLA = "banyancode"

export const platformByTarget = (target: string): Platform | undefined =>
  PLATFORMS.find((entry) => entry.target === target)

export const executableName = (os: Platform["os"]): string => (os === "win32" ? "banyancode.exe" : "banyancode")

/**
 * The codegraph sidecar ships beside the executable in every platform package
 * and archive. It is an optimisation: without it the indexer falls back to the
 * TypeScript parsers, so a local dev pack may omit it.
 */
export const SIDECAR = "banyan-indexer"

export const sidecarName = (os: Platform["os"]): string => (os === "win32" ? `${SIDECAR}.exe` : SIDECAR)

/** The sidecar as staged by build.ts inside `cli-<target>/bin`. */
export const builtSidecar = (dist: string, entry: Platform): string =>
  `${buildDirectory(dist, entry)}/bin/${sidecarName(entry.os)}`

/** The build directory build.ts writes: `cli-<target>`, binary name `opencode(.exe)`. */
export const buildDirectory = (dist: string, entry: Platform): string =>
  `${dist}/cli-${entry.target}`

export const builtBinary = (dist: string, entry: Platform): string =>
  `${buildDirectory(dist, entry)}/bin/${entry.os === "win32" ? "opencode.exe" : "opencode"}`

export const currentPlatform = (): Platform | undefined => {
  const os = process.platform === "win32" ? "windows" : process.platform
  return PLATFORMS.find((entry) => entry.target === `${os}-${process.arch}`)
}

export * as BanyanPlatforms from "./platforms"
