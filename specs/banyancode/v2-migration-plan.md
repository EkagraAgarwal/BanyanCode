# BanyanCode on OpenCode v2 — Migration Plan

Status: **Draft for approval** · 2026-10-31

## Context

BanyanCode is a squashed copy of OpenCode V1, imported on 2026-06-13. It shares no git history with upstream. Since then upstream has landed about 7,700 commits (about 60 a day in October). It removed V1, deleted `packages/opencode`, and shipped v2 (now 2.2.5). v2 brings:
- saved sessions that recover after crashes, with an inbox for prompts
- one background server that many clients attach to
- an event feed that encodes each event once
- Code Mode
- built-in background subagents, worktrees, schedules and artifacts
- a real plugin API (server, TUI and RPC)

Since August, BanyanCode has spent most of its performance work re-fixing problems in the V1 base that v2 has already solved differently.

**Goal:** get v2's architecture while BanyanCode keeps its own identity and **every existing feature**. A user should not be able to tell the product was re-platformed.

### Decisions already made

| Topic | Decision |
|---|---|
| Product | Branded BanyanCode distribution (its own CLI, name, dirs, config), not "a plugin for OpenCode" |
| Feature scope | Full parity: every v1 feature, command, tool, config key and MCP tool stays, **except cross-session memory, which is dropped** (it was the weakest feature; AGENTS.md, skills and the codegraph cover durable project knowledge) |
| User data | Fresh start: no import of v1 sessions, memory or settings. Called out in release notes |
| Fork during migration | Frozen completely: no releases until the v2 version ships |
| Mesh/orchestrator | Rebuilt on v2's subagent and session APIs. BanyanCode goal and swarm-wave internals are replaced by v2 goal mode, but the `/goal` and `/swarm` commands stay |
| Repo | Same GitHub repo, new branch with a fresh tree, replacing `main` at cutover |
| Additions | Claude Agent SDK integration, and an upgraded MCP server so outer harnesses (Claude Code, Codex, …) can delegate and supervise work |

### Architecture choice: a "soft fork" with shared history

A plain wrapper around stock `opencode` can't hide the upstream identity. The name `opencode` is hard-coded in `packages/util/src/global.ts`, `.opencode/` and `opencode.json` in config discovery, and the CLI name at build time (about 300 files reference it). So:

- Fork upstream v2 **with shared history**, so upstream releases merge normally.
- Keep a **small, documented patch set** on upstream files, limited to branding and the few hooks that are missing.
- Build **all BanyanCode features as in-tree plugins** on v2's public plugin API (`@opencode/plugin/effect`, `/tui` and `/rpc`), under `packages/banyancode*`.
- Over time, upstream PRs make branding configurable, to shrink the patch set.

```
upstream/dev ──(merge release tags weekly)──▶ v2 branch
                                               ├─ upstream tree (+ ≤~30 patched files, ledgered)
                                               ├─ packages/banyancode        server plugin (Effect)
                                               ├─ packages/banyancode-tui    TUI plugin (sidebar, panels, pills)
                                               └─ packages/banyancode-mcp    MCP delegation server
```

## Phases

Ordering: phases 0 → 1 → 2 run in sequence. Then workstreams 3a and 3c–3h, plus phase 4, run in parallel; phase 5 needs 3a, 3c and 3f. Phase 6 closes.

### Phase 0: Foundations

- Freeze the fork:
  - Tag the last v1 release `v1-final`.
  - Pause `tag-release.yml` and the `dev` canary in `publish.yml`.
  - Settle the uncommitted work on `fix-installer-resolve` (`packages/tui/src/context/kv.tsx`, the hotfix spec) before freezing.
- Create branch `v2-base` from the latest upstream v2 release tag (2.2.5), so it shares upstream's history.
- Write two documents:
  - `specs/banyancode/v2-patches.md`, the patch ledger: every upstream file changed, labelled `branding | hook | fix`.
  - `specs/banyancode/v2-parity.md`, the parity checklist: every v1 feature, slash command, tool ID, `banyancode_*` key, MCP tool and TUI panel, each with a test reference.
- Add a CI check that diffs against the upstream tag and fails when an upstream file is patched without a ledger entry.
- Out of scope (as in v1): the `desktop`, `web`, `app` and `storybook` packages stay in the tree so merges stay clean, but are excluded from CI and release.

### Phase 1: Identity layer (branding patch set)

- **Names and paths:**
  - App name `banyancode` (`packages/util/src/global.ts`), which gives `~/.config/banyancode`, `~/.local/share/banyancode` and the data, cache and state dirs.
  - DB file `banyancode.db`.
  - Project dir `.banyancode/` and project config `banyancode.json`, in `packages/core/src/config/discovery.ts`.
- **Environment variables:** read `BANYANCODE_*` and never `OPENCODE_*`. Map them once at CLI entry, so the two products can be installed side by side without touching each other's files.
- **User-visible surface:**
  - CLI/bin name `banyancode`, set by build-time `OPENCODE_CLI_NAME` (`packages/cli/src/commands/commands.ts`).
  - Wordmark and logo, TUI titles, help text, error text.
  - `upgrade`, which installs from npm `banyancode`.
- **Versioning and channels:**
  - CalVer `YY.MM.PATCH` continues; the upstream base version appears only in `--version --verbose`.
  - Channel isolation for dev canaries: map v1's per-channel DB onto v2's storage channel.
- **Defaults:** the PostHog telemetry key, BanyanCode default agents, and the default websearch provider (set by the plugin).
- **Acceptance:**
  - A test that sweeps strings in `--help`, TUI snapshots, the config schema URL and paths finds no user-visible "opencode".
  - Running alongside a stock `opencode` v2 install touches none of its files.
- Open upstream PRs to make the app id and dir names configurable. Each one that merges shrinks the ledger.

### Phase 2: Plugin platform and storage (includes the feasibility spike)

- **Spike first; it gates everything below:**
  - From a plugin inside the compiled binary, check that (a) `bun:sqlite` with FTS5 and the trigram tokenizer works, with a `node:sqlite` fallback for the Node build, and (b) the 17 tree-sitter `.wasm` grammars load from plugin assets.
  - Check that (c) the host config schema accepts the `banyancode_*` keys. If it doesn't, add a small schema patch (a hook).
  - Check that (d) the plugin can import the `@opencode/schema` types it needs.
- **`packages/banyancode` skeleton:**
  - `Plugin.define`, registered as a **built-in** in `packages/core/src/plugin/internal.ts` (one ledgered line), so users can't drop it by accident.
  - Use `packages/plugin-browser` as the template: `./server`, `./rpc` and `./tui` exports.
- **Storage:**
  - A plugin-owned SQLite file per project at `<repo>/.banyancode/banyancode-<hash>.db`, as in v1.
  - Port the drizzle tables (codegraph, verification, telemetry, mesh) plus the codegraph FTS5 table as one fresh migration. The memory tables are dropped.
  - Cross-location writes go through a file lock (Flock pattern), since the plugin activates once per location.
- **RPC instead of `/global/*` routes:** `banyancode.{codegraph,intel,verify,mesh,config,usage}.*` through `ctx.rpc.register`. Events are emitted as `rpc.banyancode.*`.
- **BanyanConfig:** the same `banyancode.json` keys, about 50 of them, read and validated by the plugin. They are exposed over RPC for the TUI and agent-override editor.

### Phase 3: Feature ports (parallel workstreams, disjoint files)

| WS | Feature (v1 source) | v2 mechanism |
|---|---|---|
| 3a | Codegraph: indexer, auto-update, readiness, `/codegraph-*` commands, system-prompt policy (`packages/core/src/banyancode/codegraph-*`, `langs/**`) | `ctx.tool.transform` (namespace, permission action); `ctx.command.transform`; indexing in `Effect.forkScoped` fibers; watcher via `ctx.event.subscribe` `filesystem.changed`; policy text via `ctx.session.hook("context")` |
| 3b | ~~Memory~~ **Dropped.** Not ported: `memory-*` modules, the `memory_entries`/FTS tables, the 4 memory tools, the 10 `/memory/*` routes, the `banyan_memory` MCP tool, and memory-related TUI data. Listed in `v2-parity.md` as intentionally removed | — |
| 3c | Repo-intel, change-check (`preflight`, `blast_radius`, `safe_rename`, `edit_plan`), verify (`test`, `typecheck`, `lint`) | Tools plus RPC; run processes via shell hooks or the plugin's own process spawning |
| 3d | Agents: orchestrator, coder, scout, researcher, reviewer, with prompts, permissions and per-agent overrides; DuckDuckGo search | `ctx.agent.transform` (`system`, `mode`, `permissions`, `model`); `ctx.websearch.transform` adding `duckduckgo` and setting it as default |
| 3e | Tool gateway (`route_grep`/`read`/`glob`, `augment_read`), tool telemetry and token attribution, prompt-cache tuning, yolo mode, LSP caps | `tool` hook `execute.before` (rewrite `tool`/`input`), `execute.after` (rewrite `result`); `aisdk` hooks and `session.hook("model.request")` for cache options; `permission.evaluate` hook for yolo; LSP caps via v2 LSP config, or one ledgered hook patch if none exists |
| 3f | Mesh/orchestrator: subagent messages, plans, review requests, nested-spawn budget, `max_subagents`, background gate, `/goal`, `/swarm` | Subagents are `mode: "subagent"` agents used through v2's built-in `subagent` tool; mesh tables live in the plugin DB; spawn and supervise via `ctx.session.{create,prompt,wait,synthetic}`; limits via `experimental.subagent_depth` plus `permission.evaluate`; `/goal` maps to v2 goal mode, `/swarm` to parallel background subagents |
| 3g | TUI: sidebar panels, tabs and left rail, inspector, status pills, codegraph progress, agent tree, provider usage | `packages/banyancode-tui`: `sidebar.content` slots; v2 native `ui.tabs`; `session.panel` and `ui.router.register` pages; `prompt.footer.status`, `home.footer.status`, `session.composer.top`; data via `client.rpc(banyancodeRpc)` and its events |
| 3h | Config-only parity: Telegram keys (no v1 implementation exists), and items that never worked (intel-trace endpoint, unregistered `banyan_typecheck`/`banyan_lint`) | Keys accepted and stored as before. Decide per item whether to finish it now that it's cheap; default is to finish typecheck/lint tools and the trace endpoint |

Each workstream ports its v1 tests where they apply. Tests use real DBs in `tmpdir()`, no mocks, as in v1. Each one ticks its rows in `v2-parity.md`.

### Phase 4: Claude Agent SDK integration

v2 already ships the `claude-agent` provider (`packages/core/src/plugin/provider/claude-agent/**`, spec `specs/v2/claude-agent-provider.md`). It runs the user's own `claude` through the Agent SDK, turns off Claude Code's built-in tools, and exposes the app's tools to Claude over MCP.

- Keep it enabled. The product name must be "Claude Agent", per the SDK branding rules, which don't allow calling it "Claude Code". The guided setup, auth hints and `BANYANCODE_CLAUDE_PATH` follow the identity layer.
- BanyanCode tools (codegraph, change-check, verify, mesh) reach Claude automatically as registered tools. Verify the names and descriptions survive the `mcp__…` prefixing, and that codegraph-first policy text lands in Claude's instructions.
- **Mixed-provider meshes:** `banyancode.json` agent overrides let, for example, the orchestrator and reviewer run on `claude-agent/*` while workers run on cheaper providers. Subagents spawned by Claude go through BanyanCode's subagent tool, not Claude's own Task tool.
- **Known constraint:** the provider runs tool calls one at a time, so the orchestrator prompt should push parallel work into subagents instead of parallel tool calls.
- **Tests:** `claude` present or missing, logged out, tool-list changes (which restart the Claude process), and a mesh run with mixed providers.

### Phase 5: MCP delegation server (`packages/banyancode-mcp`)

**Goal:** an outer harness (Claude Code, Codex, Cursor, …) hands BanyanCode whole tasks. BanyanCode runs them on its own with its own subagents. The harness mostly does cheap **periodic checkups**, answers questions, and collects results.

- **Runtime:**
  - `banyancode mcp` serves over stdio and streamable HTTP.
  - It attaches to, or starts, the BanyanCode background server (v2's service model), so tasks keep running after the MCP client disconnects.
  - v2's saved sessions and claimed-execution recovery let tasks survive a server restart.
  - It talks to the server through the generated client plus `banyancode.*` RPC.
- **Tools:** all existing names stay. New tools are marked ★.
  - `banyan_task_start {goal, agent?, model?, worktree?: "new"|path, budget?: {max_steps, max_cost, timeout}, autonomy?: profile, max_subagents?}` → `taskID`.
  - ★ `banyan_task_spawn`: fan out one or more subtasks under a task.
  - ★ `banyan_checkup {cursor?}`: **one call for periodic supervision.** For each active task it returns:
    - status, phase and progress
    - a short digest of what happened since the cursor
    - pending questions and permission asks
    - files changed, cost and tokens
    - stuck or loop detection
    - a suggested next checkup interval
    - a new cursor

    It is token-cheap by design.
  - `banyan_task_status`, `banyan_task_result`, `banyan_task_cancel`; `banyan_task_reply` is extended to answer questions **and** permission prompts, with steer or queue delivery (v2 inbox semantics).
  - ★ `banyan_task_list`: the task and subagent tree. ★ `banyan_task_artifacts`: diff, changed files, test and verify results, and a final report.
  - Code tools are kept: `banyan_codegraph`, `banyan_code_find`, `banyan_repo`, `banyan_change_check`, `banyan_verify`. `banyan_memory` is removed along with the memory feature.
- **MCP protocol features:**
  - Progress notifications.
  - Subscribable resources `banyan://task/<id>` and `banyan://tasks`, with `resources/updated` pushes, so clients that support push don't need to poll.
  - Elicitation for permission questions where the client supports it.
  - Structured output schemas.
  - Server instructions that teach the "delegate, then check up" loop.
- **Safety:**
  - Autonomy profiles in `banyancode.json` set what can be auto-approved when no human is watching, per client.
  - Delegated tasks default to an isolated worktree.
  - Budget caps, plus a global kill switch.
- **Onboarding:**
  - `banyancode mcp install claude-code|codex|cursor` writes the client config (with confirmation).
  - A Claude Code skill and plugin describing the checkup loop.
  - `banyancode mcp doctor`.
- **Tests:** an end-to-end MCP client test covering start → checkup until done → artifacts; a question/permission round-trip; killing the server mid-task and recovering; two clients at once; budget exhaustion.

### Phase 6: Release engineering and cutover

- **Publishing:**
  - Port `publish.yml`, `tag-release.yml` and `preflight.yml` to v2's `packages/cli/script/build.ts`, with branding environment variables set.
  - Publish npm `banyancode` plus per-platform packages, adding the targets v2 supports (e.g. Windows ARM64).
  - Keep the CalVer, channel and dist-tag rules, Azure signing, and the PostHog keys.
- **Docs:** update `packages/docs`, including `banyancode-mcp.mdx` and new pages on delegation and Claude Agent. The release notes state the fresh-start data policy.
- **Gate:** `v2-parity.md` at 100%; side-by-side check against stock `opencode`; an RC on the `next` dist-tag for testers.
- **Cutover (confirm with the user at that point):** rename `main` → `v1` and `v2-base` → `main`, then cut the first v2-based CalVer release.
- **After cutover:** merge upstream release tags weekly; the patch-ledger CI check keeps the fork thin; prefer upstream PRs for new hooks over local patches.

## Spike results (2026-10-31, upstream v2.2.5, Windows x64)

Run in a scratch worktree, `D:\OpenCode-v2spike`, by three BanyanCode coder subagents on `opencode-go/deepseek-v4.1-flash`. I re-ran the results myself.

| Check | Result |
|---|---|
| `bun:sqlite` + FTS5 `tokenize='trigram'` from a plugin | ✅ From source (`bun test`, 2 pass) **and** inside the compiled `opencode.exe`: RPC `banyancode.spike.probe` → HTTP 200, `driver: bun:sqlite`, 2 matches. The `node:sqlite` fallback also works |
| tree-sitter wasm from plugin assets (bytes via `import.meta.url`, no `with {type:"wasm"}`) | ✅ From source and in the compiled binary: root `program`, `hasError: false` |
| Plugin tool + RPC registration (`ctx.tool.transform`, `ctx.rpc.register`) | ✅ Loaded by the binary from the config `plugins` entry via `package.json` `exports["./server"]`. `ctx.rpc.register` has an `unknown` error channel, so map it with `Effect.orDie` |
| `@opencode/schema` imports | ✅ For `Rpc`. `Tool` must come from `@opencode/schema/tool`, since it isn't exported from the root |
| Host config accepts `banyancode_*` keys | ❌ They are **silently dropped**: the normalizer whitelist (`packages/core/src/config/normalize.ts`) plus `onExcessProperty: "ignore"` (`packages/core/src/config.ts:134`). Agent `thinking` is not in the v2 `Config.Agent` schema. **Decision:** as in v1, the plugin reads and validates `banyancode.json` itself and applies agent overrides via `agent.transform`. No schema patch needed |
| Isolated test runs | ✅ `XDG_*`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TEST_HOME`, `OPENCODE_DB` and `OPENCODE_PASSWORD` fully isolate a probe server (`spike-build/run-probe.ps1`). Reuse this for plugin integration tests |

Notes for later phases:
- Building v2 needs **Bun 1.4.4** (the build script hard-fails on 1.4.3). The single-target build: `bun run script/build.ts --single --skip-install --skip-web-ui` in `packages/cli`.
- Branding patch inputs (Phase 1): `packages/core/src/config/discovery.ts` lines 12 (`opencode.json[c]`), 29–31 (system dirs), 37–38 (MDM plist), 85/124/126 (`.opencode`); `packages/core/src/config.ts:470`; `packages/util/src/global.ts:12` (`app = "opencode"`) and `:79`.
- Still open: in the spike the plugin was loaded **from a directory on disk**. Shipping it as a built-in means its `.wasm` assets must be embedded in the compiled binary (Bun `compile` embedded files) or installed next to it. Check this early in Phase 2.
- `bun:sqlite` holds the file until `db.close(true)`, so use that in tests and on shutdown.

## Remaining risks

1. ~~SQLite with FTS5 trigram, and loading wasm assets, from a plugin inside the compiled binary~~ ✅ verified (see Spike results). Still open: embedding a built-in plugin's assets in the compiled binary, and the Node build.
2. ~~Whether the host config schema accepts unknown `banyancode_*` keys~~ ❌ It doesn't; resolved by having the plugin read `banyancode.json` itself.
3. The size of the branding patch set compared with upstream churn. The ledger CI and upstream PRs are the mitigation.
4. `execute.after` result rewriting being enough for the read/grep/glob gateway, including its token-accounting effects.
5. Claude Agent's one-tool-at-a-time limit affecting orchestrator throughput.
6. The plugin KV store being app-wide (key prefixes by project), and the plugin activating once per location (shared-DB locking).

## Verification (overall)

- `bun typecheck` and package `bun test` stay green on `v2-base`, with upstream's suite plus the ported BanyanCode suites.
- A per-row test in `v2-parity.md` for every feature, command, tool, config key and MCP tool.
- Identity sweep: no user-visible "opencode", and no reads or writes under any opencode path.
- Manual: run `banyancode` in a real repo (codegraph build, mesh with mixed providers including `claude-agent`, all TUI panels), then drive a full delegated task from Claude Code and Codex through `banyancode mcp` using only `banyan_checkup`.
