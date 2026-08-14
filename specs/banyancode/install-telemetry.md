# BanyanCode install telemetry (downloads, installs, active installations)

Status: approved for build, phased. Goal: measure adoption with minimal, non-invasive,
privacy-respecting telemetry. **Downloads ≠ installs ≠ active installations ≠ humans.**
Never claim direct human-user measurement.

## Metric contract (define before measuring)

| Metric | Definition |
|---|---|
| `total_install_ids` | distinct install_ids ever seen |
| `new_install_ids` | first-ever ping (`first_run` event) within period |
| `active_install_ids` | `heartbeat` event within period (Phase 3) |
| `ci_install_ids` / `non_ci_install_ids` | split on `ci` flag |
| `estimated_human_installs` | ≈ non-CI unique installs — installation-level estimate, NOT a human count |

## Phase 0 — Download counting (CI-only, ship first)

- New BanyanCode stats script (model after `script/stats.ts:52-95`):
  - `api.npmjs.org/downloads/point/last-month/banyancode` (umbrella)
  - SUM of the 10 per-platform packages (`banyancode-linux-x64`, `banyancode-darwin-arm64`,
    ...) — approximates real binary installs better than the umbrella count
  - GitHub release-asset `download_count` from `api.github.com/repos/EkagraAgarwal/BanyanCode/releases`
- PostHog event mirroring `script/stats.ts:3-29,204-212` (`POSTHOG_KEY` secret, `distinct_id: "download"`).
- Workflow `.github/workflows/<name>.yml`: daily cron, gated on `EkagraAgarwal/BanyanCode`.
- Output appended to `STATS.md` in the BanyanCode repo. Establishes the historical baseline
  before client telemetry exists.

## Phase 1 — First-run ping (unique installs)

### Install identity file (global, channel-independent)

`~/.local/state/banyancode/install.json` (deliberately NOT per-channel DB — the ID must
survive canary/stable switches and npm upgrades; same global-state precedent as `session.json`):

```json
{
  "install_id": "uuid",
  "telemetry": { "last_attempt": "ISO8601", "last_success": "ISO8601" }
}
```

State machine (distinguish "attempted" from "server observed"):
- no file → first-ever install; generate `install_id = crypto.randomUUID()` (random, never MAC-derived)
- file without `last_success` → retry, capped at once per 24h via `last_attempt`
- `last_success` set → never ping again

### Payload (≤ 200 bytes)

```json
{
  "install_id": "...",
  "version": "...",      // InstallationVersion (build-baked)
  "channel": "...",      // InstallationChannel
  "os": "...", "arch": "...",
  "install_method": "npm | pnpm | bun | homebrew | standalone | source | unknown",
  "ci": true
}
```

`install_method` MUST be normalized into the stable enum above (mapped from
`packages/opencode/src/installation/probe.ts` `findAllBanyanCodeInstalls`, `:122-222`)
before sending. Never ship raw probe output.

### Privacy guarantees (enforced contract, documented in the module)

No hostname. No username. No filesystem path. No IP persistence (edge discards source IP).
No repo/project path. No model/provider info. No prompt/tool contents. No MAC/device identifiers.

### Wiring

- New module `packages/opencode/src/installation/telemetry.ts`.
- Fired from `cli/cmd/run.ts` after `ensureBanyanDirs` (`:241`), dynamic import to keep
  cold start fast; only on real runs (not `--version` / help).
- 3s timeout, silent failure, debug-level log only. Never blocks startup, never retries
  in-process (retry = next run).

### Endpoint (Cloudflare Worker + KV/D1)

Event-appendable schema — `install_id` is NOT the PK:

```
install_events(
  event_id TEXT PK,
  install_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'first_run' | 'heartbeat'
  timestamp INTEGER NOT NULL,
  version TEXT, channel TEXT,
  os TEXT, arch TEXT,
  install_method TEXT,
  ci INTEGER
)
```

First-seen installs = distinct `install_id` over `first_run` rows (unique index on
`(install_id, event_type)`). Source IP discarded at the edge. 365-day retention. Future
event types require no migration.

## Phase 2 — Consent (Homebrew model: on by default, easy opt-out)

- `banyancode_telemetry: "on" | "off"` in `BanyanConfig.Info`
  (`packages/core/src/v1/config/banyan-config.ts`), default `"on"`.
- Env override `BANYANCODE_TELEMETRY=off`; honor `DO_NOT_TRACK=1`.
- One-line first-run notice in CLI.
- Optional `banyancode telemetry status|on|off` subcommand.

## Phase 3 — Active installations (future, only if Phase 0-2 metrics prove worth keeping)

- Weekly heartbeat → `active_install_ids`, `returning_install_ids`.
- Same worker endpoint, zero new payload fields, same `install_events` table
  (`event_type = 'heartbeat'`).

## Order

1. Phase 0 (historical baseline before telemetry exists)
2. Phase 1 (anonymous UUID ping)
3. Phase 2 (opt-out + DO_NOT_TRACK)
4. Phase 3 only if the install metric is worth maintaining
