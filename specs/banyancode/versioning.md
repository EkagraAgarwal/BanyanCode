# BanyanCode versioning plan

> Status: **proposed** for review. Implementing this touches `packages/script/src/index.ts`, the GitHub release workflow, the npm publish layer, and the docs.

## Why a new scheme?

`packages/script/src/index.ts:34-48` currently fetches the version from `opencode-ai` on the upstream npm registry and bumps that. That has two effects specific to BanyanCode:

1. **BanyanCode releases inherit upstream's semver** even when BanyanCode changed nothing — the inherited major bump is purely cosmetic.
2. **Local `WORKBENCH` builds float up to whatever the upstream team last published.** `banyancode 1.99.0-dev-20260715...` is fine but `banyancode 2.0.0-dev-20260715...` masquerades as a breaking-release preview.

BanyanCode should ship on its own cadence and let users reason about what changed from version to version without checking upstream.

## Goals

1. BanyanCode's version is owned by this repo, not by `opencode-ai` on npm.
2. The version is **human-recognizable** — users can glance at a release date and know roughly how fresh it is.
3. Pre-release builds never publish above the latest stable on `npm dist-tag latest`.
4. Hotfixes and feature drops are first-class.
5. Channel → dist-tag mapping is one-way and unambiguous.

## Proposed scheme — CalVer `YY.MM.PATCH[-prerelease]`

```
YY.MM.PATCH            — stable release
YY.MM.PATCH-rc.N       — release candidate N for that month
YY.MM.PATCH-beta.N     — public beta
YY.MM.PATCH-dev.<sha7> — internal dev build cut from main / dev
0.0.0-<channel>-YYYYMMDDHHmm   — local preview (never pushed)
```

| Example | Meaning |
|---|---|
| `25.07.0` | July 2025, first stable release of that month. |
| `25.07.1` | July 2025 hotfix. |
| `25.08.0-rc.1` | August 2025, first release candidate. |
| `25.08.0` | August 2025 stable (after `rc.N` cleared review). |
| `25.08.0-dev.abc1234` | Internal dev build from commit `abc1234`. |
| `0.0.0-dev-202607151200` | Local preview tag (lives only in `Script.version` for `IS_PREVIEW` builds). |

### Bump rules

| Change | Version bump |
|---|---|
| New monthly feature drop | `YY.MM+1.0` (e.g. `25.07.0` → `25.08.0`) |
| Hotfix to current monthly | `YY.MM.PATCH+1` (e.g. `25.07.0` → `25.07.1`) |
| Release candidate | append `-rc.N` (e.g. `25.08.0-rc.1`); promote to `25.08.0` once cleared |
| Internal preview | `-dev.<sha7>` |

**Why not plain SemVer?** CalVer lines up with how users run BanyanCode — they want to know if it's a recent build, not whether `1.4.0 → 1.5.0` is compatible. BanyanCode's CLI surface is stable; feature flags and channel-dist-tag semantics do the heavy lifting on compatibility.

**Why not zero-padded?** `7.10` collides with `7.1` in user discussion; zero-padded `25.07` reads better in chat / release notes and in `npm view banyancode versions`.

## Channels and dist-tags

| Channel | npm dist-tag | Audience | Asset path | DB filename |
|---|---|---|---|---|
| `latest` | `latest` | Default install | `banyancode-<os>-<arch>.{tar.gz,zip}` | `banyancode.db` |
| `next` | `next` | Opt-in testers of pre-releases | same | `banyancode-next.db` |
| `dev` | `dev` | Internal — every push to `dev` branch (or scheduled) | same | `banyancode-dev.db` |

The three "DB filename rules" already exist in AGENTS.md (`/OpenCode/AGENTS.md` lines about DB filename suffixes by channel) and behave correctly under the new scheme.

`OPENCODE_CHANNEL` (the existing env var) keeps its semantics: `latest` is the default; `next` is opt-in; `dev` is internal. The mapping happens once in `packages/script/src/index.ts`.

## Source of truth

**`packages/opencode/package.json` `"version"`** is the single source of truth for stable releases. The CI bumps it via a single commit on the release branch before the tag is pushed.

Why a checked-in source of truth, not a `VERSION` file or env-derived:

- `package.json` is already what `bun pm pack` reads into the npm wrapper's `version`. No double-bookkeeping.
- Drizzle migrations and the `Script.version` embeds already grep `package.json`.
- The user can `git blame packages/opencode/package.json` and see the version history.

## Implementation steps

### 1. `packages/script/src/index.ts` — read local version, not upstream

Replace the `npm view opencode-ai/latest` lookup with a direct read of `packages/opencode/package.json`. Keep all `OPENCODE_*` env overrides:

```ts
const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  const rootPkg = await Bun.file(rootPkgPath).json()
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const [majorYY, minorMM, patchN] = (rootPkg.dependencies... actually use rootPkg.version).split(".").map(Number)
  const t = env.OPENCODE_BUMP?.toLowerCase()
  if (t === "yy") return `${majorYY + 1}.0.0`          // major year bump
  if (t === "mm") return `${majorYY}.${minorMM + 1}.0`  // new month
  if (t === "patch") return `${majorYY}.${minorMM}.${patchN + 1}`
  return rootPkg.version
})()
```

The `OPENCODE_BUMP` enum changes from `{major, minor, patch}` to `{yy, mm, patch}` (with `major` becoming an alias for `yy`). The CLI inputs in `packages/opencode/src/cli/cmd/upgrade.ts` are unaffected — `upgrade` doesn't talk to the version script.

### 2. `.github/workflows/publish.yml` — accept `OPENCODE_BUMP` values

The workflow `publish.yml` currently does not consume `OPENCODE_BUMP`. It's read by the build script, so this is a no-op at the workflow level beyond ensuring the env var is forwarded. (Already the case.)

### 3. Release cadence script — `script/bump.ts` (new)

A tiny `bun script/bump.ts YY|MM|patch` script that:

1. Reads `packages/opencode/package.json`.
2. Bumps the version per the scheme.
3. Writes it back.
4. Optionally stages the file and runs `bun run changelog.ts` to draft release notes.

### 4. Pre-release guard — npm-publish level

In `packages/opencode/script/publish.ts`, refuse to publish a non-`latest` channel to the `latest` dist-tag:

```ts
if (channel !== "latest" && tag === "latest") {
  throw new Error(`Refusing to publish ${version} to dist-tag latest (channel=${channel})`)
}
```

### 5. Hotfix lane

A `git tag v25.07.1` on the `dev` branch (after merge) triggers the existing publish workflow with `OPENCODE_CHANNEL=latest` and the new version. No workflow changes needed.

### 6. Database schema versioning (coupled concern)

Per ARCHITECTURE.md, the schema is versioned via `graphVersion` / `migrationVersion` columns and has a non-destructive migration default. The new versioning scheme should codify:

- Adding a column is **additive** and ships in any month.
- Renaming or dropping requires a **migration script in the same release**, never silently.
- An **incompatible JSONB payload change** requires a major (`YY+1.0.0`) bump and a one-line notice in the changelog. This is the only place where we tolerate `+1` on `YY`.

### 7. Deprecation policy

- A feature is **deprecated** by adding `banyancode_<feature>_deprecated` to `BanyanConfig` and rendering a one-time warning on first use.
- A deprecated feature is **removed** two monthly releases later, in a `YY.MM+2.0` bump.

## Migration plan (existing tags)

Today, `banyancode` (the distribution we just landed) has no published releases yet — every install we'd serve comes from a tag we push. So the migration is trivial: **start with `v25.07.0`** as the first release under this scheme, and document the intent.

If we ever need to bridge from a hypothetical prior `1.x.y` semver, we'd publish a `banyancode-legacy` npm dist-tag pointing at a final `1.x.y`; new installs would land on `latest → 25.07.0+`.

## Open questions for review

1. **Should `dev` builds actually push to npm under the `dev` dist-tag, or only the GitHub release asset?** Pushing to npm is convenient (`npm i -g banyancode@dev` works); not pushing keeps the registry clean. Recommend: yes, push to `dev`, but with a clear `README` banner so `npm i -g banyancode` cannot accidentally land on dev.
2. **Should CalVer `YY` use 2-digit or 4-digit?** `25.07.0` vs `2025.07.0`. 2-digit is the convention for CalVer (`YY`) — recommend 2-digit. Backwards compatibility worry: `2510.07.0` is unambiguous but `2025.07.0` always parses. Lean 2-digit per convention.
3. **Patch releases within a month — how many can ship?** Recommend: up to 5 (`.0`–`.4`), with `.5+` triggering a minor bump. That keeps the `patch` axis meaningful.
4. **Should `rc.N` releases install over `latest`?** Recommend: no. `rc.N` lives on the `next` dist-tag. `latest` is always the current `YY.MM.x` stable. Otherwise users get surprised by a rebase of the rc.

## Reference: where the scheme is enforced

| Concern | File |
|---|---|
| Version derivation logic | `packages/script/src/index.ts` |
| Per-platform `package.json` `version` field | `packages/opencode/script/build.ts:309-324` |
| npm wrapper `version` field | `packages/opencode/script/publish.ts` |
| npm `dist-tag` selection | `packages/opencode/script/publish.ts` (`npm publish ... --tag ${Script.channel}`) |
| GitHub release tag format | `.github/workflows/publish.yml` (`on.push.tags: ['v*']`) |
| AUR pkgver | `packages/opencode/script/publish.ts:PKGBUILD` |
| Homebrew formula version | `packages/opencode/script/publish.ts:HomebrewFormula` |
| User-visible version banner | `install` (root) + `bin/banyancode` (`--version`) |
| DB version columns | `packages/core/src/database/` (existing) |
