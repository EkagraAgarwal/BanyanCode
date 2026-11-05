import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import { Effect, Stream, type Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig } from "../../src/config/index.js"
import { Storage } from "../../src/storage/index.js"

export type Hook = (event: unknown) => Effect.Effect<void, unknown>

export interface RpcCapture {
  readonly definition: { readonly id: string }
  readonly handlers: Readonly<Record<string, (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>>>
}

export interface HarnessOptions {
  readonly providers?: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly usage?: (input?: {
    readonly force?: boolean
    readonly providerID?: string
  }) => Effect.Effect<{ readonly snapshots: ReadonlyArray<unknown> }, unknown>
  /** The agent's permission rules, as the host resolves them for a request. */
  readonly permissions?: Permission.Ruleset
}

export interface Harness {
  readonly ctx: Context
  readonly tool: Map<string, Hook>
  readonly permission: Map<string, Hook>
  readonly session: Map<string, Hook>
  readonly rpcs: RpcCapture[]
  setMessages(messages: readonly unknown[]): void
  setProviderUsage(usage: HarnessOptions["usage"]): void
}

export const makeContext = (directory: string, options: HarnessOptions = {}): Harness => {
  const tool = new Map<string, Hook>()
  const permission = new Map<string, Hook>()
  const session = new Map<string, Hook>()
  const rpcs: RpcCapture[] = []
  let messages: readonly unknown[] = []
  let usage = options.usage

  const hook =
    (registry: Map<string, Hook>) =>
    (name: string, callback: Hook): Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never> =>
      Effect.sync(() => {
        registry.set(name, callback)
        return { dispose: Effect.void }
      })

  const ctx = {
    location: {
      directory,
      project: { directory, canonical: directory },
    },
    agent: {
      get: (input: { readonly agentID: string }) =>
        Effect.succeed({
          data: {
            id: input.agentID,
            permissions: options.permissions ?? [],
          },
        }),
    },
    tool: { hook: hook(tool) },
    permission: { hook: hook(permission) },
    session: {
      hook: hook(session),
      context: () => Effect.succeed(messages),
    },
    event: {
      subscribe: () => Stream.empty,
    },
    provider: {
      list: () => Effect.succeed({ data: options.providers ?? [] }),
      usage: (input?: { readonly force?: boolean; readonly providerID?: string }) =>
        usage === undefined ? Effect.succeed({ snapshots: [] }) : usage(input),
    },
    rpc: {
      register: (
        definition: { readonly id: string },
        handlers: Readonly<Record<string, (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>>>,
      ) =>
        Effect.sync(() => {
          rpcs.push({ definition, handlers })
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    },
  } as unknown as Context

  return {
    ctx,
    tool,
    permission,
    session,
    rpcs,
    setMessages: (next) => {
      messages = next
    },
    setProviderUsage: (next) => {
      usage = next
    },
  }
}

export const callHook = <E>(hook: Hook | undefined, event: E): Effect.Effect<void, unknown> => {
  if (hook === undefined) return Effect.die(new Error("hook was not registered"))
  return hook(event as unknown)
}

export const withTemp = async (fn: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-3e-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

export const configFor = async (
  directory: string,
  values: Record<string, unknown>,
): Promise<BanyanConfig.Interface> => {
  await Bun.write(join(directory, "banyancode.json"), JSON.stringify(values))
  return BanyanConfig.make({
    directory,
    projectRoot: directory,
    globalDir: join(directory, "global-config"),
    home: directory,
    env: {},
  })
}

export const withStorage = <A>(
  directory: string,
  fn: (storage: Storage.Interface) => Effect.Effect<A, never, Scope.Scope>,
): Effect.Effect<A, never, never> =>
  Effect.scoped(Effect.flatMap(Storage.open({ projectRoot: directory }), fn)).pipe(Effect.orDie)
