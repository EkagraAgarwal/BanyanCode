# BanyanCode v2 parity gaps

Status: **audit snapshot**, 2026-11-01, on `v2-base` at `2daf10b3e1` plus the
in-flight worktree (other workstreams were actively editing while this audit
ran). Scope: all 370 rows in `specs/banyancode/v2-parity.md`.

Method: every row was matched against the tree by symbol/tool/command/config
key/route/env/event name in `packages/banyancode`, `packages/banyancode-tui`,
`packages/banyancode-mcp`, and the v2 host (`packages/core`, `packages/cli`,
`packages/tui`, `packages/schema`). A row is **covered** when a v2 module
implements it, or when a named v2 native feature replaces the v1 mechanism;
only rows with neither appear in the gap table below.

## Summary

| Section | Rows | Dropped by design | Gaps in this doc |
|---|---|---|---|
| 1. LLM tools | 46 | 7 (memory) | 1 |
| 2. Agents and prompt sources | 15 | 0 | 1 |
| 3a. Server slash commands | 20 | 0 | 9 |
| 3b. Palette / prompt intercepts | 15 | 0 | 6 |
| 4. Config keys | 80 | 0 | 0 |
| 5. HTTP routes → RPC | 47 | 10 (memory) | 3 |
| 6. MCP delegation server | 15 | 1 (memory) | 6 |
| 7. TUI surfaces | 45 | 2 (memory) | 4 |
| 8a. CLI commands | 28 | 1 (memory) | 25 |
| 8b. Environment variables | 27 | 0 | 5 |
| 8c. Product identity | 17 | 0 | 3 |
| 9. Published events | 15 | 4 (memory) | 1 |
| **Total** | **370** | **25** | **64** |

64 rows remain. 281 rows are implemented or replaced by a named native v2
feature; 25 are intentionally dropped (cross-session memory). The v1
module-only (7b) and never-worked (3b/8a) rows are counted as
covered/not-required, not as gaps — see "Parity-by-design".

## Main gap table (no implementation, no native equivalent)

### 1. LLM-facing tools

| Row | What is missing | Owner |
|---|---|---|
| `goal` | v1 registered a `goal` tool for the model. v2's native GoalPlugin owns `/goal` and goal state but registers no `goal` tool. | mesh / 3f (agent definitions + goal bridge) |

### 2. Agents and prompt sources

| Row | What is missing | Owner |
|---|---|---|
| BanyanCode orchestration system block (static policy + mesh/subagent rules, every agent) | No `ctx.session.hook("context")` appends the v1 orchestration block; only the codegraph policy and per-agent prompts are injected. | mesh / 3f or agents / 3d |

### 3a. Server slash commands

| Row | What is missing | Owner |
|---|---|---|
| `/repository-query` | Tool and RPC exist; the slash command is not registered. | intel / 3c |
| `/repository-explain` | Same. | intel / 3c |
| `/repository-trace` | Same. | intel / 3c |
| `/repository-impact` | Same. | intel / 3c |
| `/repository-tests` | Same. | intel / 3c |
| `/repository-symbols` | Same. | intel / 3c |
| `/repository-relationships` | Same. | intel / 3c |
| `/repository-ownership` | Same. | intel / 3c |
| `/refresh-models` | No command. v2's `ModelsDev` service auto-refreshes on its TTL, but there is no user-invokable refresh. | CLI/TUI / 1 |

### 3b. Command-palette and prompt intercepts

| Row | What is missing | Owner |
|---|---|---|
| `agent.model` / `/agent-model` | No palette entry that jumps straight to the per-agent model picker (the CONFIG panel can change models, but the v1 entry is absent). | TUI / 3g |
| `models.refresh` palette action | No palette action; see `/refresh-models`. | TUI / 3g |
| `yolo.toggle` palette action | The pills toggle YOLO on click; no palette command with the v1 id. | TUI / 3g |
| `swarm.toggle` palette action | Same; no palette command. | TUI / 3g |
| `subagents.max_subagents` — opens the max-subagents dialog | `/max-subagents` command works (and now persists), but the dialog is absent. | TUI / 3g |
| `/thinking` / `/variant` / `/reasoning` prompt intercept | The CONFIG panel has a thinking picker; the slash intercept that reads/sets a variant is absent. | TUI / 3d |

### 5. HTTP routes → RPC

| Row | What is missing | Owner |
|---|---|---|
| `PATCH /global/banyan-config → banyancode.config.update` | The writer exists (`src/config/writer.ts`), but the main `banyancode` RPC definition has only `config.get`. | lead / main `src/rpc.ts` (add the method and call the writer) |
| `GET /global/provider-usage → banyancode.usage.providerList` | No RPC. The TUI provider panel uses a placeholder definition. | telemetry/provider / 3g |
| `POST /global/provider-usage/refresh → banyancode.usage.providerRefresh` | No RPC. | telemetry/provider / 3g |

### 6. MCP delegation server

| Row | What is missing | Owner |
|---|---|---|
| `banyan_code_find` | Code tools are not registered on the MCP server (`server.ts` says "Code tools … are not part of this server yet"). | MCP / 5 |
| `banyan_repo` | Same. | MCP / 5 |
| `banyan_change_check` | Same. | MCP / 5 |
| `banyan_codegraph` | Same. | MCP / 5 |
| `banyan_verify` | Same. | MCP / 5 |
| Tool-group allowlist (`task`/`code`/`memory`/`verify`) | `--tools` is parsed and `task` is enforced, but the `code` and `verify` groups do not exist yet (`memory` is dropped by design). | MCP / 5 |

### 7. TUI surfaces

| Row | What is missing | Owner |
|---|---|---|
| Home: codegraph tip + progress placement | The progress widget mounts at `session.composer.top`; the home-screen tip/progress placement is absent. | TUI / 3g |
| Home: tips + quick actions (Banyan tips variant) | No Banyan home tips component. | TUI / 3g |
| Dialog: agent control / agent tree (steer, kill) | The AGENTS view renders the tree but has no steer/kill actions. | TUI / 3f |
| Dialog: max concurrent subagents (1-20) | No dialog; only the `/max-subagents` command. | TUI / 3g |

### 8a. CLI commands

All of these are `banyancode` subcommands that the v2 CLI does not define
(`packages/cli/src/commands/commands.ts`). Native v2 command names that do
exist are noted in the coverage appendix.

| Row | What is missing | Owner |
|---|---|---|
| `banyancode codegraph build --root --force --watch --timeout` | No CLI command. | CLI / 3a |
| `banyancode codegraph status` | No CLI command. | CLI / 3a |
| `banyancode codegraph cancel` | No CLI command. | CLI / 3a |
| `banyancode codegraph remove --drop-file` | No CLI command. | CLI / 3a |
| `banyancode codegraph force-kill` | No CLI command. | CLI / 3a |
| `banyancode codegraph path` | No CLI command. | CLI / 3a |
| `banyancode codegraph trace` | No CLI command. | CLI / 3a |
| `banyancode goal set <condition> --plan --priority --session` | No CLI; `/goal` exists only as a slash command/plugin. | CLI / 3f |
| `banyancode goal status --session` | No CLI. | CLI / 3f |
| `banyancode goal list --session` | No CLI. | CLI / 3f |
| `banyancode goal cancel --session` | No CLI. | CLI / 3f |
| `banyancode repository query <query> --limit` | No CLI. | CLI / 3c |
| `banyancode repository explain <symbol>` | No CLI. | CLI / 3c |
| `banyancode repository trace <symbol> --depth` | No CLI. | CLI / 3c |
| `banyancode repository impact <path>` | No CLI. | CLI / 3c |
| `banyancode repository tests <symbol>` | No CLI. | CLI / 3c |
| `banyancode repository relationships` | No CLI. | CLI / 3c |
| `banyancode repository ownership` | No CLI. | CLI / 3c |
| `banyancode websearch-free <query> --num` | No CLI. The websearch provider is native; the command is not. | CLI / 3d |
| `banyancode tools --category` | No CLI. | CLI / 3e |
| `banyancode telemetry status\|on\|off` | No CLI. | CLI / 3e |
| `banyancode telemetry agent-report …` | No CLI. | CLI / 3e |
| `banyancode telemetry agent-export …` | No CLI. | CLI / 3e |
| `banyancode db gc --yes --dry-run --root` | No CLI. | CLI / 1 |
| `banyancode mcp serve …` | `packages/banyancode-mcp/src/main.ts` implements the server, but no CLI subcommand dispatches to it (v2's `mcp` command manages client MCP servers, a different surface). | CLI / 5 |

### 8b. Environment variables

| Row | What is missing | Owner |
|---|---|---|
| `BANYANCODE_ENABLE` (`0` disables all tools/policy) | Only codegraph and websearch honor it. There is no global gate for tool registration, policy injection, mesh or verify. | lead / server.ts |
| `BANYANCODE_TUI_CONFIG` | Mapped to `OPENCODE_TUI_CONFIG` by `env-map.ts`, but no v2 module reads that name; TUI config comes from host config instead. | CLI/TUI / 1 |
| `BANYANCODE_AGENT_TELEMETRY_KEY` | The v1 agent-efficiency telemetry pipeline (key file, local id, report/export) was not ported; the v2 telemetry module records token/tool usage only. | telemetry / 3e |
| `BANYANCODE_SNAPSHOT_LIST_TIMEOUT_MS` | v2 `Snapshot` has no timeout knob and no env read. | core snapshot / 1 |
| `BANYANCODE_POSTHOG_KEY` | The plugin reads the runtime variable, but the v2 build does not bake it (`packages/cli/script/build.ts` / `build-node.ts` have no define), so a compiled release has no key and telemetry is a no-op. | build/release (patch below) |

### 8c. Product identity

| Row | What is missing | Owner |
|---|---|---|
| Channel suffix on `banyancode-<12-char-hash><channel>.db` | The plugin DB is `banyancode-<hash>.db` with no channel suffix; `storage/paths.ts` does not read the host channel. Dev/next builds therefore share one plugin DB. | storage / 1 |
| CalVer version `26.10.9` | `packages/cli` and `packages/banyancode` still report `2.2.5` / `0.0.0`. | release / 1 |
| First-run directory creation + default `banyancode.json` | No v1 `init-banyan` equivalent; directories are created lazily and no default config is written. | CLI / 1 |

### 9. Published events

| Row | What is missing | Owner |
|---|---|---|
| `banyancode.config.updated → rpc.banyancode.config.updated` | No Banyan RPC emits a config-changed event. My system writers land the file but cannot publish the host event; the TUI refreshes manually after its own writes, other clients do not. | lead / main `src/rpc.ts` (event) + system writers |

## Patches core / build would need (not implementable in the plugin)

### LSP caps

v2 has **no LSP runtime**. The only LSP code is:

- `packages/schema/src/config/lsp.ts` — `ConfigLSP.Info` / `Entry` (no
  `maxMemoryMb`, no `idleTimeoutMs`).
- `packages/schema/src/lsp-event.ts` — `lsp.updated` with an empty schema.
- `packages/core/src/config/normalize.ts:576-583` — decodes the host `lsp` key.
- `packages/core/src/file-mutation.ts:131`, `packages/core/src/tool/plugin/edit.ts:258`,
  `packages/core/src/tool/plugin/write.ts:44` — `TODO … after LSP runtime exists`.

`banyancode_lsp` and `banyancode_lsp_idle_timeout_ms` are validated by the
plugin and reported by `banyancode.system.lsp.status`, but applying them needs:

1. A core LSP client manager that consumes `ConfigLSP.Info` and publishes
   `lsp.updated` with a real status payload.
2. `ConfigLSP.Server` extended with `maxMemoryMb?: number` and
   `idleTimeoutMs?: number` (v1 accepted both per server).
3. A mapping (or plugin seam) for `banyancode_lsp` /
   `banyancode_lsp_idle_timeout_ms` into that manager. Until then `/lsp` only
   changes config and `lsp.status` marks entries `inert`.
4. Optional: diagnostics hooks in `edit`/`write` once the manager exists.

### Telemetry key at build time

`packages/cli/script/build.ts` and `build-node.ts` should add to `define`:

```ts
"process.env.BANYANCODE_POSTHOG_KEY": JSON.stringify(process.env.BANYANCODE_POSTHOG_KEY ?? ""),
"process.env.BANYANCODE_TELEMETRY_ENDPOINT": JSON.stringify(process.env.BANYANCODE_TELEMETRY_ENDPOINT ?? ""),
```

and the publish/preflight workflows should pass `BANYANCODE_POSTHOG_KEY`
(the plugin already reads that exact expression). With no key the ping is a
silent no-op, and tests force `BANYANCODE_TELEMETRY=off` in `test/preload.ts`.

## Notes: implemented rows with a residual behavior gap (not counted above)

- `/swarm` toggle: `src/mesh/commands.ts` updates an in-memory `Ref`; it does
  not write `banyancode_swarm_mode`. v1 persisted the toggle. Mesh should call
  `update({ banyancode_swarm_mode }, { ... })` from `src/config/writer.ts`
  (the writer is exported for exactly this).
- Performance panel: v2 step events carry no TTFT, so the TTFT row is omitted
  by design; tokens/s and output tokens are present.
- Attention strip: permissions and questions are listed; blocked peers and LSP
  issues are not, because v2 exposes no per-peer abort state and no LSP runtime.
- `banyancode_openai_compatible_endpoints`, `banyancode_reasoning_configuration_update`,
  `banyancode_prompt_cache_stable_prefix` and `banyancode_tool_search_defer`
  are accepted and validated but have no v2 consumer (the v1 consumers existed).
  Custom OpenAI-compatible providers are covered natively by v2 provider
  configuration; the other three are behavior gaps for 3e.
- `banyancode stats --heatmap` is not in v2's native `stats` command (v2 covers
  days/project/models/tools/json). `banyancode upgrade` is native.

## Parity-by-design (not gaps)

- Cross-session memory: all 25 memory rows stay dropped (tools, routes, MCP
  tool, CLI, TUI tab/dialogs/events).
- Telegram keys: accepted and stored, no behavior (v1 had none).
- 7b “module only” TUI files: not registered in v1, so not user-visible.
- `/repo-find-subsystem`, `/codegraph-search`, `/codegraph-find-routes`: v1
  commands never worked (their endpoints did not exist).
- `BANYANCODE_LEGACY_DB_PATH` and the legacy DB filename: v2 is a fresh start
  by decision; no v1 sessions/memory/settings are imported.
- `banyancode_codegraph_enabled` (gap note in parity §4): never in
  `BanyanConfig` in v1; v2 keeps the same ignore-and-warn behavior.

## Coverage appendix: named native replacements

| v1 surface | v2 replacement |
|---|---|
| `websearch_free` tool + `/global/websearch-free` | `ctx.websearch` provider registry; DuckDuckGo is added and defaulted by `src/websearch` |
| `/init`, `/review` | `packages/core/src/plugin/command.ts` native commands |
| `/goal` and goal events | `packages/core/src/plugin/goal.ts` (`goal.changed`, goal loop) |
| `/import`, session import route | `banyancode import` / `banyancode session import` CLI |
| `/refresh-models` behavior | `ModelsDev` TTL refresh (the command itself is a gap above) |
| Agent markdown discovery | v2 config-agent plugin discovers `{agent,agents}/**/*.md` in `.banyancode/` and config dirs |
| Brand / wordmark / home footer / tabs | `packages/tui/src/brand.ts`, `logo.ts`, native home footer and tabs |
| Sidebar context, MCP, footer; status dialog; diff viewer | v2 native TUI feature plugins (`sidebar/context`, `sidebar/mcp`, `sidebar/footer`, `dialog-status`, `system/diff-viewer*`) |
| TUI config discovery | host TUI config (`@opencode/tui/config`) |
| `BANYANCODE_CONFIG`, `BANYANCODE_CONFIG_DIR`, `BANYANCODE_CONFIG_CONTENT`, `BANYANCODE_DISABLE_PROJECT_CONFIG` | `env-map.ts` → host config flags/discovery |
| `BANYANCODE_PROJECT_DB_DIR` | plugin storage path override |
| `BANYANCODE_MCP_TOKEN/OUTPUT_CHARS/ALLOW_YOLO`, `BANYANCODE_SERVER_PASSWORD` | `packages/banyancode-mcp` |
| `/global/startup` | plugin activation |
| `banyan_task_*` MCP tools, stdio/HTTP transports, server instructions | `packages/banyancode-mcp` |
