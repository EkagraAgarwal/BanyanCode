#!/usr/bin/env bun
// Publish the staged BanyanCode npm packages.
//
//   bun script/banyancode/publish.ts --dry-run        # pack + inspect only, no network
//   bun script/banyancode/publish.ts --channel dev    # publish to the `dev` dist-tag
//
// Semantics ported from v1 packages/opencode/script/publish.ts:
//   - every staged package version must match the resolved version
//   - `npm view <name>@<version>` short-circuits an already-published package
//   - per-platform packages publish first, the `banyancode` umbrella last
//   - the npm dist-tag is the release channel (latest | dev | next)
//
// `--dry-run` never touches the network: it runs `npm pack` for each staged
// directory and inspects the tarball (file list + manifest hygiene). CI uses it
// as a preflight gate before the real publish.
import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { BanyanVersion } from "./version"
import { BanyanPlatforms } from "./platforms"

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(`--${name}=`.length)
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = args[index + 1]
  return next !== undefined && !next.startsWith("--") ? next : undefined
}
const dryRun = args.includes("--dry-run")
const PUBLISH_CONCURRENCY = 4
const repo = path.resolve(import.meta.dir, "../..")
const dist = path.resolve(flag("dist") ?? path.join(repo, "packages", "cli", "dist"))
const staging = path.join(dist, "npm-staging")
const work = path.join(dist, "publish-check")
const baseVersion = await BanyanVersion.readBaseVersion()

const manifests: Array<{ name: string; directory: string; manifest: Record<string, unknown> }> = []
const pending: Array<(typeof BanyanPlatforms.PLATFORMS)[number]> = []
for (const entry of BanyanPlatforms.PLATFORMS) {
  const directory = path.join(staging, entry.npm)
  if (await Bun.file(path.join(directory, "package.json")).exists()) pending.push(entry)
}
for (const entry of pending) {
  manifests.push(await readManifest(path.join(staging, entry.npm)))
}
const umbrella = await readManifest(path.join(staging, BanyanPlatforms.UMBRELLA))
manifests.push(umbrella)

if (manifests.length === 0) throw new Error(`no staged packages under ${staging}; run bun script/banyancode/pack.ts first`)
const versions = new Set(manifests.map((entry) => String(entry.manifest.version)))
if (versions.size > 1) {
  throw new Error(`staged package versions differ: ${JSON.stringify(Object.fromEntries(manifests.map((entry) => [entry.name, entry.manifest.version])))}`)
}
const staged = String(manifests[0]!.manifest.version)
const version = flag("version") ?? staged
if (version !== staged) throw new Error(`staged packages are ${staged}, expected ${version}; re-run pack.ts with the same version`)
const channel = (flag("channel") as BanyanVersion.Channel | undefined) ?? BanyanVersion.channelForVersion(version)
if (!["latest", "dev", "next"].includes(channel)) throw new Error(`unknown channel: ${channel}`)
const base = version.replace(/-.*$/, "")
if (BanyanVersion.isCalVer(base) && BanyanVersion.compareCalVer(base, BanyanVersion.V1_LAST_VERSION) <= 0) {
  throw new Error(`version ${version} does not continue after the last v1 release ${BanyanVersion.V1_LAST_VERSION}`)
}
// A stable (latest) publish must be the version.json CalVer; a dev canary is
// the same base with the -dev.<sha> suffix.
if (channel === "latest" && base !== baseVersion) {
  throw new Error(`stable publish ${version} does not match ${BanyanVersion.VERSION_FILE} (${baseVersion})`)
}
const optional = (umbrella.manifest.optionalDependencies ?? {}) as Record<string, string>
const stagedPlatforms = pending.map((entry) => entry.npm)
const unexpected = Object.keys(optional).filter((name) => !stagedPlatforms.includes(name))
if (unexpected.length > 0) {
  throw new Error(`umbrella optionalDependencies name packages that were not staged: ${unexpected.join(", ")}`)
}
// A real publish must cover every platform; a local dry run may inspect a
// single-platform build (`--require-all` restores the strict check).
if ((!dryRun || args.includes("--require-all")) && pending.length < BanyanPlatforms.PLATFORMS.length) {
  const missing = BanyanPlatforms.PLATFORMS.filter((entry) => !pending.some((stagedEntry) => stagedEntry.npm === entry.npm))
  throw new Error(
    `staged ${pending.length}/${BanyanPlatforms.PLATFORMS.length} platforms; missing: ${missing.map((entry) => entry.target).join(", ")}`,
  )
}
if (dryRun && pending.length < BanyanPlatforms.PLATFORMS.length) {
  console.warn(`warn: dry run covers ${pending.length}/${BanyanPlatforms.PLATFORMS.length} platforms (pass --require-all in CI)`)
}

console.log(`banyancode publish${dryRun ? " (dry run)" : ""}`)
console.log(`  version: ${version}`)
console.log(`  channel: ${channel}`)
console.log(`  packages: ${manifests.length}`)

await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

const rows: Array<{ name: string; version: string; files: number; bytes: number; tag: string }> = []
// Each platform package is ~100 MB, so packing and uploading them one at a time took
// most of the publish job. They are independent; only the umbrella has to wait,
// because it must never point at a platform package that failed to publish.
const platforms = manifests.filter((entry) => entry !== umbrella)
const queue = [...platforms]
const outcomes = await Promise.allSettled(
  Array.from({ length: Math.min(PUBLISH_CONCURRENCY, queue.length) }, async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) await release(entry)
  }),
)
const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  throw new Error(`${failures.length} platform package(s) failed; the umbrella was not published. Re-run to fill the gaps.`)
}
await release(umbrella)

async function release(entry: (typeof manifests)[number]) {
  // pack() finds its tarball by listing the destination, so parallel packs each get their own.
  const destination = path.join(work, entry.name)
  await mkdir(destination, { recursive: true })
  const archive = await pack(entry.directory, destination)
  const files = await listTarball(archive)
  if (files.length === 0) throw new Error(`${entry.name}: npm pack produced an empty tarball`)
  const leaked = files.filter((file) => file.includes("node_modules/") || file.endsWith(".map"))
  if (leaked.length > 0) throw new Error(`${entry.name}: tarball contains ${leaked.slice(0, 3).join(", ")}`)
  if (!files.includes("package/package.json")) throw new Error(`${entry.name}: tarball has no package/package.json`)
  const binary = (entry.manifest.bin as Record<string, string> | undefined)?.[BanyanPlatforms.UMBRELLA]
  if (binary === undefined) throw new Error(`${entry.name}: manifest has no ${BanyanPlatforms.UMBRELLA} bin`)
  if (!files.includes(`package/${binary.replace(/^\.\//, "")}`)) {
    throw new Error(`${entry.name}: tarball is missing the ${binary} binary`)
  }
  const bytes = (await Bun.file(archive).stat())?.size ?? 0
  rows.push({ name: entry.name, version: String(entry.manifest.version), files: files.length, bytes, tag: channel })
  if (dryRun) {
    console.log(`  ok ${entry.name}@${entry.manifest.version} (${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    return
  }
  await publish(entry, archive)
}

if (dryRun) {
  console.log("")
  console.log("dry run complete: no package was published")
  for (const row of rows) {
    console.log(`  ${row.name}@${row.version}  dist-tag=${row.tag}  files=${row.files}  size=${(row.bytes / 1024).toFixed(0)} KiB`)
  }
  await rm(work, { recursive: true, force: true })
  process.exit(0)
}

console.log(`\nnpm publish complete for ${BanyanPlatforms.UMBRELLA}@${version} (dist-tag ${channel}).`)
console.log(
  "AUR and Homebrew tap pushes are intentionally not run from this script. " +
    "Publish platforms first, then the umbrella (as above).",
)

async function readManifest(directory: string) {
  const file = path.join(directory, "package.json")
  if (!(await Bun.file(file).exists())) {
    throw new Error(`missing staged manifest ${file}; run bun script/banyancode/pack.ts first`)
  }
  const text = await Bun.file(file).text()
  // npm cannot resolve Bun workspace protocols; the umbrella must be a plain
  // manifest with only optionalDependencies.
  for (const marker of ["catalog:", "workspace:"]) {
    if (text.includes(marker)) throw new Error(`${file} contains a "${marker}" reference; the umbrella must be self-contained`)
  }
  const manifest = JSON.parse(text) as Record<string, unknown>
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${file} must declare name and version`)
  }
  return { name: manifest.name, directory, manifest }
}

async function pack(directory: string, destination: string): Promise<string> {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(directory)
  const before = new Set(await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: destination })))
  await $`bun pm pack --destination ${destination}`.cwd(directory)
  const after = await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: destination }))
  const created = after.filter((file) => !before.has(file))
  if (created.length !== 1) throw new Error(`bun pm pack in ${directory} produced ${created.length} tarballs`)
  return path.join(destination, created[0]!)
}

async function listTarball(archive: string): Promise<string[]> {
  // Run from the archive's directory with a bare filename: GNU tar reads the
  // colon in `D:/...` as an rsh host. Windows bsdtar needs --force-local when
  // a drive letter does reach it.
  const directory = path.dirname(archive)
  const file = path.basename(archive)
  const result =
    process.platform === "win32"
      ? await $`tar --force-local -tzf ${file}`.cwd(directory).nothrow().quiet()
      : await $`tar -tzf ${file}`.cwd(directory).nothrow().quiet()
  if (result.exitCode !== 0) throw new Error(`tar -tzf ${file} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().split(/\r?\n/).filter(Boolean)
}

async function published(name: string, packageVersion: string): Promise<boolean> {
  return (await $`npm view ${name}@${packageVersion} version`.nothrow().quiet()).exitCode === 0
}

async function publish(entry: { name: string; directory: string }, archive: string): Promise<void> {
  if (await published(entry.name, version)) {
    console.log(`  already published ${entry.name}@${version}`)
    return
  }
  await $`npm publish ${archive} --access public --tag ${channel}`.cwd(work)
  console.log(`  published ${entry.name}@${version} (${channel})`)
}
