import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PLATFORMS } from "./platforms"

const repo = path.resolve(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(repo, file)).text()

const publishFile = ".github/workflows/banyancode-publish.yml"
const preflightFile = ".github/workflows/banyancode-preflight.yml"

type Workflow = {
  name?: string
  on?: Record<string, unknown>
  jobs?: Record<string, { if?: string; strategy?: { matrix?: { include?: Array<Record<string, string>> } } }>
}

const load = async (file: string): Promise<{ text: string; doc: Workflow }> => {
  const text = await read(file)
  return { text, doc: Bun.YAML.parse(text) as Workflow }
}

describe("release workflows", () => {
  test("are dispatch-only until cutover", async () => {
    for (const file of [publishFile, preflightFile]) {
      const { doc } = await load(file)
      expect(Object.keys(doc.on ?? {})).toEqual(["workflow_dispatch"])
      expect(doc.on?.push).toBeUndefined()
    }
  })

  test("publish declares version, channel and dry_run inputs", async () => {
    const { doc } = await load(publishFile)
    const dispatch = doc.on?.workflow_dispatch as { inputs?: Record<string, { default?: unknown }> } | undefined
    expect(Object.keys(dispatch?.inputs ?? {}).sort()).toEqual(["channel", "dry_run", "version"])
    expect(dispatch?.inputs?.dry_run?.default).toBe(true)
  })

  test("every job is gated on the BanyanCode repository", async () => {
    for (const file of [publishFile, preflightFile]) {
      const { doc } = await load(file)
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        expect(job.if, `job ${name} in ${file}`).toContain("github.repository == 'EkagraAgarwal/BanyanCode'")
      }
    }
  })

  test("the build matrix covers exactly the npm platform list", async () => {
    const { doc } = await load(publishFile)
    const include = doc.jobs?.build?.strategy?.matrix?.include ?? []
    const targets = include.map((entry) => entry.target).sort()
    expect(targets).toEqual(PLATFORMS.map((entry) => entry.target).sort())
  })

  test("documents the v[0-9]* tag glob and warns against v*", async () => {
    const { text } = await load(publishFile)
    expect(text).toContain('tags: ["v[0-9]*"]')
    expect(text).toContain("NOT \"v*\"")
    // The dangerous glob must never appear as an active trigger.
    expect(/^\s+tags:\s*\n\s+- "v\*"$/m.test(text)).toBe(false)
  })

  test("dev canaries publish to npm only and skip the GitHub release", async () => {
    const { text } = await load(publishFile)
    expect(text).toContain("env.CHANNEL != 'dev'")
    expect(text).toContain("dev canary")
    // The npm publish step must use the script (which maps the channel to a dist-tag).
    expect(text).toContain('bun script/banyancode/publish.ts --version="$VERSION" --channel="$CHANNEL"')
  })
})
