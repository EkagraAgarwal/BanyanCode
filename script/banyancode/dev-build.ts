#!/usr/bin/env bun
// Build the current platform's BanyanCode dev binary (channel `dev`).
//
//   bun script/banyancode/dev-build.ts [--baseline] [--outdir=<dir>] [--skip-build] [--sha=<sha>]
//
// The heavy lifting is packages/cli/script/build.ts (the upstream build
// pipeline). This wrapper contributes only the three things upstream does not
// know about: the BanyanCode CalVer version, the `dev` channel (which bakes a
// channel-isolated build) and the `banyancode(.exe)` artifact name.
//
// Output: <outdir>/dev/banyancode(.exe); the path is printed on the last line.
// `dev` builds intentionally skip the web UI bundle (`--skip-web-ui`): a smoke
// run only needs the API surface, and the Vite bundle adds minutes per build.
import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { channelForVersion, readBaseVersion, resolveVersion, shortSha } from "./version"

const args = process.argv.slice(2)
const help = args.includes("--help") || args.includes("-h")
const baseline = args.includes("--baseline")
const skipBuild = args.includes("--skip-build")
const flag = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(`--${name}=`.length)
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = args[index + 1]
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

if (help) {
  console.log(
    [
      "usage: bun script/banyancode/dev-build.ts [options]",
      "",
      "  --baseline     build the no-AVX2 baseline variant (x64 only)",
      "  --outdir=<dir> build outdir, relative to packages/cli (default: dist)",
      "  --skip-build   reuse the existing build, only restage the binary",
      "  --sha=<sha>    commit sha for the -dev.<sha7> suffix (default: git HEAD)",
      "  -h, --help     show this help",
    ].join("\n"),
  )
  process.exit(0)
}

const repo = path.resolve(import.meta.dir, "../..")
const cli = path.join(repo, "packages", "cli")
const outdir = flag("outdir") ?? "dist"
const base = await readBaseVersion()

const target = resolvePlatformTarget()
if (baseline && !target.includes("-x64")) {
  console.error(`--baseline only applies to x64 targets (current: ${target})`)
  process.exit(2)
}
const resolved = baseline ? `${target}-baseline` : target
const executable = process.platform === "win32" ? "opencode.exe" : "opencode"
const built = path.join(cli, outdir, `cli-${resolved}`, "bin", executable)
const staging = path.join(cli, outdir, "dev")
const output = path.join(staging, process.platform === "win32" ? "banyancode.exe" : "banyancode")

// `--skip-build` restages the binary that is already there. Its version is the
// one baked into that binary, not the (possibly newer) working-tree HEAD: other
// commits moving HEAD must not relabel a build that was compiled earlier.
const baked = skipBuild ? await bakedVersion(built) : undefined
const version = baked?.version ?? resolveVersion({ channel: "dev", base, sha: flag("sha") })
const sha = baked?.sha ?? shortSha(flag("sha"))
const channel = channelForVersion(version)

console.log(`banyancode dev build`)
console.log(`  version: ${version}`)
console.log(`  channel: ${channel}`)
console.log(`  target:  ${resolved}`)
console.log(`  outdir:  ${path.join(cli, outdir)}`)

if (!skipBuild) {
  // process.execPath keeps the pinned Bun (1.4.4) instead of whatever `bun`
  // resolves to on PATH.
  const build = Bun.spawn(
    [
      process.execPath,
      path.join(cli, "script", "build.ts"),
      "--single",
      "--skip-install",
      "--skip-web-ui",
      `--outdir=${outdir}`,
    ],
    {
      cwd: cli,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        OPENCODE_VERSION: version,
        OPENCODE_CHANNEL: channel,
        OPENCODE_TARGET: resolved,
        // Never let a shell-level release flag leak into a dev build.
        OPENCODE_RELEASE: "false",
      },
    },
  )
  const code = await build.exited
  if (code !== 0) {
    console.error(`build.ts exited ${code}`)
    process.exit(code)
  }
} else if (!existsSync(built)) {
  console.error(`--skip-build but no build at ${built}`)
  process.exit(2)
}

await mkdir(staging, { recursive: true })
await copyFile(built, output)
const stat = await Bun.file(output).stat()
await Bun.write(
  path.join(staging, "build.json"),
  `${JSON.stringify({ version, channel, target: resolved, sha, bytes: stat?.size ?? 0 }, null, 2)}\n`,
)

console.log(`  binary:  ${output}`)
console.log(output)

/** The version string the built binary reports (`<name> v<calver>`). */
async function bakedVersion(file: string): Promise<{ version: string; sha?: string }> {
  if (!existsSync(file)) throw new Error(`--skip-build but no build at ${file}`)
  const proc = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "pipe" })
  const text = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  await proc.exited
  const version = /\d{2}\.\d{2}\.\d+(?:-[0-9a-z.]+)?/.exec(text)?.[0]
  if (!version) throw new Error(`cannot read the version from ${file}: ${text.trim()}`)
  const sha = /-dev\.([0-9a-z]{7})/.exec(version)?.[1]
  return sha === undefined ? { version } : { version, sha }
}

/** Target suffix understood by build.ts (OPENCODE_TARGET), e.g. `windows-x64`. */
function resolvePlatformTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform
  if (os !== "windows" && os !== "darwin" && os !== "linux") throw new Error(`unsupported platform: ${process.platform}`)
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${os}-${arch}`
}
