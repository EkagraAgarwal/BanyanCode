# BanyanCode Core

BanyanCode is a separate product identity that lives alongside OpenCode. It has its own config schema, service namespace, and file locations.

## Config separation

BanyanCode-specific config keys live in `BanyanConfig.Info` (`packages/core/src/v1/config/banyan-config.ts`), NOT in `ConfigV1.Info`. Both schemas are loaded in parallel; consumers MUST use `BanyanConfig.Service` for BanyanCode keys.

The schema is a separate `Effect.Schema.Struct` annotated with `{ identifier: "BanyanConfig" }`. Add future BanyanCode keys there (e.g. telegram bot config, runtime overrides).

## Service pattern

The `BanyanConfigService` (`packages/core/src/banyancode/banyan-config.ts`) follows the standard `Context.Service` pattern:
- `get()` / `getGlobal()` — read-only, never fails
- `update(patch)` — partial merge, writes to disk, returns new config

When a consumer needs BanyanConfig but it may not be in scope, use `Effect.serviceOption(Banyan.BanyanConfigService)` and treat the option as "feature disabled" when absent:
```ts
const option = yield* Effect.serviceOption(Banyan.BanyanConfigService)
const banyan = Option.isSome(option) ? yield* option.value.get() : ({} as BanyanConfig.Info)
```

## Codegraph ignore file

The codegraph indexer looks for `.banyancode/ignore` (inside the `.banyancode/` dir), NOT `.banyancodeignore` (project root). See `codegraph-indexer.ts:58`. Update docs at `packages/docs/src/content/docs/banyancode-codegraph.mdx` if you change this.

## BanyanTools.locationLayer is the wrong pattern

Do NOT add BanyanCode service deps to `BanyanTools.locationLayer` (`packages/core/src/banyancode/tools-layer.ts`). That cascade is shared with non-BanyanCode test setups and the deps will leak into `AppLayer`'s R. Instead, provide BanyanCode services at the consumer level (e.g. `packages/opencode/src/tool/registry.ts:node`) using `Layer.provide(Banyan.subagentBusDefaultLayer)`.

## Service reference pattern

`packages/core/src/banyancode/index.ts` exports every service in two ways:
- `export { Service as X, layer as xLayer, defaultLayer as xDefaultLayer } from "./x"` — for explicit imports
- `export * as X from "./x"` — for namespace access via `Banyan.X.Service`

Consumers in `packages/opencode` use the namespace form: `Banyan.CodegraphBuildService`, `Banyan.CodegraphRepo`, `Banyan.SubagentBus`, `Banyan.BanyanConfigService`, etc. Direct imports (`import { X } from "@opencode-ai/core/banyancode/x"`) are used in core to avoid the namespace import.
