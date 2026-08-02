export * as CodegraphRustBinary from "./codegraph-rust-binary"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { FSUtil } from "../fs-util"

export interface Interface {
  readonly filepath: Effect.Effect<string | null, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphRustBinary") {}

const binaryName = process.platform === "win32" ? "codegraph-rs.exe" : "codegraph-rs"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const filepath: Effect.Effect<string | null, never, never> = yield* Effect.cached(
      Effect.gen(function* () {
        const envOverride = process.env.BANYANCODE_CODEGRAPH_BIN
        if (envOverride) {
          const exists = yield* fs.isFile(envOverride).pipe(Effect.orElseSucceed(() => false))
          if (exists) return envOverride
        }

        const bundled = path.join(Global.Path.banyan.bin, binaryName)
        const bundledExists = yield* fs.isFile(bundled).pipe(Effect.orElseSucceed(() => false))
        if (bundledExists) return bundled

        // Download-from-release path is intentionally not wired here yet: no
        // GitHub release of codegraph-rs has been published. When a release
        // exists, mirror the ripgrep binary.ts download + PowerShell
        // Expand-Archive / tar.gz flow against a release like
        //   https://github.com/EkagraAgarwal/BanyanCode/releases/download/codegraph-rs-v0.1.0/...
        // Until then resolution returns null and the indexer falls back to js.
        return null
      }),
    )

    return Service.of({ filepath })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))