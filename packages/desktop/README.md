> **BanyanCode fork note.** This is a fork of [OpenCode](https://github.com/anomalyco/opencode). BanyanCode adds an orchestrator + subagent mesh, cross-session memory, a code graph + embeddings utility, and a researcher agent with free web search. The full plan is in `BANYANCODE_PLAN.md`. This package is part of the BanyanCode monorepo; see the fork note for context.

# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```
