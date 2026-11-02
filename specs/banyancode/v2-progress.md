# BanyanCode v2 migration: progress

Status at 2026-11-02. Plan: [v2-migration-plan.md](v2-migration-plan.md). Feature list: [v2-parity.md](v2-parity.md), gaps audit: [v2-parity-gaps.md](v2-parity-gaps.md), upstream edits: [v2-patches.md](v2-patches.md).

## Where things are

- `banyancode@next` is `26.11.0-rc.2`, with a GitHub prerelease. `banyancode@latest` is still v1 (`26.10.9`), so existing users are unaffected.
- `v2-base` is on GitHub at the tagged commit and `banyancode-ci` passes. `main` is still v1.
- The publish workflow runs from a `v[0-9]*` tag. A push to `release-check` builds and packs all 12 platforms and publishes nothing; use it before tagging. Dispatch only works once the workflow is on the default branch.

## Verified on rc.2, installed from npm on Windows x64

- Smoke test: 18 of 18.
- A real AI session, with logins imported from `auth.json`.
- MCP delegation with `--permission edits`: disconnect mid-task, reconnect, checkups, permission replies, file written, `files_changed` 1.
- Approving under the default reject policy returns a clear error and writes nothing.
- `mcp install --permission edits` writes the policy into the client config, and refuses `yolo`.
- The TUI starts and draws in a real terminal (rc.1 code on a dev build). It has not been used by hand: no typing, dialogs or a full session.
- Linux and macOS builds were packed and published but never run.

## Next steps, in order

1. Try the TUI by hand: `npm install -g banyancode@next`. Note this replaces the installed v1, which also hosts the current MCP connection; use `--prefix` to keep them apart.
2. Ask the user before each of these: tag `v26.11.0` (moves `latest`, so every v1 user moves to v2 with a fresh start), and the cutover (rename `main` to `v1`, `v2-base` to `main`).
3. At cutover, add the `branches: ["dev"]` canary trigger and the preflight triggers.

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

## Working notes

- Bun 1.4.4 is required: `D:\BanyanCode-v2\spike-build\bun-1.4.4\bun-windows-x64`. The global install is 1.4.3.
- Checkouts: `D:\BanyanCode-v2` (work), `D:\BanyanCode-lead` (clean builds and pushes), `D:\BanyanCode-baseline` (comparison, before the TUI plugin). Test a "pre-existing failure" claim against the baseline.
- These checkouts have symlinks off, so `packages/app/src/custom-elements.d.ts` fails typecheck as a text file. `D:\BanyanCode-lead` has a real copy marked skip-worktree; push from there.
- Never kill `banyancode.exe` by image name: the installed v1 hosts the coders and the MCP connection. Stop by PID.
- Stop test services between runs: same-channel services share a port across test homes, and a leftover one looks like a broken build.
- `banyancode run` waits on stdin when it isn't a terminal: use `< /dev/null` in scripts.
- Keep test roots short on Windows (e.g. `D:\bct4`): deep paths fail snapshots with "Filename too long".
