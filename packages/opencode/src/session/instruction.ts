import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

// R8 per-step caches. `system()` / `systemPaths()` run on every loop step; without
// caching each step re-runs glob/find discovery, re-reads every AGENTS.md / CLAUDE.md,
// and HTTP-fetches every remote instruction URL (5 s timeout each).
//
// Staleness windows:
// - Local discovery + file bodies: INSTRUCTION_DISCOVERY_TTL_MS (5 s). A new, deleted,
//   or edited instruction file is picked up after at most 5 s. Changes to the
//   `config.instructions` list change the cache key and invalidate immediately.
// - Remote URL bodies: REMOTE_INSTRUCTION_TTL_MS (60 s) on success. Failures
//   (timeout / network error) are cached as empty for REMOTE_INSTRUCTION_NEGATIVE_TTL_MS
//   (10 s) so a down host stalls at most one step per 10 s without hiding recovery.
//   Failures are never stored with the success TTL.
// - All caches live in InstanceState: per project directory, dropped on instance dispose.
//   `invalidate()` drops them immediately and is the hook point for a future
//   config/watcher subscription (no cheap event plumbing exists today, hence the TTLs).
export const INSTRUCTION_DISCOVERY_TTL_MS = 5_000
export const REMOTE_INSTRUCTION_TTL_MS = 60_000
export const REMOTE_INSTRUCTION_NEGATIVE_TTL_MS = 10_000

export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxSize = 64,
  ) {}
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }
  set(key: K, value: V, ttlMs: number): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
  }
  delete(key: K): void {
    this.entries.delete(key)
  }
  clear(): void {
    this.entries.clear()
  }
  get size(): number {
    return this.entries.size
  }
}

export interface RemoteInstructionCache {
  readonly get: (url: string) => string | undefined
  readonly setSuccess: (url: string, body: string) => void
  readonly setFailure: (url: string) => void
  readonly clear: () => void
}

export function createRemoteInstructionCache(now: () => number = Date.now): RemoteInstructionCache {
  const cache = new TtlCache<string, string>(now)
  return {
    get: (url) => cache.get(url),
    setSuccess: (url, body) => cache.set(url, body, REMOTE_INSTRUCTION_TTL_MS),
    setFailure: (url) => cache.set(url, "", REMOTE_INSTRUCTION_NEGATIVE_TTL_MS),
    clear: () => cache.clear(),
  }
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly invalidate: () => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // R8 caches: discovery keyed by the resolved instructions list (config edits
          // invalidate immediately, fs changes within the TTL); system output keyed the
          // same way; remote bodies keyed by URL with success/negative TTLs.
          discovery: new TtlCache<string, Set<string>>(),
          system: new TtlCache<string, string[]>(),
          remote: createRemoteInstructionCache(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const s = yield* InstanceState.get(state)
      const cached = s.remote.get(url)
      if (cached !== undefined) return cached
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) {
        s.remote.setFailure(url)
        return ""
      }
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      const text = new TextDecoder().decode(body)
      s.remote.setSuccess(url, text)
      return text
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const invalidate = Effect.fn("Instruction.invalidate")(function* () {
      const s = yield* InstanceState.get(state)
      s.discovery.clear()
      s.system.clear()
      s.remote.clear()
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const key = JSON.stringify(config.instructions ?? [])
      const s = yield* InstanceState.get(state)
      const cached = s.discovery.get(key)
      if (cached) return new Set(cached)
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      s.discovery.set(key, paths, INSTRUCTION_DISCOVERY_TTL_MS)
      return new Set(paths)
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const key = JSON.stringify(config.instructions ?? [])
      const s = yield* InstanceState.get(state)
      const cached = s.system.get(key)
      if (cached) return [...cached]
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      const result = [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
      s.system.set(key, result, INSTRUCTION_DISCOVERY_TTL_MS)
      return result
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, invalidate, systemPaths, system, find, resolve })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make(layer, [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient])

export * as Instruction from "./instruction"
