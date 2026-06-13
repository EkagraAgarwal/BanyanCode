export interface ParsedResult {
  title: string
  url: string
  snippet: string
}

export const parse = (html: string): ParsedResult[] => {
  const results: ParsedResult[] = []
  const resultRegex = /<a class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>/g
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const titleRegex = /<a class="result__a"[^>]*>([^<]+)<\/a>/g

  const resultDivs = html.split('<div class="result">')
  for (const div of resultDivs) {
    if (div.length === 0) continue

    const titleMatch = div.match(/<a class="result__a"[^>]*>([^<]+)<\/a>/)
    const urlMatch = div.match(/<a class="result__a"[^>]*href="([^"]+)"/)
    const snippetMatch = div.match(/<p class="result__snippet"[^>]*>([\s\S]*?)<\/p>/)

    if (titleMatch && urlMatch && snippetMatch) {
      const rawSnippet = snippetMatch[1].trim()
      const snippetText = rawSnippet
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim()

      results.push({
        title: titleMatch[1].trim(),
        url: urlMatch[1],
        snippet: snippetText,
      })
    }
  }

  return results
}