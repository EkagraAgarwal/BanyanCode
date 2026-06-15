# CLI Command Patterns

## First-run setup

For new product identities (like BanyanCode) that need their own directory tree on first launch, add an `ensureXxxDirs()` function in `init-xxx.ts` and call it at the start of the `Cli.run` handler in `packages/opencode/src/cli/cmd/run.ts:241`.

**Use `Global.Path.xxx.*` for paths, NOT `os.homedir()`.** The Global.path constants respect `BANYANCODE_CONFIG_DIR` and `XDG_*` env vars; `os.homedir()` doesn't.

Use dynamic imports to keep startup cold-start fast:
```ts
const { ensureBanyanDirs } = yield* Effect.promise(() => import("@/cli/cmd/init-banyan"))
yield* Effect.promise(() => ensureBanyanDirs())
```

Pattern for the init function:
```ts
import { Global } from "@opencode-ai/core/global"

export async function ensureXxxDirs() {
  const configDir = Global.Path.xxx.config
  const dirs = [configDir, Global.Path.xxx.data, Global.Path.xxx.cache, ...]
  for (const dir of dirs) {
    await fsNode.mkdir(dir, { recursive: true }).catch(() => {})
  }
  const configFile = path.join(configDir, "xxx.json")
  if (!existsSync(configFile)) {
    const content = JSON.stringify({ $schema: "..." }, null, 2)
    await fsNode.writeFile(configFile, content).catch(() => {})
  }
}
```

## Dynamic imports for heavy modules

The `Cli.run` handler is startup-sensitive. Avoid top-level imports of heavy modules. Use `yield* Effect.promise(() => import("@/module"))` at the start of the handler so cold-start stays fast.

See `packages/opencode/src/cli/cmd/run.ts:241-245` for the canonical pattern.
