import { Duration, Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Banyan } from "@opencode-ai/core/banyancode"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const DDG_URL = "https://html.duckduckgo.com/html/"
const MAX_NUM_RESULTS = 20

interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

const parseDDG = (html: string): SearchResult[] => {
  const results: SearchResult[] = []
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let match: RegExpExecArray | null
  while ((match = resultPattern.exec(html)) !== null) {
    const rawHref = match[1] ?? ""
    const title = (match[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    const snippet = (match[3] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    let decodedUrl: string
    try {
      decodedUrl = decodeURIComponent(rawHref)
    } catch {
      decodedUrl = rawHref
    }
    const uddg = (() => {
      const idx = decodedUrl.indexOf("uddg=")
      if (idx < 0) return decodedUrl
      return decodedUrl.slice(idx + 5)
    })()
    if (title && uddg) results.push({ title, url: uddg, snippet })
  }
  return results
}

const buildUrl = (query: string): string => {
  const url = new URL(DDG_URL)
  url.searchParams.set("q", query)
  return url.toString()
}

export const WebsearchFreeCommand = effectCmd({
  command: "websearch-free",
  describe: "search the web via DuckDuckGo HTML (free, no API key)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "search query" })
      .option("num", { type: "number", describe: `max results (default 8, max ${MAX_NUM_RESULTS})`, default: 8 }),
  handler: Effect.fn("Cli.websearchFree")(function* (args: { query?: string; num: number }) {
    const query = args.query
    if (!query) return
    const envDisabled = process.env.BANYANCODE_DISABLE_WEBSEARCH === "1"

    const option = yield* Effect.serviceOption(Banyan.BanyanConfigService)
    let configDisabled = false
    if (Option.isSome(option)) {
      const cfg = yield* option.value.get()
      configDisabled = cfg.banyancode_disable_websearch === true
    }
    if (envDisabled || configDisabled) return

    const http = yield* HttpClient.HttpClient
    const url = buildUrl(query)
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.accept("text/html"))

    const fetchHtml = HttpClient.filterStatusOk(http).execute(request).pipe(
      Effect.flatMap((res) => res.text),
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new Error("websearch-free timed out")),
      }),
    )

    const html = yield* fetchHtml.pipe(Effect.orElseSucceed(() => ""))
    const results = parseDDG(html).slice(0, Math.max(1, Math.min(args.num, MAX_NUM_RESULTS)))
    UI.println(UI.Style.TEXT_HIGHLIGHT + `Websearch: ${query}` + UI.Style.TEXT_NORMAL)
    UI.println(dim(`results: ${results.length}`))
    UI.println("")
    for (const r of results) {
      UI.println(UI.Style.TEXT_INFO_BOLD + r.title + UI.Style.TEXT_NORMAL)
      UI.println(dim(r.url))
      if (r.snippet) UI.println(r.snippet)
      UI.println("")
    }
  }),
})
