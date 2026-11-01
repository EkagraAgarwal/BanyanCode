#!/usr/bin/env bun
// BanyanCode CalVer source of truth.
//
// The version lives in this BanyanCode-owned file, NOT in
// packages/cli/package.json. That manifest carries the upstream OpenCode
// release (`2.2.5` today) and is rewritten by every upstream release merge, so
// using it would (a) conflict on every merge, (b) drag bun.lock workspace
// versions along, and (c) make the published package version diverge from npm
// on every upstream bump. Release scripts stamp this CalVer into the generated
// dist manifests at pack/publish time, so npm still sees a normal semver.
//
// CalVer is `YY.MM.PATCH` and continues after v1's last release (26.10.9).
// Dev canaries are `<base>-dev.<sha7>` on the `dev` channel; rc/beta builds map
// to the `next` dist-tag, everything else to `latest`.
import path from "node:path"

export const VERSION_FILE = path.resolve(import.meta.dir, "version.json")

/** Last release cut from the v1 tree (D:/OpenCode, tag v1-final). */
export const V1_LAST_VERSION = "26.10.9"

export const CALVER = /^(\d{2})\.(\d{2})\.(\d+)$/

export type Channel = "latest" | "dev" | "next"

export function isCalVer(value: string): boolean {
  return CALVER.test(value)
}

/** Numeric YY.MM.PATCH compare; multi-digit patches sort correctly (26.10.10 > 26.10.9). */
export function compareCalVer(a: string, b: string): number {
  const left = CALVER.exec(a)
  const right = CALVER.exec(b)
  if (!left || !right) throw new Error(`not a CalVer version: ${!left ? a : b}`)
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  return 0
}

/** Dist-tag the release workflow publishes to. Mirrors v1's suffix rule. */
export function channelForVersion(version: string): Channel {
  if (/-dev\./.test(version)) return "dev"
  if (/-rc\.|-beta\./.test(version)) return "next"
  return "latest"
}

export function devVersion(base: string, sha: string): string {
  if (!isCalVer(base)) throw new Error(`base version must be CalVer YY.MM.PATCH, got ${base}`)
  return `${base}-dev.${sha}`
}

export async function readBaseVersion(file: string = VERSION_FILE): Promise<string> {
  const parsed: unknown = await Bun.file(file).json()
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${file} must be {"version":"YY.MM.PATCH"}`)
  }
  const version = String((parsed as { version: unknown }).version)
  if (!isCalVer(version)) throw new Error(`${file} version is not CalVer YY.MM.PATCH: ${version}`)
  return version
}

export async function writeBaseVersion(version: string, file: string = VERSION_FILE): Promise<void> {
  if (!isCalVer(version)) throw new Error(`base version must be CalVer YY.MM.PATCH, got ${version}`)
  await Bun.write(file, `${JSON.stringify({ version }, null, 2)}\n`)
}

/** 7-char commit sha: explicit input, then CI's GITHUB_SHA, then git. */
export function shortSha(explicit?: string): string {
  const candidate = explicit ?? process.env.GITHUB_SHA
  if (candidate && candidate.trim().length >= 7) return candidate.trim().slice(0, 7)
  const result = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], { stdout: "pipe", stderr: "pipe" })
  const sha = result.stdout?.toString().trim() ?? ""
  if (result.exitCode !== 0 || sha.length === 0) {
    throw new Error(`cannot resolve the commit sha (git exit ${result.exitCode}); pass --sha`)
  }
  return sha
}

/**
 * Resolve the version a build/publish run should use.
 * - explicit `version` wins (release dispatch / prerelease tags)
 * - `channel: "dev"` always appends `-dev.<sha7>`, even when the base version
 *   already carries a dev suffix (repeated dispatches stay distinct)
 * - `channel: "latest"` / unset returns the bare CalVer
 */
export function resolveVersion(input: {
  readonly channel?: Channel
  readonly version?: string
  readonly sha?: string
  readonly base?: string
}): string {
  const base = input.version ?? input.base
  if (base === undefined) throw new Error("resolveVersion needs a base version")
  if (input.channel !== "dev") return base
  const stripped = base.replace(/-dev\.[0-9a-zA-Z]+$/, "")
  if (!isCalVer(stripped)) throw new Error(`dev base version must be CalVer YY.MM.PATCH, got ${stripped}`)
  return devVersion(stripped, shortSha(input.sha))
}

export * as BanyanVersion from "./version"
