#!/usr/bin/env bun

async function sendToPostHog(event: string, properties: Record<string, any>) {
  const key = process.env["POSTHOG_KEY"]

  if (!key) {
    console.warn("POSTHOG_KEY not set, skipping PostHog event")
    return
  }

  const response = await fetch("https://us.i.posthog.com/i/v0/e/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      distinct_id: "download",
      api_key: key,
      event,
      properties: {
        ...properties,
      },
    }),
  }).catch(() => null)

  if (response && !response.ok) {
    console.warn(`PostHog API error: ${response.status}`)
  }
}

interface Asset {
  name: string
  download_count: number
}

interface Release {
  tag_name: string
  name: string
  assets: Asset[]
}

interface NpmDownloadsPoint {
  downloads: number
  start: string
  end: string
  package: string
}

interface TelemetryStats {
  total_install_ids: number
  new_install_ids: number
  active_install_ids: number
  ci_install_ids: number
  non_ci_install_ids: number
}

// Mirrors the per-platform package list from packages/opencode/script/build.ts:120-176
// (allTargets). Each target ships as its own npm package under `banyancode-<target>`.
const NPM_PLATFORM_PACKAGES = [
  "banyancode-linux-x64",
  "banyancode-linux-x64-baseline",
  "banyancode-linux-x64-musl",
  "banyancode-linux-x64-baseline-musl",
  "banyancode-linux-arm64",
  "banyancode-linux-arm64-musl",
  "banyancode-darwin-x64",
  "banyancode-darwin-x64-baseline",
  "banyancode-darwin-arm64",
  "banyancode-windows-x64",
  "banyancode-windows-x64-baseline",
] as const

async function fetchNpmDownloads(packageName: string): Promise<number> {
  try {
    const response = await fetch(`https://api.npmjs.org/downloads/point/last-month/${packageName}`)
    if (!response.ok) {
      console.warn(`Failed to fetch npm downloads for ${packageName}: ${response.status}`)
      return 0
    }
    const data: NpmDownloadsPoint = await response.json()
    return data.downloads
  } catch (error) {
    console.warn(`Error fetching npm downloads for ${packageName}:`, error)
    return 0
  }
}

// Half-open [from, to) in epoch ms; omitted bounds = all-time. Never throws —
// non-200 and network errors warn and return null so the download row always appends.
async function fetchTelemetryStats(url: string, from?: string, to?: string): Promise<TelemetryStats | null> {
  const params: string[] = []
  if (from) params.push(`from=${encodeURIComponent(from)}`)
  if (to) params.push(`to=${encodeURIComponent(to)}`)
  const endpoint = params.length > 0 ? `${url}${url.includes("?") ? "&" : "?"}${params.join("&")}` : url

  try {
    const response = await fetch(endpoint)
    if (!response.ok) {
      console.warn(`Failed to fetch telemetry stats from ${endpoint}: ${response.status}`)
      return null
    }
    return (await response.json()) as TelemetryStats
  } catch (error) {
    console.warn(`Error fetching telemetry stats from ${endpoint}:`, error)
    return null
  }
}

// PostHog Query API (HogQL) — primary aggregate source; works on the free tier
// without the telemetry worker being deployed. Uses a PERSONAL API key
// (query:read scope), not the project capture key. Never throws.
async function fetchPostHogCount(projectId: string, personalKey: string, query: string): Promise<number | null> {
  try {
    const response = await fetch(`https://us.posthog.com/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${personalKey}` },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "banyan-stats" }),
    })
    if (!response.ok) {
      console.warn(`PostHog query failed: ${response.status}`)
      return null
    }
    const data = (await response.json()) as { results?: Array<Array<number>> }
    return data.results?.[0]?.[0] ?? null
  } catch (error) {
    console.warn("PostHog query error:", error)
    return null
  }
}

async function fetchReleases(): Promise<Release[]> {
  const releases: Release[] = []
  let page = 1
  const per = 100

  while (true) {
    const url = `https://api.github.com/repos/EkagraAgarwal/BanyanCode/releases?page=${page}&per_page=${per}`

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    const batch: Release[] = await response.json()
    if (batch.length === 0) break

    releases.push(...batch)
    console.log(`Fetched page ${page} with ${batch.length} releases`)

    if (batch.length < per) break
    page++
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return releases
}

function calculate(releases: Release[]) {
  let total = 0
  const stats = []

  for (const release of releases) {
    let downloads = 0
    const assets = []

    for (const asset of release.assets) {
      downloads += asset.download_count
      assets.push({
        name: asset.name,
        downloads: asset.download_count,
      })
    }

    total += downloads
    stats.push({
      tag: release.tag_name,
      name: release.name,
      downloads,
      assets,
    })
  }

  return { total, stats }
}

const parseStat = (value: string | undefined): number => {
  if (!value || value === "–") return 0
  return parseInt(value.replace(/,/g, "")) || 0
}

async function save(
  githubTotal: number,
  npmDownloads: number,
  binaryDownloads: number,
  totalInstalls: number | null,
  newInstalls: number | null,
  activeInstalls: number | null,
) {
  const file = "STATS.md"
  const date = new Date().toISOString().split("T")[0]
  const total = githubTotal + npmDownloads
  const header =
    "# Download Stats\n\n| Date | GitHub Downloads | npm Downloads | npm Binary Downloads | Total | Total Installs (running) | All-time (capped) | Active (30d) |\n|------|------------------|---------------|----------------------|-------|--------------------------|-------------------|--------------|\n"

  let previousGithub = 0
  let previousNpm = 0
  let previousBinary = 0
  let previousTotal = 0
  let previousRunning = 0
  let previousCapped = 0
  let previousActive = 0
  let content = ""

  try {
    content = await Bun.file(file).text()
    const lines = content.trim().split("\n")

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith("|") && !line.includes("Date") && !line.includes("---")) {
        const match = line.match(
          /\|\s*[\d-]+\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*(?:\|\s*((?:[\d,]+|–))\s*(?:\([^)]*\))?\s*)?(?:\|\s*((?:[\d,]+|–))\s*(?:\([^)]*\))?\s*)?(?:\|\s*((?:[\d,]+|–))\s*(?:\([^)]*\))?\s*)?\|/,
        )
        if (match) {
          previousGithub = parseInt(match[1].replace(/,/g, ""))
          previousNpm = parseInt(match[2].replace(/,/g, ""))
          previousBinary = parseInt(match[3].replace(/,/g, ""))
          previousTotal = parseInt(match[4].replace(/,/g, ""))
          previousRunning = parseStat(match[5])
          previousCapped = parseStat(match[6])
          previousActive = parseStat(match[7])
          break
        }
      }
    }
  } catch {
    content = header
  }

  // Retention-drift fix: both PostHog free tier (1y) and the worker (365d
  // purge) cap all-time unique installs. Accumulate new_install_ids as a
  // running sum — retention-immune — and keep the direct all-time query
  // value alongside as the (capped) reference.
  const runningInstalls = previousRunning + (newInstalls ?? 0)
  const cappedInstalls = totalInstalls

  const githubChange = githubTotal - previousGithub
  const npmChange = npmDownloads - previousNpm
  const binaryChange = binaryDownloads - previousBinary
  const totalChange = total - previousTotal
  const runningChange = runningInstalls - previousRunning
  const activeChange = activeInstalls === null ? null : activeInstalls - previousActive

  const githubChangeStr =
    githubChange > 0
      ? ` (+${githubChange.toLocaleString()})`
      : githubChange < 0
        ? ` (${githubChange.toLocaleString()})`
        : " (+0)"
  const npmChangeStr =
    npmChange > 0 ? ` (+${npmChange.toLocaleString()})` : npmChange < 0 ? ` (${npmChange.toLocaleString()})` : " (+0)"
  const binaryChangeStr =
    binaryChange > 0
      ? ` (+${binaryChange.toLocaleString()})`
      : binaryChange < 0
        ? ` (${binaryChange.toLocaleString()})`
        : " (+0)"
  const totalChangeStr =
    totalChange > 0
      ? ` (+${totalChange.toLocaleString()})`
      : totalChange < 0
        ? ` (${totalChange.toLocaleString()})`
        : " (+0)"
  const runningChangeStr =
    runningChange > 0
      ? ` (+${runningChange.toLocaleString()})`
      : runningChange < 0
        ? ` (${runningChange.toLocaleString()})`
        : " (+0)"
  const activeChangeStr =
    activeChange === null
      ? ""
      : activeChange > 0
        ? ` (+${activeChange.toLocaleString()})`
        : activeChange < 0
          ? ` (${activeChange.toLocaleString()})`
          : " (+0)"
  const runningStr = `${runningInstalls.toLocaleString()}${runningChangeStr}`
  const cappedStr = cappedInstalls === null ? "–" : cappedInstalls.toLocaleString()
  const activeStr = activeInstalls === null ? "–" : `${activeInstalls.toLocaleString()}${activeChangeStr}`
  const line = `| ${date} | ${githubTotal.toLocaleString()}${githubChangeStr} | ${npmDownloads.toLocaleString()}${npmChangeStr} | ${binaryDownloads.toLocaleString()}${binaryChangeStr} | ${total.toLocaleString()}${totalChangeStr} | ${runningStr} | ${cappedStr} | ${activeStr} |\n`

  if (!content.includes("# Download Stats")) {
    content = header
  }

  await Bun.write(file, content + line)
  await Bun.spawn(["bunx", "prettier", "--write", file]).exited

  console.log(
    `\nAppended stats to ${file}: GitHub ${githubTotal.toLocaleString()}${githubChangeStr}, npm ${npmDownloads.toLocaleString()}${npmChangeStr}, npm binary ${binaryDownloads.toLocaleString()}${binaryChangeStr}, Total ${total.toLocaleString()}${totalChangeStr}, Total Installs (running) ${runningStr}, All-time (capped) ${cappedStr}, Active (30d) ${activeStr}`,
  )
}

console.log("Fetching GitHub releases for EkagraAgarwal/BanyanCode...\n")

const releases = await fetchReleases()
console.log(`\nFetched ${releases.length} releases total\n`)

const { total: githubTotal } = calculate(releases)

console.log("Fetching npm last-month downloads for banyancode...\n")
const npmDownloads = await fetchNpmDownloads("banyancode")
console.log(`Fetched npm last-month downloads: ${npmDownloads.toLocaleString()}\n`)

console.log(`Fetching npm last-month downloads for ${NPM_PLATFORM_PACKAGES.length} platform packages...\n`)
const binaryDownloads = (await Promise.all(NPM_PLATFORM_PACKAGES.map((pkg) => fetchNpmDownloads(pkg)))).reduce(
  (total, downloads) => total + downloads,
  0,
)
console.log(`Fetched npm platform binary downloads: ${binaryDownloads.toLocaleString()}\n`)

const projectId = process.env["BANYANCODE_POSTHOG_PROJECT_ID"]
const personalKey = process.env["BANYANCODE_POSTHOG_PERSONAL_KEY"]
const statsUrl = process.env["BANYANCODE_TELEMETRY_STATS_URL"]
let totalInstalls: number | null = null
let newInstalls: number | null = null
let activeInstalls: number | null = null

if (projectId && personalKey) {
  const since30d = "timestamp >= now() - INTERVAL 30 DAY"
  console.log("Fetching telemetry install aggregates from PostHog Query API...\n")
  const [total, fresh, active] = await Promise.all([
    fetchPostHogCount(
      projectId,
      personalKey,
      "SELECT count(DISTINCT person_id) FROM events WHERE event = 'banyan_install'",
    ),
    fetchPostHogCount(
      projectId,
      personalKey,
      `SELECT count(DISTINCT person_id) FROM events WHERE event = 'banyan_install' AND ${since30d}`,
    ),
    fetchPostHogCount(
      projectId,
      personalKey,
      `SELECT count(DISTINCT person_id) FROM events WHERE event = 'banyan_heartbeat' AND ${since30d}`,
    ),
  ])
  totalInstalls = total
  newInstalls = fresh
  activeInstalls = active
  console.log(
    `Fetched telemetry install aggregates: ${totalInstalls?.toLocaleString() ?? "n/a"} all-time, ${newInstalls?.toLocaleString() ?? "n/a"} new (30d), ${activeInstalls?.toLocaleString() ?? "n/a"} active (30d)\n`,
  )
} else if (statsUrl) {
  const now = new Date()
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const to = now.toISOString()
  console.log(`Fetching telemetry install aggregates from ${statsUrl}...\n`)
  const [allTime, last30d] = await Promise.all([
    fetchTelemetryStats(statsUrl),
    fetchTelemetryStats(statsUrl, from, to),
  ])
  totalInstalls = allTime?.total_install_ids ?? null
  newInstalls = last30d?.new_install_ids ?? null
  activeInstalls = last30d?.active_install_ids ?? null
  console.log(
    `Fetched telemetry install aggregates: ${totalInstalls?.toLocaleString() ?? "n/a"} all-time, ${newInstalls?.toLocaleString() ?? "n/a"} new (30d), ${activeInstalls?.toLocaleString() ?? "n/a"} active (30d)\n`,
  )
} else {
  console.log(
    "No telemetry aggregate source configured (BANYANCODE_POSTHOG_PROJECT_ID + BANYANCODE_POSTHOG_PERSONAL_KEY, or BANYANCODE_TELEMETRY_STATS_URL); skipping telemetry aggregates",
  )
}

await save(githubTotal, npmDownloads, binaryDownloads, totalInstalls, newInstalls, activeInstalls)

await sendToPostHog("banyan_download", {
  count: githubTotal,
  source: "github",
})

await sendToPostHog("banyan_download", {
  count: npmDownloads,
  source: "npm",
})

await sendToPostHog("banyan_download", {
  count: binaryDownloads,
  source: "npm_binary",
})

if (totalInstalls !== null && activeInstalls !== null) {
  await sendToPostHog("banyan_telemetry_stats", {
    total_install_ids: totalInstalls,
    new_install_ids: newInstalls,
    active_install_ids: activeInstalls,
    period: "30d",
  })
}

const totalDownloads = githubTotal + npmDownloads

console.log("=".repeat(60))
console.log(`TOTAL DOWNLOADS: ${totalDownloads.toLocaleString()}`)
console.log(`  GitHub: ${githubTotal.toLocaleString()}`)
console.log(`  npm: ${npmDownloads.toLocaleString()}`)
console.log(`  npm binary: ${binaryDownloads.toLocaleString()}`)
console.log("=".repeat(60))

console.log("-".repeat(60))
console.log(`GitHub Total: ${githubTotal.toLocaleString()} downloads across ${releases.length} releases`)
console.log(`npm Total: ${npmDownloads.toLocaleString()} downloads`)
console.log(`npm Binary Total: ${binaryDownloads.toLocaleString()} downloads`)
console.log(`Combined Total: ${totalDownloads.toLocaleString()} downloads`)
