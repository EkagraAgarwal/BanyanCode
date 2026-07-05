import { describe, expect, test } from "bun:test"
import { parse } from "../../src/tool/websearch-free/parse"

const ddgHtmlFixture = `<!DOCTYPE html>
<html>
<head><title>test - DuckDuckGo</title></head>
<body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a class="result__a" href="https://example.com/article1">Understanding GLM Benchmark 2025</a>
      <a class="result__snippet">GLM (General Language Model) benchmark results from 2025 show significant improvements in reasoning tasks across multiple evaluations.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a class="result__a" href="https://example.com/article2">GLM-4 vs GPT-4: A Comprehensive Comparison</a>
      <a class="result__snippet">A detailed comparison between GLM-4 and GPT-4 models, covering benchmarks, cost efficiency, and deployment options for 2025.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a class="result__a" href="https://example.com/article3">GLM Benchmark Results and Analysis</a>
      <a class="result__snippet">Official GLM benchmark results for 2025 including SuperCLUE, CMMLU, and MMLU evaluations with detailed breakdowns.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links">
      <a class="result__a" href="https://example.com/article4">Another GLM Article</a>
      <a class="result__snippet">More details about GLM models and their benchmark performance.</a>
    </div>
  </div>
</div>
</body>
</html>`

describe("websearch-free parse", () => {
  test("returns at least 3 results with non-empty title, url, and snippet", () => {
    const results = parse(ddgHtmlFixture)
    expect(results.length).toBeGreaterThanOrEqual(3)
    for (const r of results) {
      expect(r.title.length).toBeGreaterThan(0)
      expect(r.url.length).toBeGreaterThan(0)
      expect(r.snippet.length).toBeGreaterThan(0)
    }
  })

  test("deduplicates by URL", () => {
    const htmlWithDupes = ddgHtmlFixture + ddgHtmlFixture
    const results = parse(htmlWithDupes)
    const urls = results.map((r) => r.url)
    const uniqueUrls = new Set(urls)
    expect(uniqueUrls.size).toBe(urls.length)
  })

  test("caps results at 10", () => {
    const repeated = ddgHtmlFixture.repeat(20)
    const results = parse(repeated)
    expect(results.length).toBeLessThanOrEqual(10)
  })

  test("decodes HTML entities in title and snippet", () => {
    const htmlWithEntities = ddgHtmlFixture.replace(
      ">Understanding GLM Benchmark 2025<",
      ">TEST &amp; &lt;entity&gt; &quot;quoted&quot; 2025<",
    )
    const results = parse(htmlWithEntities)
    const first = results.find((r) => r.title.includes("TEST"))
    expect(first?.title).toContain("&")
    expect(first?.title).not.toContain("&amp;")
    expect(first?.title).toContain("<")
    expect(first?.title).not.toContain("&lt;")
    expect(first?.title).toContain('"')
    expect(first?.title).not.toContain("&quot;")
  })

  test("truncates title to 200 chars and snippet to 500 chars", () => {
    const longTitle = "A".repeat(300)
    const longSnippet = "B".repeat(600)
    const htmlWithLong = ddgHtmlFixture
      .replace("Understanding GLM Benchmark 2025", longTitle)
      .replace(
        "GLM (General Language Model) benchmark results from 2025 show significant improvements in reasoning tasks across multiple evaluations.",
        longSnippet,
      )
    const results = parse(htmlWithLong)
    for (const r of results) {
      expect(r.title.length).toBeLessThanOrEqual(200)
      expect(r.snippet.length).toBeLessThanOrEqual(500)
    }
  })

  test("returns empty array for HTML with no result containers", () => {
    const results = parse("<html><body><p>no results here</p></body></html>")
    expect(results).toEqual([])
  })

  test("returns empty array for empty HTML", () => {
    expect(parse("")).toEqual([])
    expect(parse("<html></html>")).toEqual([])
  })

  test("parses real DDG HTML with rel=nofollow as the first attribute", () => {
    // Live DuckDuckGo HTML uses <a rel="nofollow" class="result__a" href="...">
    // (i.e. class is NOT the first attribute). The parser must still extract.
    const liveHtml = `<div class="result results_links results_links_deep web-result">
  <div class="links">
    <a rel="nofollow" class="result__a" href="https://example.com/live1">Live DDG Title One</a>
    <a class="result__snippet" href="https://example.com/live1">Snippet one with <b>bold</b> match.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links">
    <a rel="nofollow" class="result__a" href="https://example.com/live2">Live DDG Title Two</a>
    <a class="result__snippet" href="https://example.com/live2">Snippet two describing the second result.</a>
  </div>
</div>`
    const results = parse(liveHtml)
    expect(results.length).toBe(2)
    expect(results[0].url).toBe("https://example.com/live1")
    expect(results[0].title).toBe("Live DDG Title One")
    expect(results[0].snippet).toBe("Snippet one with bold match.")
  })

  test("unwraps DuckDuckGo /l/?uddg= redirect to the real target URL", () => {
    // Live DDG wraps outbound links through //duckduckgo.com/l/?uddg=<encoded real url>
    const realUrl = "https://target.example.com/path?q=1&r=2"
    const wrappedUrl = `//duckduckgo.com/l/?uddg=${encodeURIComponent(realUrl)}&kl=wt-wt`
    const html = `<div class="result">
  <a rel="nofollow" class="result__a" href="${wrappedUrl}">Wrapped Result</a>
  <a class="result__snippet" href="${wrappedUrl}">Snippet for wrapped result.</a>
</div>`
    const results = parse(html)
    expect(results.length).toBe(1)
    expect(results[0].url).toBe(realUrl)
    expect(results[0].title).toBe("Wrapped Result")
  })

  test("strips inner <b> tags from snippet text without dropping the snippet", () => {
    // Live DDG wraps query-matched words in <b>; the parser must strip tags
    // rather than refusing to extract a snippet that contains inner markup.
    const html = `<div class="result">
  <a class="result__a" href="https://example.com/x">Title</a>
  <a class="result__snippet">Snippet with <b>matched</b> query <i>term</i> inside.</a>
</div>`
    const results = parse(html)
    expect(results.length).toBe(1)
    expect(results[0].snippet).toBe("Snippet with matched query term inside.")
  })
})
