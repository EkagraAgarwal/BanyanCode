#!/usr/bin/env bun
// Stage the built CLI into the npm packages BanyanCode publishes:
//
//   banyancode                        umbrella (bin shim + postinstall)
//   banyancode-<target>               one package per platform
//
//   bun script/banyancode/pack.ts [--dist <dir>] [--all] [--no-archives]
//
// Outputs (repository root, gitignored):
//   dist/npm/            packed .tgz files (umbrella last)
//   dist/archives/       per-platform archives for the GitHub release
//   packages/cli/dist/npm-staging/  the staged package directories
//
// This replaces packages/cli/script/pack.ts for BanyanCode releases; upstream's
// version packs `@opencode/*` packages, which is not what we ship. The upstream
// build stays untouched, so the only upstream-facing rename happens here.
import { $ } from "bun"
import { chmod, copyFile, mkdir, rm, utimes } from "node:fs/promises"
import path from "node:path"
import { archiveDir, npmDir } from "@opencode/script/pack"
import { BanyanVersion } from "./version"
import { BanyanPlatforms, type Platform } from "./platforms"

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(`--${name}=`.length)
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = args[index + 1]
  return next !== undefined && !next.startsWith("--") ? next : undefined
}
const all = args.includes("--all")
const archives = !args.includes("--no-archives")

const repo = path.resolve(import.meta.dir, "../..")
const cli = path.join(repo, "packages", "cli")
const dist = path.resolve(flag("dist") ?? path.join(cli, "dist"))
const staging = path.join(dist, "npm-staging")
const license = await Bun.file(path.join(repo, "LICENSE")).text()

const discovered: Platform[] = []
const missing: Platform[] = []
for (const entry of BanyanPlatforms.PLATFORMS) {
  if (await Bun.file(BanyanPlatforms.builtBinary(dist, entry)).exists()) discovered.push(entry)
  else missing.push(entry)
}

// Without --version, pack whatever the build stamped (so a local dev build can
// be packed); CI always passes the release version explicitly.
const version = flag("version") ?? (await resolveBuiltVersion())
const channel = BanyanVersion.channelForVersion(version)
console.log(`banyancode pack: version=${version} channel=${channel} dist=${dist}`)

if (all && missing.length > 0) {
  throw new Error(
    `--all requires every platform build; missing: ${missing.map((entry) => entry.target).join(", ")}. ` +
      `Run the build matrix first (OPENCODE_TARGET=<target> bun packages/cli/script/build.ts --skip-install).`,
  )
}
if (discovered.length === 0) {
  throw new Error(`no built binaries under ${dist}; run bun script/banyancode/dev-build.ts first`)
}

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await mkdir(npmDir, { recursive: true })
if (archives) await mkdir(archiveDir, { recursive: true })

const optionalDependencies: Record<string, string> = {}
for (const entry of discovered) {
  const source = BanyanPlatforms.builtBinary(dist, entry)
  // build.ts stamps its own (upstream-named) manifest and the version the build
  // was invoked with; a mismatch means stale or mixed artifacts.
  const built = (await Bun.file(path.join(BanyanPlatforms.buildDirectory(dist, entry), "package.json")).json()) as {
    version?: string
  }
  if (built.version !== version) {
    throw new Error(`${entry.target} was built as ${String(built.version)}, expected ${version}; rebuild or pass --version`)
  }

  const directory = path.join(staging, entry.npm)
  await mkdir(path.join(directory, "bin"), { recursive: true })
  const executable = BanyanPlatforms.executableName(entry.os)
  await copyFile(source, path.join(directory, "bin", executable))
  if (entry.os !== "win32") await chmod(path.join(directory, "bin", executable), 0o755)

  await Bun.write(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: entry.npm,
        description: `BanyanCode binary for ${entry.target}`,
        version,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/EkagraAgarwal/BanyanCode.git" },
        bin: { [BanyanPlatforms.UMBRELLA]: `./bin/${executable}` },
        files: ["bin"],
        os: [entry.os],
        cpu: [entry.cpu],
      },
      null,
      2,
    )}\n`,
  )
  optionalDependencies[entry.npm] = version

  if (archives && entry.shipping) {
    const output = path.join(archiveDir, `${entry.npm}.${entry.archive}`)
    await rm(output, { force: true })
    // Fixed timestamp makes retries byte-identical.
    await utimes(path.join(directory, "bin", executable), new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"))
    if (entry.archive === "tar.gz") {
      await $`tar --mtime=@0 --owner=0 --group=0 --numeric-owner -czf ${output} -C ${path.join(directory, "bin")} ${executable}`
    } else {
      await $`zip -X -q ${output} ${executable}`.cwd(path.join(directory, "bin"))
    }
    console.log(`  archive ${path.relative(repo, output)}`)
  }
  await pack(directory)
  console.log(`  package ${entry.npm}`)
}

// Umbrella last: its optionalDependencies must name exactly the staged set.
const umbrella = path.join(staging, BanyanPlatforms.UMBRELLA)
await mkdir(path.join(umbrella, "bin"), { recursive: true })
await Bun.write(
  path.join(umbrella, "bin", `${BanyanPlatforms.UMBRELLA}.exe`),
  [
    `echo "Error: ${BanyanPlatforms.UMBRELLA}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when installation scripts are disabled." >&2',
    'echo "Run the package postinstall script or reinstall with scripts enabled." >&2',
    "exit 1",
    "",
  ].join("\n"),
)
await copyFile(path.join(cli, "script", "postinstall.mjs"), path.join(umbrella, "postinstall.mjs"))
await Bun.write(path.join(umbrella, "LICENSE"), license)
await Bun.write(
  path.join(umbrella, "package.json"),
  `${JSON.stringify(
    {
      name: BanyanPlatforms.UMBRELLA,
      description: "BanyanCode — AI coding agent with a repository intelligence graph and a subagent mesh",
      version,
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/EkagraAgarwal/BanyanCode.git" },
      bin: { [BanyanPlatforms.UMBRELLA]: `./bin/${BanyanPlatforms.UMBRELLA}.exe` },
      files: ["bin", "postinstall.mjs", "LICENSE"],
      scripts: { postinstall: "node ./postinstall.mjs" },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies,
    },
    null,
    2,
  )}\n`,
)
await pack(umbrella)
console.log(`  package ${BanyanPlatforms.UMBRELLA} (${Object.keys(optionalDependencies).length} optional deps)`)

if (missing.length > 0) {
  console.warn(`warn: not built here: ${missing.map((entry) => entry.target).join(", ")} (use --all in CI)`)
}
console.log(`banyancode pack: ${Object.keys(optionalDependencies).length + 1} packages in ${path.relative(repo, npmDir)}`)

async function resolveBuiltVersion(): Promise<string> {
  const versions = new Set<string>()
  for (const entry of discovered) {
    const built = (await Bun.file(path.join(BanyanPlatforms.buildDirectory(dist, entry), "package.json")).json()) as {
      version?: string
    }
    if (typeof built.version === "string") versions.add(built.version)
  }
  if (versions.size !== 1) {
    throw new Error(`built platforms disagree on the version (${[...versions].join(", ")}); pass --version`)
  }
  return [...versions][0] ?? (await BanyanVersion.readBaseVersion())
}

async function pack(directory: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(directory)
  await $`bun pm pack --destination ${npmDir}`.cwd(directory)
}
