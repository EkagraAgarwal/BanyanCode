# BanyanCode v2 migration: progress

Status at 2026-11-02. Plan: [v2-migration-plan.md](v2-migration-plan.md). Feature list: [v2-parity.md](v2-parity.md), gaps audit: [v2-parity-gaps.md](v2-parity-gaps.md), upstream edits: [v2-patches.md](v2-patches.md).

## Where things are

- `banyancode@latest` is `26.11.0`, with a stable GitHub release. Everyone who installs or upgrades now gets v2. The last v1 release is `26.10.9`.
- `v2-base` is on GitHub at the tagged commit and `banyancode-ci` passes. `main` is still v1, so the branch cutover has not happened.
- The publish workflow runs from a `v[0-9]*` tag. A push to `release-check` builds and packs all 12 platforms and publishes nothing; use it when the workflow changes. Dispatch needs the file on the default branch.

## How 26.11.0 was tested

- Real use in tmux on a native Linux build, using the harness in `D:\bct-h` (see its `TESTING.md`), compared against real v1 side by side. Three rounds of test agents reported into `D:\bct-h\reports`, and findings were reproduced before fixing.
- All packages' suites on Linux and Windows in `banyancode-ci`, and locally compared with the upstream base: the failures left there also fail on upstream (see below).
- Smoke test 18 of 18 on Linux, on a dev build and on a `latest`-channel build. On Windows, a real Claude Agent reply showed limits on the next plain read, and they survived a service restart.
- Service responsiveness while indexing large trees: median 40 ms, cancel 24 ms. Windows idle CPU about 2% of one core.

Not tested: macOS and Linux arm builds have never been run. Typing into the TUI on Windows has not been driven, because there is no tmux there: Windows was covered through the CLI, service, MCP and a real run.

## Next steps, in order

1. Ask the user before the cutover (rename `main` to `v1`, `v2-base` to `main`).
2. At cutover, add the `branches: ["dev"]` canary trigger and the preflight triggers.

## Open questions and known differences from v1

- Logins from `auth.json` are imported on first run even though the data decision was a fresh start: losing them seemed worse. Confirm with the user. Sessions and memory don't carry over.
- By default `mcp install` leaves delegated tasks unable to edit files, as v1 did. Keeping that default was a choice; `--permission edits` opts in.
- After an upgrade, a running older service keeps serving `banyancode run`: an rc.2 client used the rc.1 service. Upstream has a version-replace path (`checkVersion`) that `run` didn't take. Not tested through the TUI or `banyancode upgrade`.
- Each channel uses one fixed service port, so two homes on one machine can't both run the same channel: the second fails with a clear "port in use" error. Shared machines would hit this. Upstream design.
- npm warns that tokens bypassing 2FA are being restricted for direct publishing. Check `NPM_TOKEN` before the stable release.
- Windows binaries are unsigned: no Azure secrets are set.
- The MCP `serve-stdio` test timed out once in the full suite with about 1.5 GB of memory free, and passed 3 of 3 alone. Its first frame arrived past the 60 second limit. Likely load, not proven. CI doesn't run the MCP or TUI suites.
- `Snapshot > captures concurrently` and `treats capture outside Git`, `Ctrl-O` in `app-lifecycle` and `standalone server exits when its owner is killed` fail on this machine. The two snapshot tests also fail on the baseline.
- `goal`: `block` shows as paused (v2 has no blocked status); `--plan` and `--priority` are accepted but not stored.
- Codex usage: no in-adapter token refresh. Anthropic OAuth quota is ported, but v2 has no Anthropic OAuth integration, so it reports unsupported.
- `banyancode_reasoning_configuration_update` is accepted but not consulted, because v2 already does this; turning it off isn't reproduced.
- The snapshot budget covers the whole capture, so it defaults to 60 seconds where v1's 15 covered only the listing. Once exceeded, snapshots stop for that process.
- Upstream plugins can read credentials through `integration.connection.resolve`. That is upstream's design, left as is.

- The wire user agent stays `opencode/...`: the Copilot and OpenCode gateway integrations depend on it. The service's basic-auth user and cookie name are also still `opencode`.
- A configured `model` that doesn't exist falls back to the first available model without a warning, as upstream does. v1 failed with an error.
- A project-level `banyancode_telemetry` is ignored: telemetry is read from the global config only.
- Internal plugin RPC failures reach HTTP clients as a bare 500, `RPC call failed`. A read-only data folder only reports `Background service failed to start`. A busy service port takes about 20 seconds to report.
- The first run sends both `first_run` and `heartbeat` telemetry events.
- The update notice on the `dev` channel can offer an older build when the `dev` tag lags a local build.

## Working notes

- Bun 1.4.4 is required: `D:\BanyanCode-v2\spike-build\bun-1.4.4\bun-windows-x64`. The global install is 1.4.3.
- Checkouts: `D:\BanyanCode-v2` (work), `D:\BanyanCode-lead` (clean builds and pushes), `D:\BanyanCode-baseline` (comparison, before the TUI plugin). Test a "pre-existing failure" claim against the baseline.
- These checkouts have symlinks off, so `packages/app/src/custom-elements.d.ts` fails typecheck as a text file. `D:\BanyanCode-lead` has a real copy marked skip-worktree; push from there.
- Never kill `banyancode.exe` by image name: the installed v1 hosts the coders and the MCP connection. Stop by PID.
- Stop test services between runs: same-channel services share a port across test homes, and a leftover one looks like a broken build.
- `banyancode run` waits on stdin when it isn't a terminal: use `< /dev/null` in scripts.
- Keep test roots short on Windows (e.g. `D:\bct4`): deep paths fail snapshots with "Filename too long".
