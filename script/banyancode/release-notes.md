BanyanCode now runs on the OpenCode v2 architecture.

**Your data starts fresh.** Sessions, project memory and settings stored in the old database don't carry over. Your provider logins do, imported from `auth.json` on first run. The old data stays on disk.

**Removed:** cross-session memory, including its tools and commands.

**New:** `banyancode mcp install` connects Claude Code, Codex and other harnesses, which can delegate work to BanyanCode and check on it with `banyan_checkup`.

**Differences from the previous version:**

- `goal block` shows as paused, and `goal set --plan` and `--priority` are accepted but not stored.
- Anthropic OAuth quota reports as unsupported.
- `banyancode_reasoning_configuration_update` is accepted but has no effect.
- Long snapshots now stop after 60 seconds by default. Set `BANYANCODE_SNAPSHOT_LIST_TIMEOUT_MS` to change this.
