# Goal

(verbatim) add an auto update feature like the upstream opencode that checks for the latest version on startup and auto installs it. it should use the latest stable build if its on a stable build and the absolute latest build (dev or stable, whichever is newer) if its on dev.

## Findings (investigation complete)

The startup auto-update plumbing already exists (mirrors upstream opencode):

- **Startup check:** `packages/opencode/src/cli/cmd/tui.ts:194-196` fires `checkUpgrade` 1s after TUI boot → `packages/opencode/src/cli/tui/worker.ts:52-55` → `packages/opencode/src/cli/upgrade.ts` `upgrade()`.
- **Decision + install:** `cli/upgrade.ts` skips on `config.autoupdate === false` / `OPENCODE_DISABLE_AUTOUPDATE`; emits `installation.update-available` (notify) or auto-runs `Installation.upgrade(method, latest)` when the release kind is `patch`.
- **Latest resolution:** `packages/opencode/src/installation/index.ts:235-291` `Installation.latest(method)` — for npm/bun/pnpm it queries `registry/banyancode/${InstallationChannel}` (the build-time channel dist-tag ONLY).
- **TUI surface:** `packages/tui/src/app.tsx:1172-1218` shows an "Update Available" dialog on the event and calls `sdk.client.global.upgrade({ target })` → `handlers/global.ts:126-156`.
- **Canary-aware comparison** exists only in the manual command: `packages/opencode/src/cli/cmd/upgrade.ts` `shouldSkipUpgrade` + `canonical()` (npm drops the leading zero: `26.07.4` → `26.7.4`), tested in `packages/opencode/test/cli/upgrade.test.ts`.

Gaps versus the user's ask:

1. **No channel-aware "absolute latest".** On the `dev` channel, `latest()` only reads the `dev` dist-tag — it never considers the stable `latest` tag, so a dev user is not told about (and never auto-installs) a newer stable build, and there is no "whichever is newer" logic. On stable the behavior is already correct (queries `latest` tag).
2. **Startup check version comparison is broken by npm leading-zero stripping.** Baked `InstallationVersion` is `26.07.4`; the npm registry returns `26.7.4`. `cli/upgrade.ts:26` does raw `===`, which never matches → the check always proceeds (re-runs `npm install -g banyancode@26.7.4` every startup even when current) and `getReleaseType` compares un-normalized strings.
3. **Dev channel auto-install is gated by the stable-channel patch rule.** `cli/upgrade.ts:30` only auto-installs `patch` releases; canary consumers should always auto-follow the absolute latest (dev cadence). Stable keeps the upstream patch-only gate + `"notify"` semantics.

No HTTP route/schema changes → no SDK regeneration needed. Headless `run`/`serve` startup is intentionally out of scope (matches upstream, which only checks in the TUI).

## Steps

1. **Version comparison helpers (`packages/opencode/src/installation/compare.ts`, new):** move `canonical()`/`canonicalVersion` and `shouldSkipUpgrade` out of `cli/cmd/upgrade.ts` into a pure, exported module; add:
   - `resolveAbsoluteLatest(devTag, latestTag)` — pure decision: returns `devTag` unless the stable tag's numeric core (strip `-dev.*` / prerelease suffix) is STRICTLY greater than the dev tag's core; on equal base prefer the canary (dev users follow the dev branch). Handles `undefined` fallbacks (one fetch failed).
   - Re-export from `installation/index.ts` (`export { ... } from "./compare"`); keep `shouldSkipUpgrade` importable from `cli/cmd/upgrade.ts` via re-export so the existing test keeps passing (or update the test import — either is fine, keep it consistent).
2. **Channel-aware `latest()` (`packages/opencode/src/installation/index.ts`):** for npm/bun/pnpm, when `InstallationChannel === "dev"`, fetch BOTH the `dev` and `latest` dist-tags (Effect.all, tolerate one failing) and return `resolveAbsoluteLatest(...)`. All other channels/methods keep today's behavior (stable-only sources: curl/brew/choco/scoop/GitHub unchanged).
3. **Startup check (`packages/opencode/src/cli/upgrade.ts`):**
   - Replace raw `InstallationVersion === latest` with the normalized `shouldSkipUpgrade(InstallationVersion, latest)` (handles `26.07.4` vs `26.7.4` AND same-base different-sha canaries).
   - Pass canonicalized versions to `getReleaseType`.
   - Extract a pure decision helper `shouldAutoInstall(channel, kind, autoupdate)` → `true` when `kind === "patch"` OR channel is dev (dev always auto-follows); `false` when `autoupdate === "notify"`; exported for tests.
4. **Tests:**
   - `packages/opencode/test/installation/compare.test.ts` (new): `resolveAbsoluteLatest` matrix — dev newer (canary wins), stable strictly newer (stable wins), equal base (canary wins), leading-zero forms (`26.08.11-dev.x` vs `26.8.11`), one-undefined fallback; `shouldSkipUpgrade` regression cases from `cli/upgrade.test.ts` still pass after the move.
   - `packages/opencode/test/installation/installation.test.ts`: assert non-dev `latest("npm")` still queries only `.../banyancode/${InstallationChannel}` (existing tests already cover; keep green).
   - `packages/opencode/test/cli/upgrade.test.ts`: add `shouldAutoInstall` cases — stable+patch installs, stable+minor notifies, dev+minor installs, `"notify"` never installs; add startup equality case (baked `26.07.4` vs registry `26.7.4` → skip).
5. **Verification:** `bun typecheck` and `bun test` in `packages/opencode` (run `test/installation/`, `test/cli/upgrade.test.ts`); also run `packages/tui` typecheck (no TUI edits expected — confirm none needed).

## Exit criteria

Reviewer judges **pass** when ALL hold:

1. `Installation.latest("npm"|"bun"|"pnpm")` on the `dev` channel fetches BOTH dist-tags and returns the absolute newest per `resolveAbsoluteLatest` (dev wins on equal base; stable wins only when its core is strictly greater); all other channels/methods unchanged (existing tests still pass).
2. `resolveAbsoluteLatest` is a pure exported function with unit tests covering: dev newer, stable strictly newer, equal base → dev, leading-zero equivalence (`26.08.11-dev.x` vs `26.8.11`), and single-fetch-failure fallback.
3. `cli/upgrade.ts` uses `shouldSkipUpgrade` (normalized equality) instead of raw `===` — a baked `26.07.4` vs registry `26.7.4` skips the upgrade; same-base different-sha canaries proceed.
4. `cli/upgrade.ts` auto-installs for dev channel regardless of release kind (unless `autoupdate === "notify"` or `false`); stable channel keeps the patch-only gate + notify semantics. The decision lives in a pure exported `shouldAutoInstall(channel, kind, autoupdate)` with unit tests.
5. No regressions: `bun typecheck` passes in `packages/opencode`; `bun test` passes for `test/installation/installation.test.ts`, `test/cli/upgrade.test.ts`, and the new compare tests.

## Out of scope

- Headless (`run`/`serve`) startup checks (matches upstream TUI-only behavior).
- TUI dialog/UX changes (already complete at `app.tsx:1172-1218`).
- `next` (rc/beta) channel semantics (keeps today's own-tag behavior).
- curl/brew/choco/scoop/GitHub latest resolution (stable-only sources; no dev channel exists there).
