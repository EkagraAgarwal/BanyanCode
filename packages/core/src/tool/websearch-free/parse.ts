export interface ParsedResult {
  title: string
  url: string
  snippet: string
}

const cleanText = (raw: string): string =>
  raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim()

const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const MAX_RESULTS = 10

const unwrapDdgRedirect = (href: string): string => {
  if (!href) return href
  // DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded real url>&...
  // or as /l/?uddg=...
  if (!/^(\/\/duckduckgo\.com\/l\/|\/l\/)\?/.test(href)) return href
  try {
    const url = href.startsWith("//") ? `https:${href}` : `https://duckduckgo.com${href}`
    const parsed = new URL(url)
    const uddg = parsed.searchParams.get("uddg")
    return uddg ? decodeURIComponent(uddg) : href
  } catch {
    return href
  }
}

const RESULT_A_RE = /<a\b[^>]*\bclass="result__a"[^>]*>/i
const RESULT_SNIPPET_RE = /<a\b[^>]*\bclass="result__snippet"[^>]*>/i
const HREF_RE = /\bhref="([^"]+)"/i
const INNER_HTML_RE = /^([\s\S]*?)<\/a>/i

export const parse = (html: string): ParsedResult[] => {
  const seenUrls = new Set<string>()
  const results: ParsedResult[] = []

  // Each DDG result is a <div>... nested container. Attribute order varies,
  // so we match the class anywhere on the tag, then split out href and inner.
  const tagRegex = /<div\b[^>]*>[\s\S]*?<\/div>/g
  for (let m = tagRegex.exec(html); m !== null; m = tagRegex.exec(html)) {
    const block = m[0]
    if (!RESULT_A_RE.test(block)) continue

    // Extract the result__a tag itself
    const aTagMatch = /<a\b[^>]*\bclass="result__a"[^>]*>[\s\S]*?<\/a>/i.exec(block)
    if (!aTagMatch) continue
    const aTag = aTagMatch[0]

    const hrefMatch = HREF_RE.exec(aTag)
    if (!hrefMatch) continue
    const rawUrl = hrefMatch[1]
    const url = unwrapDdgRedirect(rawUrl)

    const innerMatch = INNER_HTML_RE.exec(aTag)
    if (!innerMatch) continue
    const title = cleanText(innerMatch[1])

    let snippet = ""
    const snippetMatch = /<a\b[^>]*\bclass="result__snippet"[^>]*>[\s\S]*?<\/a>/i.exec(block)
    if (snippetMatch) {
      const snippetInner = INNER_HTML_RE.exec(snippetMatch[0])
      if (snippetInner) snippet = cleanText(snippetInner[1])
    }

    if (!url || !title) continue
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    results.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      url,
      snippet: snippet.slice(0, MAX_SNIPPET_CHARS),
    })

    if (results.length >= MAX_RESULTS) break
  }

  return results
}
