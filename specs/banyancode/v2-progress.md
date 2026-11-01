# BanyanCode v2 migration: progress

Status at the last stop, 2026-11-01. Plan: [v2-migration-plan.md](v2-migration-plan.md). Feature list: [v2-parity.md](v2-parity.md), gaps audit: [v2-parity-gaps.md](v2-parity-gaps.md), upstream edits: [v2-patches.md](v2-patches.md).

## Where things are

- Branch `v2-base`, local only. **Not on GitHub yet, and nothing is published to npm.**
- The fork is frozen: `v1-final` tagged and pushed, `publish` and `Tag release` workflows disabled on GitHub.
- All work is committed; no coders were running at the stop.

## Verified on the dev build (26.11.0-dev.008a7d0, before the line-ending commit)

- Smoke test: 18 of 18. Includes `mcp serve` starting its own service and ignoring a stock OpenCode registration.
- A real AI session: built the code graph, found the caller, wrote the file.
- Real MCP delegation: delegate, disconnect mid-task, reconnect, supervise with `banyan_checkup` (each under about 1 KB), answer permission prompts, collect the result. This run predates the goal, quota and prompt-cache commits; the smoke test covers those builds, this flow has not been repeated.
- CLI subcommands, run on a real binary, including project isolation. Also predates those commits.
- Tests: plugin 296, TUI 49, MCP 131, core tests touched by these changes pass, typecheck clean in those packages.

## Next steps, in order

1. Push `v2-base`. Upstream's pre-push hook runs `bun run check` (lint, then typecheck of every package), which ran over 25 minutes without finishing on Windows, and was stopped. Run it from a clean checkout with its output visible to find out whether it's slow or stuck. Don't skip the hook without the user's say-so.
2. Confirm `banyancode-ci` passes on GitHub.
3. Rebuild, then repeat the smoke test and the MCP delegation flow on the final commit.
4. Ask the user before the first npm canary (`dev` dist-tag). Needs `NPM_TOKEN`. Workflows are manual-dispatch only and default to dry run.
5. Cutover (confirm with the user first): rename `main` to `v1`, `v2-base` to `main`. Enable publish triggers then; a tag trigger must be `v[0-9]*`, because `v*` matched `v1-final` and started a bogus publish.

## Open questions and known differences from v1

- The MCP restart-recovery integration test failed once under heavy machine load, then passed in the full suite. Likely timing, not proven. Re-run on a quiet machine.
- `Ctrl-O` in `app-lifecycle` and `standalone server exits when its owner is killed` fail on this machine, with and without BanyanCode's plugins.
- Logins from `auth.json` are imported on first run even though the data decision was a fresh start: losing them seemed worse. Confirm with the user. Sessions and memory don't carry over.
- A dev build run outside the smoke test shares `banyancode` config and data folders with an installed v1. Its database and service are separate, but this hasn't been tested alongside a real v1 install.
- `goal`: `block` shows as paused (v2 has no blocked status); `--plan` and `--priority` are accepted but not stored.
- Codex usage: no in-adapter token refresh. Anthropic OAuth quota is ported, but v2 has no Anthropic OAuth integration, so it reports unsupported.
- `banyancode_reasoning_configuration_update` is accepted but not consulted, because v2 already does this; turning it off isn't reproduced.
- `session.background` was exposed to plugins, but the TUI hasn't been run by hand in a real terminal. Do that before the canary.
- Upstream plugins can read credentials through `integration.connection.resolve`. That is upstream's design, left as is.

## Working notes

- Bun 1.4.4 is required: `D:\BanyanCode-v2\spike-build\bun-1.4.4\bun-windows-x64`. The global install is 1.4.3.
- Checkouts: `D:\BanyanCode-v2` (work), `D:\BanyanCode-lead` (clean builds and hook runs), `D:\BanyanCode-baseline` (comparison, before the TUI plugin). Test a "pre-existing failure" claim against the baseline.
- Never kill `banyancode.exe` by image name: the installed v1 hosts the coders and the MCP connection. Stop by PID.
- `banyancode run` waits on stdin when it isn't a terminal: use `< /dev/null` in scripts.
- Keep test roots short on Windows (e.g. `D:\bct4`): deep paths fail snapshots with "Filename too long".
