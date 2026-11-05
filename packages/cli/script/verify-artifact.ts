import { stat } from "node:fs/promises"
import path from "node:path"
import { collectFiles } from "./files"
import { nativeIndexerRunnable, sidecarFileName, verifyNativeIndexer, type CliTarget } from "./native-indexer"

const forbidden = [
  "@napi-rs/canvas",
  "@fontsource/commit-mono",
  "@fontsource/noto-sans",
  "SimulationPng",
  "frontend/png",
  "Failed to register screenshot font",
  "commit-mono-latin-400-normal",
  "noto-sans-symbols-symbols-400-normal",
  "noto-sans-math-math-400-normal",
  "CommitMono-400-Regular.otf",
  "NotoSansSymbols.ttf",
  "src/frontend/png.ts",
  "skia.darwin-",
  "skia.linux-",
  "skia.win32-",
]
const overlap = Math.max(...forbidden.map((value) => value.length)) - 1

export interface VerifyArtifactOptions {
  /** The CLI target this artifact was built for, so the sidecar name matches. */
  readonly item?: CliTarget
  /**
   * `required` fails when the sidecar is missing (release builds);
   * `optional` only checks it when present (`--single` dev builds without
   * cargo still produce a working binary that falls back to TypeScript).
   */
  readonly nativeIndexer?: "required" | "optional"
}

export async function verifyArtifact(target: string, options: VerifyArtifactOptions = {}) {
  const files = await artifactFiles(target)
  if (files.length === 0) throw new Error(`Artifact contains no published files: ${target}`)
  for (const file of files) await scan(file)
  if (options.item && options.nativeIndexer) await verifySidecar(target, options.item, options.nativeIndexer)
}

/**
 * Every platform package must carry `banyan-indexer` beside the executable and
 * it must answer `--version`. A cross-compiled sidecar cannot run on the build
 * host, so only existence and a non-empty file are checked for those targets.
 */
async function verifySidecar(target: string, item: CliTarget, mode: "required" | "optional") {
  const directory = (await stat(target)).isFile() ? path.dirname(target) : target
  const file = path.join(directory, "bin", sidecarFileName(item))
  const present = await Bun.file(file).exists()
  if (!present && mode === "optional") {
    console.warn(`[native-indexer] ${target} has no sidecar; the shipped binary falls back to the TypeScript parser`)
    return
  }
  if (!present) {
    throw new Error(
      `Artifact ${target} is missing its native indexer sidecar at ${file}. Release builds must ship banyan-indexer for every target.`,
    )
  }
  await verifyNativeIndexer(file, nativeIndexerRunnable(item))
}

export function verifySimulationGraph(inputs: Iterable<string>) {
  const modules = Array.from(inputs, (input) => input.replaceAll("\\", "/"))
  const required = [
    "/packages/simulation/src/frontend/simulation.ts",
    "/packages/simulation/src/frontend/server.ts",
    "/packages/simulation/src/control-server.ts",
  ]
  const missing = required.filter((input) => !modules.some((module) => module.endsWith(input)))
  if (missing.length > 0) throw new Error(`Build graph is missing simulation bridge inputs: ${missing.join(", ")}`)
  const leaked = modules.find((module) => module.includes("/packages/simulation/src/frontend/png."))
  if (leaked) throw new Error(`Build graph contains Drive-only rendering input: ${leaked}`)
}

async function artifactFiles(target: string): Promise<string[]> {
  if ((await stat(target)).isFile()) return [target]
  return (await collectFiles(target)).map((file) => path.join(target, file))
}

async function scan(file: string) {
  let trailing = ""
  const reader = Bun.file(file).stream().getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    const text = trailing + Buffer.from(chunk.value).toString("latin1")
    const leaked = forbidden.find((marker) => text.includes(marker))
    if (leaked) throw new Error(`Artifact file ${file} contains forbidden simulation payload: ${leaked}`)
    trailing = text.slice(-overlap)
  }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("Usage: bun run script/verify-artifact.ts <file-or-directory>")
  await verifyArtifact(target)
}
