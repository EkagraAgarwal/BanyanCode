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

export const parse = (html: string): ParsedResult[] => {
  const seenUrls = new Set<string>()
  const results: ParsedResult[] = []
  const containerRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g

  let containerMatch
  while ((containerMatch = containerRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
    const container = containerMatch[1]
    const urlMatch = /<a class="result__a"[^>]*href="([^"]+)"/.exec(container)
    const titleMatch = /<a class="result__a"[^>]*>([^<]+)<\/a>/.exec(container)
    const snippetMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(container)

    if (urlMatch && titleMatch) {
      const url = urlMatch[1]
      if (!seenUrls.has(url)) {
        seenUrls.add(url)
        results.push({
          title: cleanText(titleMatch[1]).slice(0, MAX_TITLE_CHARS),
          url,
          snippet: snippetMatch ? cleanText(snippetMatch[1]).slice(0, MAX_SNIPPET_CHARS) : "",
        })
      }
    }
  }

  return results
}
