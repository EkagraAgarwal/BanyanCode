#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

if (!process.env.BUN_INSTALL_CACHE_DIR) {
  process.env.BUN_INSTALL_CACHE_DIR = path.join(dir, ".bun-cache")
}

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const BINARY_NAME = "banyancode"

const allFlag = process.argv.includes("--all")
const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS || Script.release)
const singleFlag = process.argv.includes("--single") || (!allFlag && !isCI)
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

// libsql native binding: the libsql package uses a dynamic
// `require(\`@libsql/${target}\`)` to load the platform-specific N-API
// addon. Bun's compile mode cannot resolve such transitive dynamic requires
// from its embedded virtual filesystem, so the lookup always fails. The
// build plugin below rewrites that call into a static require for the
// build's target; the bundler then follows the require, reads the .node
// file via the napi loader, and embeds the addon in the binary.
const libsqlTargetFor = (compileTarget: string): string | null => {
  const map: Record<string, string> = {
    "bun-linux-x64": "@libsql/linux-x64-gnu",
    "bun-linux-x64-baseline": "@libsql/linux-x64-gnu",
    "bun-linux-x64-modern": "@libsql/linux-x64-gnu",
    "bun-linux-arm64": "@libsql/linux-arm64-gnu",
    "bun-linux-x64-musl": "@libsql/linux-x64-musl",
    "bun-linux-x64-baseline-musl": "@libsql/linux-x64-musl",
    "bun-linux-arm64-musl": "@libsql/linux-arm64-musl",
    "bun-darwin-x64": "@libsql/darwin-x64",
    "bun-darwin-x64-baseline": "@libsql/darwin-x64",
    "bun-darwin-arm64": "@libsql/darwin-arm64",
    "bun-windows-x64": "@libsql/win32-x64-msvc",
    "bun-windows-x64-baseline": "@libsql/win32-x64-msvc",
    "bun-windows-x64-modern": "@libsql/win32-x64-msvc",
  }
  return map[compileTarget] ?? null
}

type LibsqlPlugin = {
  name: string
  setup(build: {
    onLoad: (
      opts: { filter: RegExp },
      cb: (args: { path: string }) => Promise<{ contents: string; loader: string }>,
    ) => void
  }): void
}

const createLibsqlPlugin = (libsqlPkg: string): LibsqlPlugin => ({
  name: "banyancode-libsql-native",
  setup(build) {
    const needle = /function requireNative\(\) \{[\s\S]*?\n\}/
    build.onLoad({ filter: /[\\/]libsql[\\/]index\.js$/ }, async (args) => {
      const original = await Bun.file(args.path).text()
      if (!needle.test(original)) {
        throw new Error(`libsql/index.js structure changed; cannot patch requireNative`)
      }
      const replacement = `function requireNative() {\n  return require(${JSON.stringify(libsqlPkg)});\n}`
      return {
        contents: original.replace(needle, replacement),
        loader: "js",
      }
    })
  },
})

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    // win32/arm64 intentionally omitted — @libsql does not publish a
    // win32-arm64-msvc native binding, so a bundled libsql build cannot
    // ship for that target. Cross-compiling for win32/arm64 without
    // libsql would silently produce a binary that crashes on first DB use.
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    BINARY_NAME,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  const compileTarget = name.replace(BINARY_NAME, "bun")
  const libsqlTarget = libsqlTargetFor(compileTarget)
  if (!libsqlTarget) {
    throw new Error(`No libsql native binding available for compile target ${compileTarget}`)
  }

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin, createLibsqlPlugin(libsqlTarget) as any],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: compileTarget as any,
      outfile: `dist/${name}/bin/${BINARY_NAME}`,
      execArgv: [`--user-agent=${BINARY_NAME}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : [])],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/${BINARY_NAME}${item.os === "win32" ? ".exe" : ""}`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }

    // Extended smoke test: launch the TUI briefly in a clean temp directory
    // so the libsql native binding is actually loaded (the BanyanCode schema
    // init log only appears once the addon is dlopen'd). The TUI is killed
    // after a short delay; we just need to confirm startup doesn't crash
    // with `Cannot find module '@libsql/...'` or a dlopen failure.
    const smokeDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "banyancode-smoke-"))
    try {
      const proc = Bun.spawn([path.resolve(binaryPath)], {
        cwd: smokeDir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => proc.kill(), 2500)
      const stderr = await new Response(proc.stderr).text()
      clearTimeout(timer)
      await proc.exited
      const bindingLoaded = stderr.includes("turso.schema")
      if (!bindingLoaded) {
        console.error(
          `Smoke test failed: libsql native binding did not load. stderr:\n${stderr.slice(0, 500)}`,
        )
        process.exit(1)
      }
      console.log("Native binding smoke test passed (libsql loaded from embedded binary)")
    } finally {
      fs.rmSync(smokeDir, { recursive: true, force: true })
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
