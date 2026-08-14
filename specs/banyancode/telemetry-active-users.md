# BanyanCode telemetry plan — active users, unique installs, unique downloads

Status: new plan superseding the phased status of `install-telemetry.md` (Phase 3 now
shipped — see Verified progress below).
Goal: measure **active users** (heartbeat) and **unique downloads / installations**
(distinct install_ids). Verified against the working tree on 2026-08-14.

## Metric contract (unchanged from install-telemetry.md)

| Metric | Definition | Source |
|---|---|---|
| `total_install_ids` | distinct install_ids ever seen (`first_run`) | PostHog Unique users, all-time |
| `new_install_ids` | first-ever ping within period | PostHog New users (period) |
| `active_install_ids` | `heartbeat` within period | PostHog Unique users on `banyan_heartbeat` |
| `returning_install_ids` | heartbeat in current AND previous window | PostHog query |
| `ci_install_ids` / `non_ci_install_ids` | split on `ci` property | any insight filtered by `ci` |
| `estimated_human_installs` | ≈ non-CI unique installs (installation-level, NOT humans) | `non_ci_install_ids` |

**Unique downloads ≠ download counts.** npm and GitHub APIs only expose aggregate
counts (no unique downloaders). The ONLY unique-install signal is `install_id` from the
client. Download counts stay a trend signal (`banyan_download`); unique numbers come from
`first_run` / `heartbeat` events.

## Verified progress (2026-08-14)

| Phase | Status | Evidence |
|---|---|---|
| Phase 0 — download counts | SHIPPED | `script/banyan-stats.ts` + `.github/workflows/banyan-stats.yml` (daily 12:00 UTC cron): appends `STATS.md`, posts `banyan_download` (github / npm / npm_binary) to PostHog with `POSTHOG_KEY` |
| Phase 1 — first-run ping | SHIPPED | `packages/opencode/src/installation/telemetry.ts` `pingOnFirstRun()`; `install.json` state machine (`last_attempt`/`last_success`); wired at `cli/cmd/run.ts:244` |
| Phase 2 — consent | SHIPPED | `banyancode_telemetry` config key; `banyancode telemetry status\|on\|off` CLI; `BANYANCODE_TELEMETRY=off`; `DO_NOT_TRACK=1` |
| Phase 3A — heartbeat + PostHog transport | SHIPPED | `PingPayload.event_type` (`first_run` \| `heartbeat`); `shouldHeartbeat` + `heartbeat()`; `last_heartbeat` state; PostHog capture default (`BANYANCODE_POSTHOG_KEY` define, dotted `"process.env.BANYANCODE_POSTHOG_KEY"`); custom-endpoint fallback now carries `event_type`; `"noop"` when neither. 37 tests pass (`test/installation/telemetry.test.ts`) |
| Phase 3B — worker deploy | PARTIAL | `.github/workflows/deploy-telemetry.yml` (manual dispatch + main push; `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`); `scheduled` cron (daily 03:00 UTC) 365-day retention (`worker/telemetry/src/index.ts`, `[triggers]`); D1 binding still commented — NOT deployed |
| Phase 4 — reporting | DECIDED | PostHog Query API (HogQL) primary — `POST https://us.posthog.com/api/projects/{project_id}/query/`, `Authorization: Bearer <PERSONAL_API_KEY>`, free tier; worker `/stats` fallback; both retention windows cap all-time unique installs at ~12 months → running-sum accumulation of weekly `new_install_ids` in `STATS.md` is retention-immune |

## Gaps found in the audit

1. **Client↔worker protocol mismatch.** Client `PingPayload` has no `event_type` field;
   worker `/ping` REQUIRES `event_type ∈ {first_run, heartbeat}` and rejects anything else
   with 400. A deployed worker would reject every client ping today. → **FIXED** —
   `PingPayload` now carries `event_type`; the worker accepts it.
2. **Transport decision not implemented.** Spec says PostHog capture is the default
   transport; client still defaults to the custom endpoint (`TELEMETRY_ENDPOINT` →
   `https://telemetry.banyan.dev`). `build.ts` has no `BANYANCODE_POSTHOG_KEY` define.
   → **FIXED** — PostHog capture is the default transport; `build.ts` defines
   `"process.env.BANYANCODE_POSTHOG_KEY"` (dotted form).
3. **Worker not deployed.** D1 binding commented, no wrangler deploy workflow, no CI.
   → **OPEN** — deploy workflow + retention cron ship, but the D1 binding is still
   commented; first deploy awaits user action.
4. **`banyan_download` cannot measure uniqueness.** Uses static `distinct_id: "download"`,
   so PostHog unique users = 1 forever. Accept as trend-only; do not spend effort making it
   unique.
5. **No heartbeat ⇒ `active_install_ids` is always 0.** Active-users metric cannot exist
   until Phase 3 ships. → **FIXED** — heartbeat ships; `active_install_ids` is measurable.

## Plan (remaining work, ordered)

### Phase 3A — client heartbeat + PostHog transport (DONE — kept as shipped record)

1. `telemetry.ts`: add `event_type: "first_run" | "heartbeat"` to the payload; add
   `last_heartbeat` to `InstallTelemetryState` (keep `readInstallIdentity` backward
   compatible); add pure `shouldHeartbeat(identity, now)` (7-day cadence, gated on
   `last_success` — never heartbeat an install whose first ping never observed) and
   `heartbeat()` orchestrator mirroring `pingOnFirstRun`.
2. Transport switch: default transport = PostHog capture
   (`https://us.i.posthog.com/i/v0/e/`, `api_key` = baked key, `distinct_id` =
   `install_id`, `event` = `banyan_install` / `banyan_heartbeat`); fallback = custom
   endpoint (`BANYANCODE_TELEMETRY_ENDPOINT` → `POST {endpoint}/ping`). No key AND no
   endpoint → silent no-op. Key resolution: `BANYANCODE_POSTHOG_KEY` env → baked
   build-time define.
3. `script/build.ts`: add `BANYANCODE_POSTHOG_KEY` to the `define` block (default `""`),
   same mechanism as `OPENCODE_CHANNEL`.
4. `cli/cmd/run.ts`: fire `heartbeat()` alongside `pingOnFirstRun()` in the same
   dynamic-import hook.
5. Tests (`telemetry.test.ts`): PostHog capture shape (URL, body, `distinct_id`, `event`,
   properties), `event_type` present, no-key no-op, heartbeat cadence, heartbeat gating on
   `last_success`, backward-compatible `last_heartbeat` read.
6. Typecheck (core/opencode), run `telemetry.test.ts`. SDK regen NOT required (no schema
   change).

### Phase 3B — worker deploy (SKIPPED — PostHog-only transport)

7. ~~Create D1 database, apply `schema.sql`, uncomment the `[[d1_databases]]` binding.~~
   → **SKIPPED 2026-08-14** — the self-host Cloudflare worker is not deployed; PostHog
   cloud is the sole transport. `worker/telemetry/` source remains in-tree as an
   optional self-host reference but is out of scope for this effort.
8. ~~Add a deploy workflow + retention cron.~~ → **REVERTED 2026-08-14** —
   `deploy-telemetry.yml`, the `scheduled` retention cron, and the `[triggers]` entry
   were removed with the Cloudflare skip.

### Phase 4 — measurement & reporting

9. PostHog dashboard queries (documented in this spec, from `install-telemetry.md`):
   unique installs (`banyan_install` unique users), new per week, active (`banyan_heartbeat`
   unique users, 7-day window), `ci == false` human estimate, per-version adoption.
   → **DONE** — the dashboard query table below is the shipped record.

   | Dashboard insight | PostHog setup |
   |---|---|
   | Unique installs (all-time) | Trend → event `banyan_install` → Unique users |
   | New installs per week | Trend → `banyan_install` → New users, weekly interval |
   | Active installs (weekly) | Trend → `banyan_heartbeat` → Unique users, 7-day rolling window |
   | Human estimate | Any insight above + filter `ci == false` |
   | Per-version adoption | Trend → `banyan_install` → Unique users → group by `version` |
   | Returning installs | Trend → `banyan_heartbeat` → Unique users, current window, AND `banyan_heartbeat` in previous window (funnel or insight with both steps) |

10. Optional weekly report job: `script/banyan-stats.ts` extended to also POST
    `banyan_download` + `banyan_install` + `banyan_heartbeat` aggregate rows to
    `STATS.md` (trend + unique side by side). → **IN BUILD** — `banyan-stats.ts`
    extension in flight: PostHog Query API (HogQL) primary with
    `BANYANCODE_POSTHOG_PROJECT_ID` + `BANYANCODE_POSTHOG_PERSONAL_KEY` envs; worker
    `/stats` fallback via `BANYANCODE_TELEMETRY_STATS_URL`; retention-drift running-sum
    column in `STATS.md` (accumulation is retention-immune).
11. User action: create PostHog project, copy project API key, set it for builds/canaries
    (`BANYANCODE_POSTHOG_KEY`) and `POSTHOG_KEY` secret for the stats workflow.
    → **OPEN (user action)** — also set `BANYANCODE_POSTHOG_PROJECT_ID` +
    `BANYANCODE_POSTHOG_PERSONAL_KEY` for the weekly report.

## Definition of done

- A fresh install emits `banyan_install` once, then `banyan_heartbeat` weekly (when
  enabled and after first success).
- PostHog dashboard shows: unique installs (all-time), new installs/week, active
  installs/week, CI split, per-version adoption (ready to query once keys are set).
- `STATS.md` shows daily download trends; unique numbers come from install events only.
- `banyancode telemetry status` reflects the same state machine the events use.

## Order

1. Phase 3A (unblocks active users + unique installs) → 2. Phase 4 step 9 (dashboards) →
3. Phase 3B (self-host endpoint, optional) → 4. Phase 4 step 10 (weekly report, optional).
