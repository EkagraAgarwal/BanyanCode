import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { WebSearchEditor, WebSearchDefinition } from "@opencode/plugin/effect/websearch"
import { Effect, Stream } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig } from "../../src/config/index.js"
import {
  applyWebsearch,
  buildUrl,
  definition,
  MAX_RESULTS,
  parse,
  PROVIDER_ID,
  register,
  toResults,
  websearchState,
} from "../../src/websearch/index.js"
import { MAX_SNIPPET_CHARS, MAX_TITLE_CHARS } from "../../src/websearch/parse.js"

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text()

const makeEditor = (initial?: string | false) => {
  const added: WebSearchDefinition[] = []
  let selection: string | false | undefined = initial
  const editor: WebSearchEditor = {
    add: (item) => {
      added.push(item)
    },
    default: {
      get: () => selection,
      set: (next) => {
        selection = next
      },
    },
  }
  return { editor, added, selection: () => selection }
}

describe("duckduckgo parser", () => {
  test("parses the saved results page", async () => {
    const results = parse(await fixture("ddg-results.html"))
    expect(results).toEqual([
      {
        title: "Understanding & Benchmarking GLM 2025",
        url: "https://example.com/article1",
        snippet: "GLM benchmark results from 2025 show significant improvements in reasoning.",
      },
      {
        title: "GLM-4 vs GPT-4: A Comparison",
        url: "https://example.com/article2",
        snippet: "A detailed comparison covering benchmarks, cost, and deployment.",
      },
      {
        title: "Third Result",
        url: "https://example.com/article3",
        snippet: 'Snippet with "quotes" and <angles>.',
      },
    ])
  })

  test("unwraps the duckduckgo.com/l/?uddg= redirect", async () => {
    const results = parse(await fixture("ddg-wrapped.html"))
    expect(results).toHaveLength(1)
    expect(results[0]?.url).toBe("https://target.example.com/path?q=1&r=2")
    expect(results[0]?.title).toBe("Wrapped Result")
  })

  test("returns nothing for a page without results", async () => {
    expect(parse(await fixture("ddg-empty.html"))).toEqual([])
    expect(parse("")).toEqual([])
  })

  test("deduplicates by URL", async () => {
    const html = await fixture("ddg-results.html")
    const results = parse(html + html)
    expect(results).toHaveLength(3)
    expect(new Set(results.map((result) => result.url)).size).toBe(3)
  })

  test("caps results at the parser limit", () => {
    const blocks = Array.from(
      { length: 14 },
      (_, index) =>
        `<div class="result"><a class="result__a" href="https://example.com/${index}">Title ${index}</a>` +
        `<a class="result__snippet">Snippet ${index}</a></div>`,
    ).join("\n")
    expect(parse(blocks)).toHaveLength(10)
  })

  test("truncates long titles and snippets", () => {
    const longTitle = "A".repeat(300)
    const longSnippet = "B".repeat(600)
    const html =
      `<div class="result"><a class="result__a" href="https://example.com/long">${longTitle}</a>` +
      `<a class="result__snippet">${longSnippet}</a></div>`
    const results = parse(html)
    expect(results[0]?.title).toHaveLength(MAX_TITLE_CHARS)
    expect(results[0]?.snippet).toHaveLength(MAX_SNIPPET_CHARS)
  })

  test("maps hits onto the v2 result shape and caps at the provider limit", async () => {
    const results = toResults(await fixture("ddg-results.html"))
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({
      url: "https://example.com/article1",
      title: "Understanding & Benchmarking GLM 2025",
      content: "GLM benchmark results from 2025 show significant improvements in reasoning.",
      time: {},
    })
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS)
  })
})

describe("duckduckgo provider", () => {
  test("builds the html endpoint url with the global region", () => {
    const url = new URL(buildUrl("glm benchmarks & more"))
    expect(url.origin + url.pathname).toBe("https://html.duckduckgo.com/html/")
    expect(url.searchParams.get("q")).toBe("glm benchmarks & more")
    expect(url.searchParams.get("kl")).toBe("wt-wt")
  })

  test("registers as the default provider when nothing else claimed it", () => {
    const harness = makeEditor()
    applyWebsearch(harness.editor, { disabled: false })
    expect(harness.added.map((item) => item.id)).toEqual([PROVIDER_ID])
    expect(harness.added[0]?.name).toBe("DuckDuckGo")
    expect(harness.selection()).toBe(PROVIDER_ID)
    expect(definition.id).toBe(PROVIDER_ID)
  })

  test("leaves an existing default alone", () => {
    const harness = makeEditor("exa")
    applyWebsearch(harness.editor, { disabled: false })
    expect(harness.selection()).toBe("exa")
  })

  test("registers nothing when disabled", () => {
    const harness = makeEditor()
    applyWebsearch(harness.editor, { disabled: true })
    expect(harness.added).toEqual([])
    expect(harness.selection()).toBeUndefined()
  })
})

describe("duckduckgo disable switch", () => {
  test("is enabled by default", () => {
    expect(websearchState({}, {}).disabled).toBe(false)
  })

  test("honors the banyancode_disable_websearch config key", () => {
    expect(websearchState({ banyancode_disable_websearch: true }, {}).disabled).toBe(true)
    expect(websearchState({ banyancode_disable_websearch: false }, {}).disabled).toBe(false)
  })

  test("honors BANYANCODE_DISABLE_WEBSEARCH=1 only", () => {
    expect(websearchState({}, { BANYANCODE_DISABLE_WEBSEARCH: "1" }).disabled).toBe(true)
    expect(websearchState({}, { BANYANCODE_DISABLE_WEBSEARCH: "true" }).disabled).toBe(false)
    expect(websearchState({}, { BANYANCODE_DISABLE_WEBSEARCH: "0" }).disabled).toBe(false)
  })

  test("honors the BanyanCode product kill switch", () => {
    expect(websearchState({}, { BANYANCODE_ENABLE: "0" }).disabled).toBe(true)
  })
})

describe("duckduckgo registration", () => {
  // The switch also reads process.env; isolate the register tests from the shell.
  const withTemp = async (fn: (directory: string) => Promise<void>) => {
    const disable = process.env.BANYANCODE_DISABLE_WEBSEARCH
    const enable = process.env.BANYANCODE_ENABLE
    delete process.env.BANYANCODE_DISABLE_WEBSEARCH
    delete process.env.BANYANCODE_ENABLE
    const directory = await mkdtemp(join(tmpdir(), "banyancode-websearch-"))
    try {
      await fn(directory)
    } finally {
      if (disable === undefined) delete process.env.BANYANCODE_DISABLE_WEBSEARCH
      else process.env.BANYANCODE_DISABLE_WEBSEARCH = disable
      if (enable === undefined) delete process.env.BANYANCODE_ENABLE
      else process.env.BANYANCODE_ENABLE = enable
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  const fakeContext = (editor: WebSearchEditor) =>
    ({
      websearch: {
        transform: (callback: (input: WebSearchEditor) => void) =>
          Effect.sync(() => {
            callback(editor)
            return { dispose: Effect.void }
          }),
        reload: () => Effect.void,
      },
      event: { subscribe: () => Stream.empty },
    }) as unknown as Context

  test("register adds the provider through the websearch domain", async () => {
    await withTemp(async (directory) => {
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: join(directory, "missing") })
      const harness = makeEditor()
      await Effect.runPromise(Effect.scoped(register(fakeContext(harness.editor), { config })))
      expect(harness.added.map((item) => item.id)).toEqual([PROVIDER_ID])
      expect(harness.selection()).toBe(PROVIDER_ID)
    })
  })

  test("register skips the provider when banyancode.json disables it", async () => {
    await withTemp(async (directory) => {
      await writeFile(join(directory, "banyancode.json"), JSON.stringify({ banyancode_disable_websearch: true }))
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: join(directory, "missing") })
      const harness = makeEditor()
      await Effect.runPromise(Effect.scoped(register(fakeContext(harness.editor), { config })))
      expect(harness.added).toEqual([])
      expect(harness.selection()).toBeUndefined()
    })
  })
})
