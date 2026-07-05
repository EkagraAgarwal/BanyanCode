import { Duration, Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Banyan } from "@opencode-ai/core/banyancode"
import { WebSearchFreeTool, parseWebSearchFree } from "@opencode-ai/core/tool/websearch-free"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const MAX_NUM_RESULTS = 20

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
    const url = new URL(WebSearchFreeTool.DDG_URL)
    url.searchParams.set("q", query)
    url.searchParams.set("kl", "wt-wt")
    const request = HttpClientRequest.get(url.toString()).pipe(
      HttpClientRequest.setHeader("User-Agent", WebSearchFreeTool.USER_AGENT),
      HttpClientRequest.accept("text/html"),
      HttpClientRequest.setHeader("Accept-Language", "en-US,en;q=0.9"),
    )

    const body = yield* HttpClient.filterStatusOk(http).execute(request).pipe(
      Effect.flatMap((res) => res.text),
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => fail("websearch-free timed out"),
      }),
      Effect.mapError((err) =>
        err instanceof Object && "_tag" in err && err._tag === "CliError"
          ? err
          : new CliError({ message: `websearch-free http error: ${String(err)}` }),
      ),
    )

    const results = parseWebSearchFree(body).slice(0, Math.max(1, Math.min(args.num, MAX_NUM_RESULTS)))
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