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

async function save(githubTotal: number, npmDownloads: number, binaryDownloads: number) {
  const file = "STATS.md"
  const date = new Date().toISOString().split("T")[0]
  const total = githubTotal + npmDownloads
  const header =
    "# Download Stats\n\n| Date | GitHub Downloads | npm Downloads | npm Binary Downloads | Total |\n|------|------------------|---------------|----------------------|-------|\n"

  let previousGithub = 0
  let previousNpm = 0
  let previousBinary = 0
  let previousTotal = 0
  let content = ""

  try {
    content = await Bun.file(file).text()
    const lines = content.trim().split("\n")

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith("|") && !line.includes("Date") && !line.includes("---")) {
        const match = line.match(
          /\|\s*[\d-]+\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|/,
        )
        if (match) {
          previousGithub = parseInt(match[1].replace(/,/g, ""))
          previousNpm = parseInt(match[2].replace(/,/g, ""))
          previousBinary = parseInt(match[3].replace(/,/g, ""))
          previousTotal = parseInt(match[4].replace(/,/g, ""))
          break
        }
      }
    }
  } catch {
    content = header
  }

  const githubChange = githubTotal - previousGithub
  const npmChange = npmDownloads - previousNpm
  const binaryChange = binaryDownloads - previousBinary
  const totalChange = total - previousTotal

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
  const line = `| ${date} | ${githubTotal.toLocaleString()}${githubChangeStr} | ${npmDownloads.toLocaleString()}${npmChangeStr} | ${binaryDownloads.toLocaleString()}${binaryChangeStr} | ${total.toLocaleString()}${totalChangeStr} |\n`

  if (!content.includes("# Download Stats")) {
    content = header
  }

  await Bun.write(file, content + line)
  await Bun.spawn(["bunx", "prettier", "--write", file]).exited

  console.log(
    `\nAppended stats to ${file}: GitHub ${githubTotal.toLocaleString()}${githubChangeStr}, npm ${npmDownloads.toLocaleString()}${npmChangeStr}, npm binary ${binaryDownloads.toLocaleString()}${binaryChangeStr}, Total ${total.toLocaleString()}${totalChangeStr}`,
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

await save(githubTotal, npmDownloads, binaryDownloads)

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
