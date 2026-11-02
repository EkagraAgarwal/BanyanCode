import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import path from "node:path"
import { EnvMap } from "../../src/env-map"
import { Standalone } from "../../src/services/standalone"

// The real CLI entry maps the environment first; without this the server drops the lease password the owner sets.
EnvMap.apply()

process.chdir(path.join(import.meta.dir, "../../../.."))

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const endpoint = yield* Standalone.start({
        command: [process.execPath, path.join(import.meta.dir, "../../src/index.ts"), "serve"],
      })
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", endpoint.url), { headers: Service.headers(endpoint) }),
      )
      console.log(`STANDALONE_READY ${endpoint.pid} ${endpoint.url} ${response.status}`)
      return yield* Effect.never
    }),
  ),
)
