# Release Workflow

This file is the authoritative source for the BanyanCode release process. It
documents:

1. The version-numbering scheme.
2. The channel-aware release semantics (`latest` / `next` / `dev`) on both
   npm and the GitHub release.
3. The end-to-end automated pipeline (push to `main` → tag → publish).
4. The manual fallback if automation is unavailable.

If anything here disagrees with `/AGENTS.md` at the repository root, treat
this file as the source of truth for release behaviour.

---

## 1. Versioning — CalVer `YY.MM.PATCH`

Every release follows the **CalVer `YY.MM.PATCH`** scheme already documented in
`/AGENTS.md` and `specs/banyancode/versioning.md`:

- `YY` — short year (last two digits of the calendar year).
- `MM` — month (zero-padded, 01-12).
- `PATCH` — iteration within the month; reset to `1` each new month, bump
  on every subsequent release inside the same month.

Examples: `26.07.50`, `26.07.51`, `26.07.52`, `26.08.1` (next month resets
the counter).

The single source of truth for the version string is the `version` field at
`packages/opencode/package.json:3`. The repo `package.json` `packageManager`
field is unrelated — leave it alone.

The publish workflow reads this version (via `node -p "require('./package.json').version"`
in `Resolve version`) and uses it for both npm and the GitHub release.

---

## 2. Channel-aware releases — `latest`, `next`, `dev`

Releases are **channel-aware**, matching the "Release channel" section in
`/AGENTS.md`; this file wins where the two disagree.
`.github/workflows/publish.yml:63-69` derives the channel from the version
string: no prerelease suffix → `latest`, `-rc.*`/`-beta.*` → `next`,
`-dev.*` → `dev`. Stable releases ship as GA; `dev` branch pushes
auto-publish a `dev`-tagged canary; `-rc`/`-beta` versions ship on `next`
for testers. Operators who want to delay a stable GA can still flip a single
release post-hoc (see §6 below).

### npm

`packages/opencode/script/publish.ts:24` calls `npm publish --tag ${Script.channel}`,
and `Script.channel` resolves to `OPENCODE_CHANNEL` from the publish workflow
environment (falling back to `latest` when unset). So stable versions land on
`banyancode@latest` (and the same for every platform sub-package),
`-rc`/`-beta` versions on `next`, and dev canaries on `dev`.

The publish.ts `published()` probe at lines 13-15 runs `npm view <name>@<version>`
first and skips already-published tarballs with `already published <name>@<version>`.
Re-running a publish workflow on the same tag is safe: it never silently
overwrites another version.

### GitHub release

`.github/workflows/publish.yml` creates the release as `--draft
--generate-notes` (plus `--prerelease` for dev/next channels, so `gh release
list` keeps canaries and RCs out of the stable view). The finalize step at
line 455 flips `--draft=false` and re-affirms the channel flag
(`--prerelease=false` for stable, `--prerelease=true` for dev/next) — and it
runs only after the npm step succeeds, so a failed npm publish never
promotes a draft.

If you need to delay a stable GA, follow §6 — never edit `publish.yml` to
hardcode the channel.

---

## 3. End-to-end pipeline

The full release flow is two stages, both fully automated after a single
`git push origin main` carrying a `chore(opencode): bump version to X.Y.Z`
commit. `tag-release.yml` is the sole normal tag creator — do NOT manually
tag alongside the bot (that races it and can double-publish).

```
push to main
    |
    +-- .github/workflows/tag-release.yml   (auto-tag on version change)
    |       creates annotated tag `vX.Y.Z`, pushes it, then explicitly
    |       dispatches publish.yml with the resolved version (bot tag
    |       pushes do not trigger downstream workflows)
    |
    +-- .github/workflows/publish.yml       (via explicit dispatch)
            runs 11-target build matrix -> uploads 10 shipping assets
            -> uploads draft GitHub release -> publishes npm `banyancode@X.Y.Z`
            -> finalizes the GitHub release (GA for stable, prerelease
               for dev/next channels)
```

`push: tags: v*` and manual `workflow_dispatch` remain as recovery paths
(e.g. PAT-created tags, backfill after a transient failure).

### Stage 1 — `tag-release.yml` (auto-tag)

Triggers on `push` to `main` with a path filter on
`packages/opencode/package.json`. Reads the current version, compares to the
latest `v*` tag, and creates + pushes a new annotated tag only when the
version changed, then explicitly dispatches `publish.yml` with the resolved
version (required because bot `GITHUB_TOKEN` tag pushes do not trigger
downstream workflows). Only the creation path dispatches, so idempotent
re-runs never double-publish.

To stay sane, the workflow is **idempotent**: re-running when the version
hasn't changed is a no-op. To skip a tag (e.g. you accidentally bumped the
version but want to revert), delete the local + remote tag:
```sh
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```
and revert the version-bump commit.

### Stage 2 — `publish.yml` (publish on dispatch)

Normal trigger is the `tag-release.yml` explicit dispatch with the resolved
`version` input. `push: tags: 'v*'` and manual `workflow_dispatch` remain as
recovery paths (PAT-created tags, backfill). Steps:

1. **Resolve version** — reads the version out of the tag name.
2. **Build matrix (11 targets)** — 6 linux .tar.gz + 3 darwin .zip + 1
   windows .zip + 1 windows-x64-baseline .zip (the 11th npm platform stub;
   the signing source is `windows-x64`, never this build).
3. **Optional Windows signing** — uses Azure Trusted Signing if the matching
   secrets exist (uploads `final-banyancode-windows-x64`); otherwise publish
   uses the raw unsigned build directly (no repack/re-upload) with a
   `::warning::`. A failed signing attempt fails the job, never falls back.
4. **Publish to npm + create GitHub release** — uploads the 10 shipping
   artifacts (hardcoded allowlist — see §5), runs `bun
   ./packages/opencode/script/publish.ts` to push `banyancode@X.Y.Z` to npm
   under the version-derived dist-tag (`latest` stable, `next` for
   `-rc`/`-beta`, `dev` for canaries), then finalizes the GitHub release
   draft (`--prerelease=false` stable, `--prerelease=true` dev/next).

The channel is derived from the version string in the publish workflow
(`.github/workflows/publish.yml:63-69`), threaded through as
`OPENCODE_CHANNEL` — never re-derived per job and never hardcoded.

---

## 4. Manual fallback

If automation is unavailable (CI down, fork, sandboxed environment), drive
the flow by hand from the maintainer's workstation. Prefer dispatching the
workflows over manually pushing tags (manual tags race the bot):

```sh
# 1. Bump the version
$EDITOR packages/opencode/package.json           # set "version": "26.07.53"

# 2. Commit
git add packages/opencode/package.json
git commit -m "chore(opencode): bump version to 26.07.53"

# 3. Push to main (in case the bump wasn't already pushed)
git push origin main
# tag-release.yml tags + dispatches publish.yml automatically.

# Backfill only (transient failure, PAT-created tag, or tag-release down):
gh workflow run publish.yml -f version=26.07.53 --repo EkagraAgarwal/BanyanCode
```

Manually pushing a tag (`git tag -a vX.Y.Z ... && git push origin vX.Y.Z`)
also triggers `publish.yml` via `push: tags`, but only use that recovery
path when the bot dispatch cannot run — never alongside the bot on the
normal path. Re-running on the same version is safe (publish.ts is
idempotent; the workflow reuses the existing GitHub release draft).

---

## 5. Shipping assets — the 10-target allowlist

`.github/workflows/publish.yml:420-431` enumerates exactly the 10 shipping
targets in `dist/banyancode-<target>.{tar.gz,zip}` form:

```
banyancode-linux-x64.tar.gz
banyancode-linux-x64-baseline.tar.gz
banyancode-linux-x64-musl.tar.gz
banyancode-linux-x64-baseline-musl.tar.gz
banyancode-linux-arm64.tar.gz
banyancode-linux-arm64-musl.tar.gz
banyancode-darwin-x64.zip
banyancode-darwin-x64-baseline.zip
banyancode-darwin-arm64.zip
banyancode-windows-x64.zip
```

The 11th matrix target, `banyancode-windows-x64-baseline`, is
**deliberately excluded** — it exists solely as the 11th npm platform package
per `/AGENTS.md` (the signing source is `windows-x64`, not this build), and
shipping it to users would give them a
non-default baseline runtime. If you ever need to ship a baseline variant
publicly, do it as an explicit `<target>-baseline-public` matrix entry, not by
relaxing this list.

The allowlist is **filename-exact** (no glob). `build.ts` packs linux as
`<target>.tar.gz` and `publish.yml` packs macOS / Windows as `<target>.zip` —
neither pipeline adds a version segment to the filename. The previous
wildcard `banyancode-*.*` allowed the baseline artifact through accidentally,
which is why we now enumerate explicit names. A per-file `::error::missing`
check runs before `gh release upload` and fails the job (`exit 1`) when any
shipping asset is absent, so a future rename in `build.ts` surfaces as an
explicit failure, not as a silent regression.

---

## 6. Prereleases and rollback

Choose the channel before publishing by using the version suffix described in
§2. For example, dispatching `26.07.54-rc.1` publishes to npm `next` and creates
a GitHub prerelease without moving `latest`:

```sh
gh workflow run publish.yml -f version=26.07.54-rc.1 --repo EkagraAgarwal/BanyanCode
```

Changing only the GitHub prerelease flag after publication does **not** change
the npm dist-tag. If a stable release is already on `latest`, prefer cutting a
new patch with the fix. An emergency dist-tag rollback is explicit and does
not unpublish anything:

```sh
npm dist-tag add banyancode@<previous-version> latest
gh release edit v<bad-version> --prerelease=true --repo EkagraAgarwal/BanyanCode
```

Platform sub-package dist-tags must remain aligned with the umbrella, so a new
patch is safer than manually rolling back every platform package.

---

## 7. What the workflow does NOT do

Worth keeping in mind so we don't accidentally regress:

- **No npm unpublish.** Once a version is on the registry, it stays.
  The publish.ts `published()` probe (`packages/opencode/script/publish.ts:13-15`)
  makes every operation idempotent against re-runs, but it does not give us
  a way to take a release back.
- **No tag-force-move.** A given `vX.Y.Z` tag is created once and never
  moved. If a release needs to be corrected, cut `vX.Y.(Z+1)` on top
  and let the workflow ship normally. Per `/AGENTS.md` "Never move a tag
  once a release ships."
- **No AUR / Homebrew tap.** The npm + GitHub release is the only
  shipping surface. The trailing comment at
  `packages/opencode/script/publish.ts:77-81` notes AUR /
  Homebrew are intentionally out of scope.
- **No hardcoded channel.** The channel is derived from the version string
  (`.github/workflows/publish.yml:63-69`) and threaded through as
  `OPENCODE_CHANNEL`. Every release is created as `--draft --generate-notes`
  (plus `--prerelease` for dev/next) and finalized with the matching
  `--prerelease` flag only after npm succeeds. Operators can manually flip a
  single stable release post-hoc (§6) but cannot change the channel mapping
  without editing the workflow.

---

## 8. Quick reference

| What | Where |
|---|---|
| Version source | `packages/opencode/package.json:3` |
| Naming | `YY.MM.PATCH` (CalVer) |
| Tag format | `v${VERSION}` (annotated), title "BanyanCode ${VERSION}" |
| Auto-tag workflow | `.github/workflows/tag-release.yml` |
| Publish workflow | `.github/workflows/publish.yml` |
| Build matrix | 11 targets (10 ship + 1 windows-x64-baseline npm stub) |
| npm dist-tag | channel-derived: `latest` stable, `next` for `-rc`/`-beta`, `dev` for canaries (via `OPENCODE_CHANNEL`) |
| GitHub release | draft → GA for stable, draft → prerelease for dev/next (finalized only after npm succeeds) |
| Idempotent re-run | yes — both npm and GitHub sides |
| Manual override | backfill dispatch (`gh workflow run publish.yml -f version=`) or post-hoc `--prerelease` flip; never hand-tag alongside the bot |

When in doubt, `release/AGENTS.md` wins; when still in doubt, ask in the
project's issue tracker before changing the workflow.
