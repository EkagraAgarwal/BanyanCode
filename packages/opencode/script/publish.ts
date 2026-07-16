#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const WRAPPER_NAME = "banyancode"

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const nested = await Bun.file(`./dist/${filepath}`).json()
  binaries[nested.name] = nested.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${WRAPPER_NAME}`
await $`mkdir -p ./dist/${WRAPPER_NAME}/bin`
await $`cp ./script/postinstall.mjs ./dist/${WRAPPER_NAME}/postinstall.mjs`
await Bun.file(`./dist/${WRAPPER_NAME}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${WRAPPER_NAME}/bin/${WRAPPER_NAME}.exe`).write(
  [
    `echo "Error: ${WRAPPER_NAME}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${WRAPPER_NAME} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${WRAPPER_NAME} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${WRAPPER_NAME}/package.json`).write(
  JSON.stringify(
    {
      name: WRAPPER_NAME,
      bin: {
        [WRAPPER_NAME]: `./bin/${WRAPPER_NAME}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  await publish(`./dist/${name}`, name, binaries[name])
})
await Promise.all(tasks)
await publish(`./dist/${WRAPPER_NAME}`, WRAPPER_NAME, version)

console.log(
  `\nnpm publish complete for ${WRAPPER_NAME}@${version}.\n` +
    "AUR (Arch Linux) and Homebrew tap pushes are intentionally not run from this script. " +
    "Manage those out-of-band if/when you publish there.",
)
