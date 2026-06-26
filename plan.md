# Plan

**Last stable:** `d4db94f` (tag `last-stable`, branch `stable`). Based on `v4-baseline`. DeepSeek works out of the box; minimax needs a working API key in `~/.config/opencode/opencode.json`.

**Branch layout:**

| Branch | Purpose |
|---|---|
| `stable` | Working code. Use this. |
| `main` | Mirrors `stable`. |
| `v4-baseline` | Upstream reference for `stable`. |

**Tags:**

| Tag | Points to | Notes |
|---|---|---|
| `last-stable` | `d4db94f` | Working commit. |
| `backup-pre-cleanup` | `87e184f` | The 12 broken commits discarded from `main` before this cleanup. |
| `pre-tier3-baseline` | older tag | Untouched. |

**Known good:** run `bun run --cwd packages/opencode --conditions=browser src/index.ts`.

**Known broken:** the minimax key in `~/.config/opencode/opencode.json` returns `insufficient balance (1008)`. Replace the key or use DeepSeek.

**To bring back the 12 experimental commits:**

```bash
git checkout backup-pre-cleanup
git checkout -b experimental-restored
```

**Future work:** none planned. Add a `plan.md` section if/when needed.