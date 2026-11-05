/**
 * Client for the `banyan-indexer` native sidecar.
 *
 * The sidecar owns read + hash + parse for a list of files and speaks NDJSON
 * over stdin/stdout. It never touches SQLite: this module hands each decoded
 * file result to a callback that writes through the existing repository
 * methods, so the schema keeps exactly one owner.
 *
 * Everything here is best-effort. Any failure — missing binary, spawn error,
 * protocol mismatch, a crash mid-stream, a malformed line — surfaces as a typed
 * failure so `codegraph-indexer.ts` can finish the build on the TypeScript
 * parser. A malformed line never aborts the build.
 *
 * Back-pressure: the callback is awaited before the next line is read. The
 * callback offers into the bounded parse queue, so a slow SQLite writer stops
 * the reader, which lets the OS pipe fill, which blocks the child's write. No
 * unbounded queue exists anywhere in this path.
 */
import { Effect } from "effect"
import path from "node:path"
import type { ParsedEdge, ParsedNode } from "./types.js"

/** Must match `PROTOCOL_VERSION` in `native/src/protocol.rs`. */
export const NATIVE_PROTOCOL_VERSION = 1

export interface NativeNode {
  id: string
  kind: ParsedNode["kind"]
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
}

// `yield` and `service_access` are real parser edge kinds that the
// `ParsedEdge` union never declared; the TypeScript parser casts them in, so
// the wire type names them explicitly and the caller casts back.
export interface NativeEdge {
  id: string
  fromNodeID: string
  toNodeID: string
  kind: ParsedEdge["kind"] | "yield" | "service_access"
  source?: "regex" | "tree-sitter"
}

export interface NativeFileResult {
  path: string
  relativePath: string
  fileID: string
  status: "indexed" | "skipped"
  skipReason?:
    | "cached"
    | "artifact"
    | "minified"
    | "tooLargeParse"
    | "readError"
    | "gitignored"
    | "banyanignored"
    | "tooLarge"
  hash: string
  language: string
  sizeBytes: number
  mtimeMs: number
  lineCount: number
  /** First 4000 characters of the file, for the indexer-owned file node. */
  fileCode: string
  /** `classifyFileKind` result; the indexer adds the artifact node. */
  fileKind?: ParsedNode["kind"]
  nodes: NativeNode[]
  edges: NativeEdge[]
  parseError?: { message: string }
  backend: "tree-sitter" | "regex"
  timings: { readMs: number; hashMs: number; parseMs: number }
}

export interface NativeSkipCounts {
  gitignored: number
  banyanignored: number
  artifact: number
  tooLarge: number
  minified: number
  tooLargeParse: number
  cached: number
  readError: number
  parseFailure: number
}

export interface NativeSummary {
  mode: string
  version: string
  files: number
  indexed: number
  skipped: number
  parseErrors: number
  skippedByReason: NativeSkipCounts
  timings: { walkMs: number; readMs: number; hashMs: number; parseMs: number; totalMs: number }
  workers: number
}

export interface NativeRequestFile {
  path: string
  fileID: string
  sizeBytes: number
  mtimeMs: number
  knownHash?: string
  knownSizeBytes?: number
  knownMtimeMs?: number
}

export interface NativeRequest {
  root: string
  mode: "files" | "full"
  files: NativeRequestFile[]
  force: boolean
  maxFileSizeBytes: number
  excludePatterns?: readonly string[]
}

export class NativeUnavailableError extends Error {
  readonly _tag = "NativeUnavailableError" as const
  constructor(message: string) {
    super(message)
  }
}

const binaryName = process.platform === "win32" ? "banyan-indexer.exe" : "banyan-indexer"

/**
 * Candidate locations: an explicit `BANYANCODE_NATIVE_INDEXER_PATH` is
 * authoritative (a set-but-missing override means "no sidecar", so a mistyped
 * path is a loud fallback rather than a silent one), then beside the executable
 * (single-file build), then the installed platform package's `bin/` directory,
 * then the local cargo output (development builds).
 */
export const nativeIndexerCandidates = (): string[] => {
  const explicit = process.env.BANYANCODE_NATIVE_INDEXER_PATH
  if (explicit) return [explicit]
  const execDir = path.dirname(process.execPath)
  const here = import.meta.dir
  return [
    path.join(execDir, binaryName),
    path.join(execDir, "..", "bin", binaryName),
    path.join(here, "..", "..", "..", "native", "target", "release", binaryName),
    path.join(here, "..", "..", "..", "native", "target", "debug", binaryName),
  ]
}

/**
 * `BANYANCODE_NATIVE_INDEXER=off` forces the TypeScript parser. Any other value
 * (or unset) allows the sidecar.
 */
export const nativeIndexerEnabled = (): boolean => process.env.BANYANCODE_NATIVE_INDEXER !== "off"

export const resolveNativeIndexerPath = async (): Promise<string | undefined> => {
  if (!nativeIndexerEnabled()) return undefined
  for (const candidate of nativeIndexerCandidates()) {
    const file = Bun.file(candidate)
    if (await file.exists()) return candidate
  }
  return undefined
}

const decodeLine = (line: string): unknown => JSON.parse(line)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface RunNativeOptions {
  readonly request: NativeRequest
  /** Awaited before the next line is read; this is the back-pressure point. */
  readonly onFile: (result: NativeFileResult) => Effect.Effect<void>
  /** Consulted once per line so a cancel kills the child promptly. */
  readonly isCancelled?: Effect.Effect<boolean>
  readonly executable?: string
}

export interface RunNativeResult {
  readonly summary: NativeSummary
  readonly backend: "native"
}

/**
 * Spawn the sidecar, stream every file result through `onFile`, and return the
 * summary line. The child is always killed before this effect settles.
 */
export const runNativeIndex = (
  options: RunNativeOptions,
): Effect.Effect<RunNativeResult, NativeUnavailableError, never> =>
  Effect.gen(function* () {
    const executable = options.executable ?? (yield* Effect.promise(() => resolveNativeIndexerPath()))
    if (!executable) {
      return yield* Effect.fail(new NativeUnavailableError("banyan-indexer binary not found"))
    }

    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          Bun.spawn({
            cmd: [executable],
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, BANYANCODE_NATIVE_INDEXER: "child" },
          }),
        catch: (cause) => new NativeUnavailableError(`failed to spawn ${executable}: ${String(cause)}`),
      }),
      (child) =>
        Effect.gen(function* () {
          const payload = JSON.stringify({
            type: "request",
            protocol: NATIVE_PROTOCOL_VERSION,
            root: options.request.root,
            mode: options.request.mode,
            files: options.request.files,
            force: options.request.force,
            maxFileSizeBytes: options.request.maxFileSizeBytes,
            excludePatterns: options.request.excludePatterns ?? [],
          })
          const writer = child.stdin as import("bun").FileSink
          writer.write(payload)
          writer.write("\n")
          yield* Effect.promise(async () => {
            await writer.flush()
          })
          // The request is the only thing the child reads from stdin; closing
          // it keeps a wedged child from holding the pipe open forever.
          yield* Effect.sync(() => writer.end())

          const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
          const decoder = new TextDecoder()
          let buffered = ""
          let hello: { protocol?: number; version?: string } | undefined
          let summary: NativeSummary | undefined

          const fail = (message: string) => new NativeUnavailableError(message)

          while (true) {
            if (options.isCancelled !== undefined && (yield* options.isCancelled)) {
              return yield* Effect.fail(fail("cancelled"))
            }
            const chunk = yield* Effect.promise(() => reader.read())
            if (chunk.done) break
            buffered += decoder.decode(chunk.value, { stream: true })
            let newline = buffered.indexOf("\n")
            while (newline !== -1) {
              const line = buffered.slice(0, newline).trim()
              buffered = buffered.slice(newline + 1)
              newline = buffered.indexOf("\n")
              if (line.length === 0) continue

              let decoded: unknown
              try {
                decoded = decodeLine(line)
              } catch {
                // A malformed line is a hard fallback, but it must not kill the
                // build: the caller finishes on the TypeScript parser.
                return yield* Effect.fail(fail(`malformed NDJSON line: ${line.slice(0, 200)}`))
              }
              if (!isRecord(decoded) || typeof decoded.type !== "string") {
                return yield* Effect.fail(fail(`NDJSON line missing a type discriminator: ${line.slice(0, 200)}`))
              }
              if (decoded.type === "hello") {
                hello = decoded as { protocol?: number; version?: string }
                if (hello.protocol !== NATIVE_PROTOCOL_VERSION) {
                  return yield* Effect.fail(
                    fail(
                      `protocol mismatch: sidecar speaks ${String(hello.protocol)}, expected ${NATIVE_PROTOCOL_VERSION}`,
                    ),
                  )
                }
                continue
              }
              if (decoded.type === "error") {
                return yield* Effect.fail(fail(String(decoded.message ?? "sidecar error")))
              }
              if (decoded.type === "summary") {
                summary = decoded as unknown as NativeSummary
                continue
              }
              if (decoded.type !== "file") {
                return yield* Effect.fail(fail(`unknown NDJSON record type: ${decoded.type}`))
              }
              yield* options.onFile(decoded as unknown as NativeFileResult)
            }
          }

          if (hello === undefined) return yield* Effect.fail(fail("sidecar exited before the hello line"))
          if (summary === undefined) return yield* Effect.fail(fail("sidecar exited before the summary line"))
          return { summary, backend: "native" as const }
        }),
      (child) =>
        Effect.sync(() => {
          try {
            child.kill()
          } catch {
            // Already gone; killing a reaped child is a no-op we must not throw on.
          }
        }),
    )
  })

/** `banyan-indexer --version`, used by packaging verification. */
export const nativeIndexerVersion = async (executable: string): Promise<string | undefined> => {
  try {
    const child = Bun.spawn({ cmd: [executable, "--version"], stdout: "pipe", stderr: "ignore" })
    const text = await new Response(child.stdout as ReadableStream<Uint8Array>).text()
    const code = await Promise.resolve<number>(child.exited as number | Promise<number>)
    if (code !== 0) return undefined
    return text.trim()
  } catch {
    return undefined
  }
}
