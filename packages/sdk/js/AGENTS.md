# SDK Generation

## Regenerate

```bash
cd D:\OpenCode/packages/sdk/js && bun script/build.ts
```

This runs `bun dev generate` in the opencode package to produce `openapi.json`, then feeds it to `@hey-api/openapi-ts`. Regenerates:
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`
- `packages/sdk/js/src/v2/gen/client/` (sub-client + utils)

After regen, you may need to add the new HTTP endpoints to the opencode HttpApi group BEFORE running regen — endpoints only appear in the SDK after they're declared in the group.

## SDK sub-namespace pattern

`HttpApiGroup.make("global", ...)` produces a nested class hierarchy in the SDK. New endpoints like `banyanConfig.get()` and `banyanConfig.update()` appear under the `Global` class as nested classes.

TUI consumers reference them as:
```ts
sdk.client.global.banyanConfig.get()
sdk.client.global.banyanConfig.update({ banyanConfig: { ... } })
```

**Payload key wrapping:** the payload is wrapped in a key matching the endpoint name (e.g. `banyanConfig: { banyancode_embedding_model: "..." }`), NOT a top-level `config: { ... }` object. Check `packages/sdk/js/src/v2/gen/types.gen.ts` for the exact payload shape.

## When SDK regen is required

Add a new HTTP endpoint → run regen → consumer code can use the typed client.

For temporary workarounds while waiting for regen, use:
```ts
;(sdk.client as any).groupName?.endpointName?.({...})
```

Then remove the `as any` cast after regen and a successful typecheck.
