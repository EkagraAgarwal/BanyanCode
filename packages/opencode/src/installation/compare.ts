// Version comparison helpers shared by the startup auto-update check
// (`cli/upgrade.ts`) and the manual `banyancode upgrade` command
// (`cli/cmd/upgrade.ts`). Pure functions — no Effect, no I/O.

const CANARY_SHA_SUFFIX = /-dev\.[0-9a-f]{7,}$/
// npm drops the leading zero from the CalVer month ("26.08.11" → "26.8.11");
// normalize so both forms compare equal.
export const canonicalVersion = (version: string) => version.replace(/(^|\.)0+(?=\d)/g, "$1")

export const isCanaryVersion = (version: string) => CANARY_SHA_SUFFIX.test(version)

// Decides whether an upgrade can be skipped. Canary versions are
// `YY.MM.PATCH-dev.<sha7>`; the sha is arbitrary (not orderable), so a plain
// numeric comparison wrongly treats an old sha as "newer" (e.g. 5013cc3 vs
// 1dd17c0) and skips the published build. When the installed and latest
// versions share the same base and are both canaries, the dist-tag is the
// source of truth — upgrade unless they are exactly equal. A canary also
// never outranks a stable by string order alone (its `-dev.<sha>` suffix
// sorts above end-of-string), so mixed canary/stable comparisons decide on
// the version core only.
export function shouldSkipUpgrade(installed: string, latest: string): boolean {
  if (canonicalVersion(installed) === canonicalVersion(latest)) return true
  const installedCanary = isCanaryVersion(installed)
  const latestCanary = isCanaryVersion(latest)
  if (installedCanary && latestCanary) {
    const sameBase =
      canonicalVersion(installed.replace(CANARY_SHA_SUFFIX, "")) ===
      canonicalVersion(latest.replace(CANARY_SHA_SUFFIX, ""))
    if (sameBase) return false
  }
  if (installedCanary !== latestCanary) {
    const coreComparison = compareCores(installed, latest)
    // Installed canary: upgrade unless its own base is already strictly newer.
    if (installedCanary) return coreComparison > 0
    // Installed stable: only upgrade when the canary target's base is strictly newer.
    return coreComparison >= 0
  }
  return installed.localeCompare(latest, undefined, { numeric: true }) > 0
}

// Numeric comparison of just the version core (everything before the first
// `-` prerelease separator). Returns > 0 when `left`'s core is strictly
// greater than `right`'s, < 0 when smaller, 0 when equal. Leading zeros are
// normalized first, so `26.08.11` and `26.8.11` compare equal.
function compareCores(left: string, right: string): number {
  const core = (version: string) =>
    canonicalVersion(version.split("-", 1)[0])
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = core(left)
  const b = core(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

// Picks the absolute newest of the `dev` and `latest` npm dist-tags. Dev
// (canary) users follow the dev branch: the dev tag wins unless the stable
// core is STRICTLY greater — on an equal base the canary is preferred. A
// missing tag (one fetch failed) falls back to the other. Both undefined is a
// caller error — throw so the failure surfaces instead of a bogus version.
export function resolveAbsoluteLatest(devTag: string | undefined, latestTag: string | undefined): string {
  if (devTag === undefined && latestTag === undefined) {
    throw new TypeError("both npm dist-tags returned no version")
  }
  if (devTag === undefined) return latestTag as string
  if (latestTag === undefined) return devTag
  return compareCores(latestTag, devTag) > 0 ? latestTag : devTag
}
