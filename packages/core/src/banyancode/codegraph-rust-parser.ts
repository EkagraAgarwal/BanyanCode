export * as CodegraphRustParser from "./codegraph-rust-parser"

import { Context, Deferred, Effect, Layer, Ref } from "effect"
import type { ParseResult, ParsedNode, ParsedEdge } from "./langs/types"

export interface ParseInput {
  readonly content: string
  readonly fileID: string
  readonly lang: "ts" | "py"
}

export interface Interface {
  readonly parse: (input: ParseInput) => Effect.Effect<ParseResult, never, never>
  readonly close: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphRustParser") {}

interface ChildHandle {
  proc: ReturnType<typeof Bun.spawn>
  lang: "ts" | "py"
  pending: Map<string, Deferred.Deferred<ParseResult, never>>
  exited: boolean
}

interface WireNode {
  id?: string
  kind?: string
  name?: string
  signature?: string
  startLine?: number
  endLine?: number
  code?: string
}

interface WireEdge {
  id?: string
  fromNodeID?: string
  toNodeID?: string
  kind?: string
}

interface WireResponse {
  fileID?: string
  nodes?: WireNode[] | null
  edges?: WireEdge[] | null
  imports?: string[] | null
  error?: string | null
}

const EMPTY: ParseResult = { nodes: [], edges: [], imports: [] }

const toParsedNode = (n: WireNode): ParsedNode | null => {
  if (!n.id || !n.kind || !n.name || typeof n.startLine !== "number" || typeof n.endLine !== "number") return null
  return {
    id: n.id,
    kind: n.kind as ParsedNode["kind"],
    name: n.name,
    signature: n.signature,
    startLine: n.startLine,
    endLine: n.endLine,
    code: n.code,
  }
}

const toParsedEdge = (e: WireEdge): ParsedEdge | null => {
  if (!e.id || !e.fromNodeID || !e.toNodeID || !e.kind) return null
  return {
    id: e.id,
    fromNodeID: e.fromNodeID,
    toNodeID: e.toNodeID,
    kind: e.kind as ParsedEdge["kind"],
  }
}

const attachReader = (handle: ChildHandle): void => {
  const stdout = handle.proc.stdout as ReadableStream<Uint8Array>
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (): Promise<void> =>
    reader.read().then((res) => {
      if (res.done) {
        handle.exited = true
        for (const [, def] of handle.pending) Effect.runFork(Deferred.succeed(def, EMPTY))
        handle.pending.clear()
        return
      }
      buffer += decoder.decode(res.value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        let parsed: WireResponse | null = null
        try {
          parsed = JSON.parse(line) as WireResponse
        } catch {
          continue
        }
        const id = parsed.fileID
        if (!id) continue
        const def = handle.pending.get(id)
        if (!def) continue
        handle.pending.delete(id)
        if (parsed.error) {
          Effect.runFork(Deferred.succeed(def, EMPTY))
          continue
        }
        const nodes = (parsed.nodes ?? []).map(toParsedNode).filter((n): n is ParsedNode => n !== null)
        const edges = (parsed.edges ?? []).map(toParsedEdge).filter((e): e is ParsedEdge => e !== null)
        const imports = parsed.imports ?? []
        Effect.runFork(Deferred.succeed(def, { nodes, edges, imports }))
      }
      return pump()
    })
  void pump()
}

export const make = (binaryPath: string): Layer.Layer<Service, never, never> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const handles = yield* Ref.make<Map<"ts" | "py", ChildHandle>>(new Map())

      const getOrSpawn = Effect.fn("CodegraphRustParser.getOrSpawn")(function* (lang: "ts" | "py") {
        const map = yield* Ref.get(handles)
        const existing = map.get(lang)
        if (existing && !existing.exited) return existing
        if (existing && existing.exited) {
          try {
            existing.proc.kill()
          } catch {}
        }
        const proc = Bun.spawn([binaryPath, "parse-batch", "--lang", lang], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        })
        const handle: ChildHandle = { proc, lang, pending: new Map(), exited: false }
        attachReader(handle)
        proc.exited.then(() => {
          handle.exited = true
          for (const [, def] of handle.pending) Effect.runFork(Deferred.succeed(def, EMPTY))
          handle.pending.clear()
        })
        const next = new Map(map)
        next.set(lang, handle)
        yield* Ref.set(handles, next)
        return handle
      })

      const parse = Effect.fn("CodegraphRustParser.parse")(function* (input: ParseInput) {
        const handle = yield* getOrSpawn(input.lang)
        const deferred = yield* Deferred.make<ParseResult, never>()
        handle.pending.set(input.fileID, deferred)
        const stdin = handle.proc.stdin as ReturnType<typeof Bun.spawn>["stdin"] & { write: (s: string) => void }
        const req = JSON.stringify({ op: "parse", fileID: input.fileID, lang: input.lang, content: input.content })
        try {
          stdin.write(req + "\n")
        } catch {
          handle.pending.delete(input.fileID)
          return EMPTY
        }
        return yield* Deferred.await(deferred)
      })

      const close = Effect.fn("CodegraphRustParser.close")(function* () {
        const map = yield* Ref.get(handles)
        for (const [, h] of map) {
          try {
            ;(h.proc.stdin as { end?: () => void } | null)?.end?.()
          } catch {}
          try {
            h.proc.kill()
          } catch {}
        }
        yield* Ref.set(handles, new Map())
      })

      return Service.of({ parse, close })
    }),
  )

export const layerFor = (binaryPath: string): Layer.Layer<Service, never, never> => make(binaryPath)