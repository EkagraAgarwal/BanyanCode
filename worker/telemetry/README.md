# BanyanCode install telemetry — Cloudflare Worker

Anonymous install telemetry endpoint per `specs/banyancode/install-telemetry.md` (Phase 1 + the
Phase 3 `heartbeat` event type). Server-side only; the client (Phase 1 module in
`packages/opencode/src/installation/telemetry.ts`) is NOT part of this directory.

This directory is intentionally OUTSIDE the `packages/*` workspace globs in the root
`package.json` — it is not a workspace member, does not touch `bun.lock`, and deploys
standalone with `wrangler`.

## Endpoints

| Route | Method | Behavior |
|---|---|---|
| `/ping` | POST | Validate payload (≤ 300 bytes body), upsert one row per `(install_id, event_type)`, respond `204`. 400 on invalid payload, 413 on oversized body. |
| `/stats?from=<ISO>&to=<ISO>` | GET | Aggregate metric contract as JSON. `from`/`to` optional; when omitted the range is all-time. Half-open `[from, to)` in epoch-ms. |
| `/health` | GET | `200 { "ok": true }` |
| (any) | OPTIONS | CORS preflight, `204` |

`/stats` returns the metric contract from the spec:

```json
{
  "total_install_ids": 0,
  "new_install_ids": 0,
  "active_install_ids": 0,
  "ci_install_ids": 0,
  "non_ci_install_ids": 0
}
```

Definitions (per `specs/banyancode/install-telemetry.md`):

- `total_install_ids` — distinct `install_id` ever seen (all-time).
- `new_install_ids` — distinct `install_id` over `first_run` rows in the window. The client
  state machine fires `first_run` exactly once per install, so the upserted `first_run`
  timestamp is the first-seen time in practice.
- `active_install_ids` — distinct `install_id` over `heartbeat` rows in the window.
- `ci_install_ids` / `non_ci_install_ids` — window-scoped distinct `install_id` split on the
  `ci` flag (`ci = 1` vs `ci = 0` or NULL).

CORS: `Access-Control-Allow-Origin: *` is intentionally wide open. This is an anonymous
aggregate stats API — no credentials, no cookies, nothing to exfiltrate. If this ever serves
authenticated data, tighten it.

## Client contract

The client POSTs to `{ENDPOINT}/ping` (e.g. `https://banyancode-telemetry.<account>.workers.dev/ping`):

```json
{
  "install_id": "uuid",
  "event_type": "first_run",
  "version": "26.08.1",
  "channel": "latest",
  "os": "darwin",
  "arch": "arm64",
  "install_method": "npm",
  "ci": false
}
```

- `install_id` (required, non-empty string, ≤ 64 chars) and `event_type` (`first_run` |
  `heartbeat`, required) — anything else is a `400`.
- `version` / `channel` / `os` / `arch` optional strings, clamped to 64 chars.
- `install_method` optional string, clamped to 32 chars. Stored **as-is** — the client MUST
  normalize into the stable enum (`npm | pnpm | bun | homebrew | standalone | source | unknown`)
  before sending; the worker does not re-map it.
- `ci` optional boolean.
- Body must be ≤ 300 bytes (`413` otherwise).

## Deploy

```bash
# 1. Create the D1 database (once)
wrangler d1 create banyancode-telemetry-db
#    → prints a database_id; paste it into wrangler.toml under [[d1_databases]]

# 2. Apply the schema (remote)
bun run db:init
#    or: wrangler d1 execute banyancode-telemetry-db --remote --file schema.sql
#    (local dev: replace --remote with --local)

# 3. Deploy the worker
bun run deploy
#    or: wrangler deploy
```

`[[d1_databases]]` in `wrangler.toml` ships commented out — uncomment it and fill in the
`database_id` printed by step 1 before deploying.

### CI deploy

`.github/workflows/deploy-telemetry.yml` deploys on `main` pushes touching
`worker/telemetry/**` or via `workflow_dispatch`. Requires the `CLOUDFLARE_API_TOKEN`
(account-scoped, Workers Scripts:Edit + D1:Edit) and `CLOUDFLARE_ACCOUNT_ID` secrets;
it runs `wrangler deploy` then applies `schema.sql` to the remote D1. Complete step 1
(create the D1 database + uncomment the binding) before the first CI run.

## Retention policy (365 days) — implemented

The spec mandates 365-day retention, and the worker now enforces it automatically. The
default export ships a `scheduled` handler (`src/index.ts`) wired to a daily 03:00 UTC cron
(`[triggers]` in `wrangler.toml`). On each trigger it deletes rows older than 365 days:

```ts
await env.DB.prepare("DELETE FROM install_events WHERE timestamp < ?")
  .bind(Date.now() - RETENTION_MS)
  .run()
```

No manual wrangler command is needed — deploy with `wrangler deploy` (or the CI workflow)
and the cron is registered with the worker.

As an alternative, a one-off purge can be run manually via wrangler:

```bash
wrangler d1 execute banyancode-telemetry-db --remote \
  --command "DELETE FROM install_events WHERE timestamp < $(($(date +%s%3N) - 31536000000));"
```

## Privacy posture

- The worker never reads, logs, or stores the client IP (`CF-Connecting-IP` is never
  consulted) or any request header beyond the payload fields.
- No cookies, no user-agent persistence, no filesystem paths, no hostname, no MAC/device IDs.
- The only header inspected is `Content-Length` for an early 413; it is not persisted.
- D1 rows contain only the payload fields plus a server-assigned `event_id`, a server
  `timestamp`, and the `(install_id, event_type)` uniqueness key.
- These metrics are installation-level counts, NOT human-user counts (spec: "Downloads ≠
  installs ≠ active installations ≠ humans").
