export * as WebSearchFreeTool from "./websearch-free"

import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { config } from "./websearch-free/config"
import { parse } from "./websearch-free/parse"
import { PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export { parse as parseWebSearchFree } from "./websearch-free/parse"

export const name = "websearch_free"
export const MAX_NUM_RESULTS = 20
export const MAX_RESPONSE_BYTES = 256 * 1024
export const DDG_URL = "https://html.duckduckgo.com/html/"
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

export const description =
  "Use when:\n" +
  "  free web search via DuckDuckGo (no API key, no quota).\n" +
  "Examples\n" +
  '  - "Latest GLM model benchmarks"\n' +
  '  - "What is the latest Node LTS?"\n' +
  "Returns\n" +
  "  { provider: \"duckduckgo\", text: string, results: [{ title, url, snippet }] }\n" +
  "Avoid when\n" +
  "  code-related questions — prefer repository_query / code_find."

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `Number of search results to return (default: 8, maximum: ${MAX_NUM_RESULTS})`,
  }),
  region: Schema.optional(Schema.Literals(["wt-wt", "us-en", "uk-en", "in-en"])).annotate({
    description: "Search region - 'wt-wt': global (default), 'us-en': United States, 'uk-en': United Kingdom, 'in-en': India",
  }),
  time: Schema.optional(Schema.Literals(["d", "w", "m", "y"])).annotate({
    description: "Time range - 'd': day, 'w': week, 'm': month, 'y': year",
  }),
})

export const Output = Schema.Struct({
  provider: Schema.Literal("duckduckgo"),
  text: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String,
    }),
  ),
})

const formatResults = (
  results: ReadonlyArray<{ title: string; url: string; snippet: string }>,
): string =>
  results.length === 0 ? "No search results found. Please try a different query." : results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")

const buildUrl = (query: string, numResults?: number, region?: string, time?: string) => {
  const url = new URL(DDG_URL)
  url.searchParams.set("q", query)
  if (numResults !== undefined) url.searchParams.set("kl", region ?? "wt-wt")
  if (time) url.searchParams.set("df", time)
  return url.toString()
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* PermissionV2.Service
    const toolConfig = config()

    if (toolConfig.disabled) return

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          contract: { visibility: "public" },
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const url = buildUrl(input.query, input.numResults, input.region, input.time)
              const request = HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeader("User-Agent", USER_AGENT),
                HttpClientRequest.setHeader("Accept", "text/html"),
                HttpClientRequest.setHeader("Accept-Language", "en-US,en;q=0.9"),
              )

              const body = yield* Effect.gen(function* () {
                const res = yield* HttpClient.filterStatusOk(http).execute(request)
                const text = yield* res.text
                if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
                  return yield* Effect.fail(new Error(`websearch_free response exceeded ${MAX_RESPONSE_BYTES} bytes`))
                }
                return text
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(25),
                  orElse: () => Effect.fail(new Error("websearch_free request timed out")),
                }),
              )

              const parsedResults = parse(body)
              const limitedResults = parsedResults.slice(0, input.numResults ?? 8)
              const text = formatResults(limitedResults)

              return {
                provider: "duckduckgo" as const,
                text,
                results: limitedResults,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to search the web for ${input.query}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)