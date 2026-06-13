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

export const name = "websearch_free"
export const MAX_NUM_RESULTS = 20
export const MAX_RESPONSE_BYTES = 256 * 1024
export const DDG_URL = "https://html.duckduckgo.com/html/"

export const description = `Search the web using DuckDuckGo HTML. Use this for current information beyond knowledge cutoff.

This is a free local web search tool backed by DuckDuckGo. It does not require an API key.

Optional controls support result count (max ${MAX_NUM_RESULTS}), region, and time range.`

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
                HttpClientRequest.accept("text/html"),
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

              if (limitedResults.length === 0) {
                return {
                  provider: "duckduckgo" as const,
                  text: "No search results found. Please try a different query.",
                  results: [],
                }
              }

              const text = limitedResults
                .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
                .join("\n\n")

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