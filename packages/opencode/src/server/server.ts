import "./init-projectors"

import { NodeHttpServer } from "@effect/platform-node"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { createServer } from "node:http"
import net from "node:net"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "./cors"
import { lazy } from "@/util/lazy"
import { InstanceStore } from "@/project/instance-store"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

export type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  // Ephemeral listeners (e.g. MCP in-process servers) must never claim the
  // well-known 4096 port: bind the OS-assigned free port directly instead
  // of preferring 4096 first. `banyancode serve` keeps the default behavior.
  ephemeral?: boolean
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@opencode/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL

export async function listen(opts: ListenOptions): Promise<Listener> {
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => Effect.runPromiseExit(listener.stop(close)).then(() => undefined),
  }
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    const state = yield* startWithPortFallback(opts)
    const address = yield* tcpAddress(state)
    const listenerUrl = makeURL(opts.hostname, address.port)
    url = listenerUrl

    const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)

    return {
      hostname: opts.hostname,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state, unpublishMdns),
    }
  },
)

function listenerLayer(opts: ListenOptions, port: number) {
  return HttpRouter.serve(HttpApiApp.createRoutes(opts), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    // The tracker holds per-listener socket state with a latching `closing`
    // flag: sharing it across listeners via the global memoMap below would let
    // one listener's stop(true) poison every later listener's sockets, so it
    // is always built fresh. The port-bound serverLayer is already per-call
    // objects (never memoized); everything else dedupes via the shared map.
    Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  return Effect.gen(function* () {
    // Explicit ports and ephemeral listeners bind exactly once — no fallback,
    // matching the legacy behavior.
    if (opts.port !== 0) return yield* startListener(opts, opts.port)
    // Ephemeral listeners skip the 4096 preference entirely so an MCP child
    // process started before the TUI can never steal the well-known port.
    if (opts.ephemeral) return yield* startListener(opts, 0)
    // Match the legacy listener port-resolution behavior: explicit `0` prefers
    // 4096 first, then any free port. Probe BEFORE building layers so the
    // service graph builds exactly once; the old code built the whole graph
    // per attempt. A one-shot retry remains for the TOCTOU race between probe
    // and bind — safe with the shared memoMap, whose ref-counted entries from
    // the failed build are evicted when that attempt's scope closes.
    const port = yield* probePreferredPort(opts.hostname)
    if (port === 0) return yield* startListener(opts, 0)
    return yield* startListener(opts, port).pipe(Effect.catch(() => startListener(opts, 0)))
  })
}

// Probe 4096 with a throwaway socket. Only EADDRINUSE falls back to 0 — any
// other error (e.g. unresolvable hostname) propagates like a bind failure.
// Note Effect.promise would turn the rejection into an uncatchable defect;
// tryPromise surfaces it as an UnknownError failure instead.
function probePreferredPort(hostname: string) {
  return Effect.tryPromise(() => probePort(4096, hostname)).pipe(
    Effect.catch((error) => {
      const cause = Cause.isUnknownError(error) ? error.cause : error
      return isAddrInUse(cause) ? Effect.succeed(0) : Effect.fail(cause)
    }),
  )
}

function probePort(port: number, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(port, hostname, () => {
      probe.close(() => resolve(port))
    })
  })
}

function isAddrInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE"
}

function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  // Build on the process-shared memoMap (the same map AppRuntime and the
  // webHandler use) so the listener reuses the live Database, EventV2,
  // InstanceStore, codegraph and tool services instead of constructing a
  // second service graph — and so events forked in AppRuntime publish on the
  // bus the listener's SSE streams read.
  return Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
      }),
    ),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      const unpublish = yield* Effect.cached(Effect.sync(() => MDNS.unpublish()))
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) {
      yield* Effect.logWarning("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state).pipe(Effect.ignore))
    const closeScopeOnce = yield* Effect.cached(
      Scope.close(state.scope, Exit.void).pipe(
        Effect.timeout("5 seconds"),
        Effect.ignore,
      ),
    )

    return (close?: boolean) =>
      Effect.gen(function* () {
        yield* unpublishMdns
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.gen(function* () {
    yield* Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: "unbounded", discard: true })
    const storeResult = yield* Effect.serviceOption(InstanceStore.Service)
    if (storeResult._tag === "Some") {
      yield* storeResult.value.disposeAll().pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause(() => Effect.void),
      )
    }
  })
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    NodeHttpServer.layer(() => server, { port: opts.port, host: opts.hostname, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
