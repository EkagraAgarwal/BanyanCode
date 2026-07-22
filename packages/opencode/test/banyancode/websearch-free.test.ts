import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { parse } from "../../../core/src/tool/websearch-free/parse"
import { config } from "../../../core/src/tool/websearch-free/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const DDG_HTML_FIXTURE = `
<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a rel="nofollow" class="result__a" href="https://example.com/first">First Result Title</a>
      <a class="result__snippet" href="https://example.com/first">This is the first result snippet with some details about the search result.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a rel="nofollow" class="result__a" href="https://example.com/second">Second Result Title</a>
      <a class="result__snippet" href="https://example.com/second">This is the second result snippet with different information.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a rel="nofollow" class="result__a" href="https://example.com/third">Third Result Title</a>
      <a class="result__snippet" href="https://example.com/third">The third result snippet contains more content here.</a>
    </div>
  </div>
</div>
</body>
</html>
`

describe("websearch-free", () => {
  describe("parse", () => {
    it.effect("parses results from DuckDuckGo HTML", () =>
      Effect.gen(function* () {
        const results = parse(DDG_HTML_FIXTURE)
        expect(results.length).toBe(3)
        expect(results[0]).toEqual({
          title: "First Result Title",
          url: "https://example.com/first",
          snippet: "This is the first result snippet with some details about the search result.",
        })
        expect(results[1]).toEqual({
          title: "Second Result Title",
          url: "https://example.com/second",
          snippet: "This is the second result snippet with different information.",
        })
        expect(results[2]).toEqual({
          title: "Third Result Title",
          url: "https://example.com/third",
          snippet: "The third result snippet contains more content here.",
        })
      }),
    )

    it.effect("handles HTML entities in snippets", () =>
      Effect.gen(function* () {
        const htmlWithEntities = `
          <div class="result">
            <a class="result__a" href="https://example.com/test">Test &amp; More</a>
            <a class="result__snippet" href="https://example.com/test">Here is a &quot;quoted&quot; piece of text with &lt;special&gt; chars.</a>
          </div>
        `
        const results = parse(htmlWithEntities)
        expect(results.length).toBe(1)
        expect(results[0].snippet).toBe('Here is a "quoted" piece of text with <special> chars.')
      }),
    )

    it.effect("unwraps DuckDuckGo /l/?uddg= redirect to the real target URL", () =>
      Effect.gen(function* () {
        const realUrl = "https://target.example.com/path?q=1&r=2"
        const wrappedUrl = `//duckduckgo.com/l/?uddg=${encodeURIComponent(realUrl)}&kl=wt-wt`
        const html = `
          <div class="result">
            <a rel="nofollow" class="result__a" href="${wrappedUrl}">Wrapped Title</a>
            <a class="result__snippet" href="${wrappedUrl}">Wrapped snippet text.</a>
          </div>
        `
        const results = parse(html)
        expect(results.length).toBe(1)
        expect(results[0].url).toBe(realUrl)
      }),
    )

    it.effect("returns empty array for HTML with no results", () =>
      Effect.gen(function* () {
        const emptyHtml = "<html><body><p>No results found</p></body></html>"
        const results = parse(emptyHtml)
        expect(results.length).toBe(0)
      }),
    )
  })

  describe("config", () => {
    it.effect("defaults to not disabled", () =>
      Effect.sync(() => {
        delete process.env.BANYANCODE_DISABLE_WEBSEARCH
        const cfg = config()
        expect(cfg.disabled).toBe(false)
      }),
    )

    it.effect("returns disabled true when BANYANCODE_DISABLE_WEBSEARCH=1", () =>
      Effect.sync(() => {
        process.env.BANYANCODE_DISABLE_WEBSEARCH = "1"
        const cfg = config()
        expect(cfg.disabled).toBe(true)
        delete process.env.BANYANCODE_DISABLE_WEBSEARCH
      }),
    )

    it.effect("returns disabled false for other BANYANCODE_DISABLE_WEBSEARCH values", () =>
      Effect.sync(() => {
        process.env.BANYANCODE_DISABLE_WEBSEARCH = "false"
        const cfg = config()
        expect(cfg.disabled).toBe(false)
        delete process.env.BANYANCODE_DISABLE_WEBSEARCH
      }),
    )
  })
})