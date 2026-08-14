# BanyanCode install telemetry (downloads, installs, active installations)

Status: approved for build, phased. Goal: measure adoption with minimal, non-invasive,
privacy-respecting telemetry. **Downloads ≠ installs ≠ active installations ≠ humans.**
Never claim direct human-user measurement.

## Metric contract (define before measuring)

| Metric | Definition | Where to look |
|---|---|---|
| `total_install_ids` | distinct install_ids ever seen | PostHog: Unique users (all time) |
| `new_install_ids` | first-ever ping (`banyan_install`) within period | PostHog: New users (period) |
| `active_install_ids` | `banyan_heartbeat` within period (Phase 3) | PostHog: Unique users filtered to `banyan_heartbeat` (period) |
| `ci_install_ids` / `non_ci_install_ids` | split on `ci` property | Any insight filtered by `ci == true/false` |
| `estimated_human_installs` | ≈ non-CI unique installs — installation-level estimate, NOT a human count | `non_ci_install_ids` |

## Transport decision (2026-08-14): PostHog cloud, no server required

The client sends events **directly to PostHog's cloud capture endpoint**
(`https://us.i.posthog.com/i/v0/e/`, free tier) using the project API key baked into the
binary at build time. **No server, no DNS, no worker deployment is required** — PostHog
hosts the collector and the dashboard. This is the default transport.

- `distinct_id` = the client's `install_id` (random UUID) → PostHog counts unique installs,
  new installs, and (with heartbeat) active installs out of the box.
- Events: `banyan_install` (first run) and `banyan_heartbeat` (weekly). Properties:
  `version`, `channel`, `os`, `arch`, `install_method`, `ci`.
- Key resolution: `BANYANCODE_POSTHOG_KEY` env (runtime, for dev) → baked build-time value
  (`packages/opencode/script/build.ts` `define`, same mechanism as `OPENCODE_CHANNEL`).
  Project API keys are public-by-design (client-safe); do NOT bake project SECRET keys.
  The define uses the dotted form `"process.env.BANYANCODE_POSTHOG_KEY"` — bare-key
  defines do not replace `process.env` member expressions in Bun.build.
- Custom endpoint (`BANYANCODE_TELEMETRY_ENDPOINT` → `POST {endpoint}/ping`) remains
  available as an alternative transport for self-hosters (see `worker/telemetry/`).
- No key AND no custom endpoint → telemetry is a silent no-op (never marks attempts).
- Privacy contract unchanged: no hostname, username, path, project/model/prompt data,
  MAC/device identifiers. PostHog is configured server-side to not store IPs (or the
  capture key's IP capture is disabled in project settings).

### Checking your numbers (no server — PostHog dashboard)

- **Unique installs (cumulative):** Insights → Trend → Events `banyan_install` → Unique users.
- **New installs per week:** Insight → "New users" over `banyan_install`.
- **Active installs (weekly):** Insight → Events `banyan_heartbeat` → Unique users over
  a 7-day rolling window.
- **Human estimate:** add a filter `ci == false` to any insight.
- **Per-version adoption:** group by `version` property.

## Phase 0 — Download counting (DONE: `script/banyan-stats.ts` + `banyan-stats.yml`)

- npm umbrella + SUM of the 11 per-platform packages + GitHub release-asset counts,
  appended daily to `STATS.md`; PostHog `banyan_download` events (source:
  github/npm/npm_binary). Trend signal only — not unique installs.

## Phase 1 — First-run ping (DONE: `packages/opencode/src/installation/telemetry.ts`)

- `~/.local/state/banyancode/install.json` (global, channel-independent):
  `{ install_id, telemetry: { last_attempt, last_success, last_heartbeat } }`.
- State machine: no file → first-ever; no `last_success` + stale `last_attempt` (>24h) →
  retry; `last_success` → never again. Attempt ≠ observed (file written before request).
- Payload ≤ 200 bytes: `{ install_id, version, channel, os, arch, install_method, ci }`;
  `install_method` normalized to `npm | pnpm | bun | homebrew | standalone | source | unknown`
  (from `probe.ts`), never raw probe output.
- Wired in `cli/cmd/run.ts` after `ensureBanyanDirs`; dynamic import; 3s timeout; silent
  failure; one-line first-run notice on first ping.

## Phase 2 — Consent (DONE)

- `banyancode_telemetry: "on" | "off"` (default on) in `BanyanConfig.Info`; env
  `BANYANCODE_TELEMETRY=off`; honor `DO_NOT_TRACK=1`; `banyancode telemetry status|on|off`.

## Phase 3 — Active installations (SHIPPED: weekly heartbeat)

- `banyan_heartbeat` event, cadence 7 days (`last_heartbeat` in install.json), gated on:
  telemetry enabled AND the install has a `last_success` (never heartbeat a first-run that
  never observed).
- Fired from the same `run.ts` dynamic-import hook as the first-run ping.
- Gives `active_install_ids` (weekly active installs) and `returning_install_ids`
  (heartbeat in current window AND a heartbeat in the previous window).
- No new payload fields; same 200-byte posture.

## Shipped (Phase 3A)

1. `telemetry.ts` (`packages/opencode/src/installation/telemetry.ts`): `PingPayload`
   carries `event_type: "first_run" | "heartbeat"`; `InstallTelemetryState` gained
   `last_heartbeat` (backward-compatible parse); `shouldHeartbeat(identity, now)` — 7-day
   cadence gated on `last_success` (never heartbeat an unobserved install); `heartbeat()`
   orchestrator: consent → transport-availability → identity/`shouldHeartbeat` → send →
   write `last_heartbeat` only on success (no `last_attempt` field for heartbeat).
2. Transport switch in `ping()`: PostHog capture default
   (`https://us.i.posthog.com/i/v0/e/`, body `{ api_key, distinct_id: install_id, event:
   banyan_install | banyan_heartbeat, properties }`, 3s timeout) when
   `BANYANCODE_POSTHOG_KEY` resolves → custom `{endpoint}/ping` fallback (payload now
   includes `event_type` — fixes the worker protocol mismatch) → silent no-op
   (`PingOutcome` gained `"noop"`) when neither key nor endpoint.
3. `buildPayload` takes an `event_type` param (default `"first_run"`).
4. `script/build.ts` define: `"process.env.BANYANCODE_POSTHOG_KEY"` baked from env,
   default `""`.
5. `cli/cmd/run.ts` fires `heartbeat()` alongside `pingOnFirstRun()`.
6. Tests: 37 pass (`test/installation/telemetry.test.ts`): heartbeat gating/cadence,
   PostHog capture shape, no-key-no-endpoint noop, `event_type` in payload.

### User action (post-ship)

- Create PostHog project → set project API key when building/canary
  (`BANYANCODE_POSTHOG_KEY`) → dashboard queries above. `worker/telemetry/` remains the
  optional self-host path.

## Phase 3B (self-host worker) — partially shipped

- `.github/workflows/deploy-telemetry.yml` exists (manual dispatch + main push touching
  `worker/telemetry/**`; needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; runs
  `wrangler deploy` then applies `schema.sql`).
- Worker ships a `scheduled` cron (daily 03:00 UTC) enforcing 365-day retention
  (`worker/telemetry/src/index.ts`, `[triggers]` in `wrangler.toml`).
- D1 binding still commented out in `wrangler.toml` — create the database and uncomment
  the binding before first deploy (user action). Worker NOT yet deployed.

## Order

1. Phase 0 (DONE) → 2. Phase 1 (DONE) → 3. Phase 2 (DONE) → 4. Phase 3 (SHIPPED)
