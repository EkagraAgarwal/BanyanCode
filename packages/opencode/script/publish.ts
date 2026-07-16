#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const WRAPPER_NAME = "banyancode"
const HOMEBREW_TAP_REPO = process.env.HOMEBREW_TAP_REPO ?? "EkagraAgarwal/homebrew-tap"
const HOMEBREW_FORMULA_PATH = "banyancode.rb"
const HOMEBREW_TAP_TOKEN = process.env.HOMEBREW_TAP_TOKEN
const AUR_SSH_KEY = process.env.AUR_KEY
const AUR_PACKAGE_NAME = process.env.AUR_PACKAGE_NAME ?? "banyancode-bin"
const AUR_GIT_URL = `ssh://aur@aur.archlinux.org/${AUR_PACKAGE_NAME}.git`

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

if (!Script.preview) {
  if (!AUR_SSH_KEY) {
    console.error("Skipping AUR push: AUR_KEY is not set; the package upload will fail unless you configure it.")
  }
  if (!HOMEBREW_TAP_TOKEN) {
    console.error(
      "Skipping Homebrew tap push: HOMEBREW_TAP_TOKEN is not set. Without it, the GITHUB_TOKEN scoped to the current repo can't push to a separate tap.",
    )
  }
}

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

if (!Script.preview) {
  const arm64Sha = await $`sha256sum ./dist/banyancode-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/banyancode-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/banyancode-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/banyancode-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  const binaryPkgbuild = [
    "# Maintainer: banyancode",
    "",
    "pkgname='banyancode-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='BanyanCode - multi-agent development tool with parallel subagents, cross-session memory, and a code-aware research loop.'",
    "url='https://github.com/EkagraAgarwal/BanyanCode'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('banyancode')",
    "conflicts=('banyancode')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/EkagraAgarwal/BanyanCode/releases/download/v\${pkgver}\${_subver}/banyancode-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,
    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/EkagraAgarwal/BanyanCode/releases/download/v\${pkgver}\${_subver}/banyancode-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./banyancode "${pkgdir}/usr/bin/banyancode"',
    "}",
    "",
  ].join("\n")

  let aurPushed = false
  let aurLastError: unknown
  if (!AUR_SSH_KEY) {
    console.error("AUR_KEY missing; refusing AUR push rather than retrying into a black hole.")
  } else {
    for (let i = 0; i < 5; i++) {
      try {
        await $`rm -rf ./dist/aur-banyancode-bin`
        await $`rm -f ~/.ssh/aur_banyancode`
        await Bun.file(process.env.HOME + "/.ssh/aur_banyancode").write(AUR_SSH_KEY)
        await $`chmod 600 ~/.ssh/aur_banyancode`
        await $`ssh-keyscan -H aur.archlinux.org >> ~/.ssh/known_hosts 2>/dev/null`.nothrow()
        await $`GIT_SSH_COMMAND='ssh -i ~/.ssh/aur_banyancode -o StrictHostKeyChecking=accept-new' git clone ${AUR_GIT_URL} ./dist/aur-banyancode-bin`
        await $`cd ./dist/aur-banyancode-bin && GIT_SSH_COMMAND='ssh -i ~/.ssh/aur_banyancode -o StrictHostKeyChecking=accept-new' git checkout master`
        await Bun.file(`./dist/aur-banyancode-bin/PKGBUILD`).write(binaryPkgbuild)
        await $`cd ./dist/aur-banyancode-bin && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-banyancode-bin && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-banyancode-bin && git diff --cached --quiet`.nothrow()).exitCode === 0) {
          console.log("AUR PKGBUILD unchanged; skipping push.")
          aurPushed = true
          break
        }
        await $`cd ./dist/aur-banyancode-bin && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-banyancode-bin && GIT_SSH_COMMAND='ssh -i ~/.ssh/aur_banyancode -o StrictHostKeyChecking=accept-new' git push`
        aurPushed = true
        break
      } catch (e) {
        aurLastError = e
        console.error(`AUR push attempt ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
  }

  if (!aurPushed) {
    throw new Error(
      `AUR push failed after 5 attempts: ${aurLastError instanceof Error ? aurLastError.message : String(aurLastError)}`,
    )
  }

  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by the BanyanCode release pipeline. DO NOT EDIT.",
    "class Banyancode < Formula",
    `  desc "BanyanCode - multi-agent development tool with parallel subagents, cross-session memory, and a code-aware research loop."`,
    `  homepage "https://github.com/EkagraAgarwal/BanyanCode"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/EkagraAgarwal/BanyanCode/releases/download/v${Script.version}/banyancode-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "banyancode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/EkagraAgarwal/BanyanCode/releases/download/v${Script.version}/banyancode-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "banyancode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/EkagraAgarwal/BanyanCode/releases/download/v${Script.version}/banyancode-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "banyancode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/EkagraAgarwal/BanyanCode/releases/download/v${Script.version}/banyancode-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "banyancode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = HOMEBREW_TAP_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error("HOMEBREW_TAP_TOKEN (or fallback GITHUB_TOKEN) is required to update the homebrew tap")
  }
  const tap = `https://x-access-token:${token}@github.com/${HOMEBREW_TAP_REPO}.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file(`./dist/homebrew-tap/${HOMEBREW_FORMULA_PATH}`).write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add ${HOMEBREW_FORMULA_PATH}`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
