// In-memory `RpcCaller` for code-tool and server tests.
//
// The real definitions come from `@banyancode/plugin/rpc/*`; this fake keeps
// their shape (one function per method, keyed by the definition id) and records
// every call so assertions can check the forwarded payload. Handlers are keyed
// `"<rpcID>.<method>"`.

import type { Rpc } from "@opencode/schema/rpc"
import type { RpcCaller, RpcClientOf } from "../src/rpc"

export type RpcCall = {
  rpcID: string
  method: string
  input: unknown
}

export type FakeRpcHandler = (input: unknown) => unknown

export type FakeRpc = {
  caller: RpcCaller
  calls: RpcCall[]
  on: (key: string, handler: FakeRpcHandler) => FakeRpc
  reset: () => void
}

export function createFakeRpc(initial: Record<string, FakeRpcHandler> = {}): FakeRpc {
  const handlers = new Map<string, FakeRpcHandler>(Object.entries(initial))
  const calls: RpcCall[] = []

  const caller = ((<D extends Rpc.Definition>(definition: D): RpcClientOf<D> => {
    const methods = Object.fromEntries(
      Object.keys(definition.methods).map((name) => [
        name,
        async (input: unknown) => {
          calls.push({ rpcID: definition.id, method: name, input })
          const handler = handlers.get(`${definition.id}.${name}`)
          return handler === undefined ? { rpcID: definition.id, method: name, input } : await handler(input)
        },
      ]),
    )
    return methods as unknown as RpcClientOf<D>
  }) as unknown) as RpcCaller

  const fake: FakeRpc = {
    caller,
    calls,
    on(key, handler) {
      handlers.set(key, handler)
      return fake
    },
    reset() {
      calls.length = 0
    },
  }
  return fake
}
