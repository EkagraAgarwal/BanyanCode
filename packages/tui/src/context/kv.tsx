/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { createDebouncedWriter } from "../util/debounced-writer"
import { useTuiPaths } from "./runtime"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const paths = useTuiPaths()
    void Global.Path.state
    const file = path.join(paths.state, "kv.json")
    const lock = `tui-kv:${file}`
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()
    // Coalesce rapid sets (every mouse move while dragging the sidebar fires
    // one) into a single trailing durable write. The snapshot is taken when
    // the timer fires, so N sets cost one structuredClone + one atomic write.
    // dispose() flushes the tail on unmount.
    const persist = createDebouncedWriter(() => {
      const snapshot = structuredClone(unwrap(store))
      write = write
        .then(() => Flock.withLock(lock, () => writeJsonAtomic(file, snapshot)))
        .catch((error) => {
          console.error("Failed to write KV state", { error })
        })
    }, 250)
    onCleanup(() => persist.dispose())

    Flock.withLock(lock, () => readJson<Record<string, unknown>>(file))
      .then((x) => {
        setStore(x)
      })
      .catch((error) => {
        console.error("Failed to read KV state", { error })
      })
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T): readonly [() => T, Setter<T>] {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name) as T
          },
          function setter(...args: any[]) {
            const next = args[0]
            const current = result.get(name)
            const value = typeof next === "function" ? next(current) : next
            result.set(name, value)
            return value
          },
        ] as unknown as readonly [() => T, Setter<T>]
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        persist.schedule()
      },
    }
    return result
  },
})
