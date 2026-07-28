# Release Workflow

This file is the authoritative source for the BanyanCode release process. It
documents:

1. The version-numbering scheme.
2. The "every release is latest, never prerelease" semantics on both npm and
   the GitHub release.
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

## 2. `latest`, not prerelease — every release

Every shipping BanyanCode release is a **stable, latest-channel release** by
default. There is no staging / canary / RC tier. This is deliberate — BanyanCode
is a single-track product. Operators who do want a softer rollout can manually
flip a single release into a prerelease (see §6 below) but the automation
never produces one.

### npm

`packages/opencode/script/publish.ts` calls `npm publish --tag ${Script.channel}`,
and `Script.channel` resolves to `OPENCODE_CHANNEL` from the publish workflow
environment, which defaults to `latest` (see `.github/workflows/publish.yml:284-288`).
So every push to npm tags the new version as `banyancode@latest` (and the
same for every platform sub-package).

The publish.ts `published()` probe at line 12-14 runs `npm view <name>@<version>`
first and skips already-published tarballs with `already published <name>@<version>`.
Re-running a publish workflow on the same tag is safe: it never silently
overwrites another version.

### GitHub release

`.github/workflows/publish.yml` creates the release as `--draft` but
**never** with `--prerelease`. The finalize-draft step at line 295 explicitly
edits with `--draft=false --prerelease=false`, so even if a future change
upstream reintroduces `--prerelease`, this step overrides it before the
release becomes public.

If you need a soft rollout, follow §6 — never edit `publish.yml` to add a
prerelease flag to the canonical path.

---

## 3. End-to-end pipeline

The full release flow is two stages, both fully automated after a single
`git push origin main` carrying a `chore(opencode): bump version to X.Y.Z`
commit.

```
push to main
    |
    +-- .github/workflows/tag-release.yml   (auto-tag on version change)
    |       creates annotated tag `vX.Y.Z` and pushes it to origin
    |
    +-- .github/workflows/publish.yml       (triggered by `on: push: tags: v*`)
            runs 11-target build matrix -> uploads 10 shipping assets
            -> uploads draft GitHub release -> publishes npm `banyancode@X.Y.Z`
            -> marks GitHub release as latest (not prerelease)
```

### Stage 1 — `tag-release.yml` (auto-tag)

Triggers on `push` to `main` with a path filter on
`packages/opencode/package.json`. Reads the current version, compares to the
latest `v*` tag, and creates + pushes a new annotated tag only when the
version changed. The publish.yml `version` job reads this tag, so the
downstream workflow fires automatically.

To stay sane, the workflow is **idempotent**: re-running when the version
hasn't changed is a no-op. To skip a tag (e.g. you accidentally bumped the
version but want to revert), delete the local + remote tag:
```sh
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```
and revert the version-bump commit.

### Stage 2 — `publish.yml` (publish on tag push)

Triggers on `push: tags: 'v*'`. Steps:

1. **Resolve version** — reads the version out of the tag name.
2. **Build matrix (11 targets)** — 6 linux .tar.gz + 3 darwin .zip + 1
   windows .zip + 1 windows-x64-baseline.zip (the triage-only build).
3. **Optional Windows signing** — uses Azure Trusted Signing if the matching
   secrets exist; otherwise repacks unsigned with a `::warning::`.
4. **Publish to npm + create GitHub release** — uploads the 10 shipping
   artifacts (hardcoded allowlist — see §5), runs `bun
   ./packages/opencode/script/publish.ts` to push `banyancode@X.Y.Z` to npm
   with the `latest` dist-tag, then flips the GitHub release from draft to
   latest (`--prerelease=false`).

`Script.channel` is hardcoded to `latest` in the publish workflow environment
(`.github/workflows/publish.yml:285`), so every npm package publishes as
`latest` regardless of the operator.

---

## 4. Manual fallback

If automation is unavailable (CI down, fork, sandboxed environment), the
full flow can be driven by hand from the maintainer's workstation:

```sh
# 1. Bump the version
$EDITOR packages/opencode/package.json           # set "version": "26.07.53"

# 2. Commit
git add packages/opencode/package.json
git commit -m "chore(opencode): bump version to 26.07.53"

# 3. Push to main (in case the bump wasn't already pushed)
git push origin main

# 4. Tag and push the tag — this triggers publish.yml
git tag -a v26.07.53 -m "BanyanCode 26.07.53" <bump-commit-sha>
git push origin v26.07.53
```

The publish workflow runs as if `tag-release.yml` had created the tag itself.
Re-running on the same tag is safe (publish.ts is idempotent; the workflow
republishes whatever assets are missing or reuses the existing GitHub release
draft).

---

## 5. Shipping assets — the 10-target allowlist

`.github/workflows/publish.yml:287-302` enumerates exactly the 10 shipping
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
**deliberately excluded** — it is the downstream Azure Trusted Signing
triage build per `/AGENTS.md`, and shipping it to users would give them a
non-default baseline runtime. If you ever need to ship a baseline variant
publicly, do it as an explicit `<target>-baseline-public` matrix entry, not by
relaxing this list.

The allowlist is **filename-exact** (no glob). `build.ts` packs linux as
`<target>.tar.gz` and `publish.yml` packs macOS / Windows as `<target>.zip` —
neither pipeline adds a version segment to the filename. The previous
wildcard `banyancode-*.*` allowed the baseline artifact through accidentally,
which is why we now enumerate explicit names. A per-file `::warning::missing`
annotation runs before `gh release upload` so a future rename in `build.ts`
surfaces as an explicit log annotation, not as a silent regression.

---

## 6. Manual prerelease override (rare)

Sometimes you really do want to hide a release from the default npm
`@latest` tag and the GitHub feed — e.g. a partial platform fix that
shouldn't be the recommended install until the rest of the matrix catches
up. The repo convention says **don't bake this into the workflow**, but
operators can flip a single release post-hoc:

```sh
# Mark v26.07.54 as prerelease (hides from `gh releases` latest feed
# and from `npm install banyancode` on the @latest dist-tag — `npm install
# banyancode@26.07.54` still works for testing).
gh release edit v26.07.54 --prerelease=true --repo EkagraAgarwal/BanyanCode

# Re-promote when ready (flip back to the workflow default).
gh release edit v26.07.54 --prerelease=false --repo EkagraAgarwal/BanyanCode
```

The npm `latest` dist-tag is harder to roll back from `latest` (npm has no
unpublish on published versions). If you publish as `latest` and want to
hide it, the only path forward is a newer patch version cut on top — see
"hard-won lessons" in `/AGENTS.md`, "To roll back a bad release, cut a NEW
patch version with the fix and let the workflow publish it normally."

When using the prerelease override, also publish npm under a non-`latest`
dist-tag so the prerelease doesn't get automatically promoted:

```sh
OPENCODE_CHANNEL=prerelease bun ./packages/opencode/script/publish.ts
# Manual workaround only — do not change the publish.yml default.
```

---

## 7. What the workflow does NOT do

Worth keeping in mind so we don't accidentally regress:

- **No npm unpublish.** Once a version is on the registry, it stays.
  The publish.ts `published()` probe (`.ts:12-14`) makes every operation
  idempotent against re-runs, but it does not give us a way to take a
  release back.
- **No tag-force-move.** A given `vX.Y.Z` tag is created once and never
  moved. If a release needs to be corrected, cut `vX.Y.(Z+1)` on top
  and let the workflow ship normally. Per `/AGENTS.md` "Never move a tag
  once a release ships."
- **No AUR / Homebrew tap.** The npm + GitHub release is the only
  shipping surface. The `banyancode.ts:81-84` script notes AUR /
  Homebrew are intentionally out of scope.
- **No prerelease flag at create time.** Every release is created as
  `--draft` only, finalized as `--prerelease=false`. Operators can
  manually flip a single release but cannot automate prereleases via the
  workflow.

---

## 8. Quick reference

| What | Where |
|---|---|
| Version source | `packages/opencode/package.json:3` |
| Naming | `YY.MM.PATCH` (CalVer) |
| Tag format | `v${VERSION}` (annotated), title "BanyanCode ${VERSION}" |
| Auto-tag workflow | `.github/workflows/tag-release.yml` |
| Publish workflow | `.github/workflows/publish.yml` |
| Build matrix | 11 targets (10 ship + 1 windows-x64-baseline triage) |
| npm dist-tag | `latest` (via `OPENCODE_CHANNEL` default) |
| GitHub release | not draft, not prerelease (workflow default) |
| Idempotent re-run | yes — both npm and GitHub sides |
| Manual override | git tag + push to trigger the same workflow |

When in doubt, `release/AGENTS.md` wins; when still in doubt, ask in the
project's issue tracker before changing the workflow.
