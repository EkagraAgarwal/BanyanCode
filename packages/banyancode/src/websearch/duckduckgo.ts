import type { WebSearchDefinition } from "@opencode/plugin/effect/websearch"
import type { WebSearch } from "@opencode/schema/websearch"
import { Duration, Effect } from "effect"
import { parse } from "./parse.js"

/**
 * Free DuckDuckGo search, ported from v1 `websearch-free`.
 *
 * v1 exposed it as a `websearch_free` tool with `query`/`numResults`/`region`/
 * `time` inputs. v2's websearch provider contract only passes `query`
 * (`WebSearch.ProviderInput`), so the extra knobs are fixed at their v1
 * defaults; region/time belong to the provider selection UI if they are ever
 * needed again.
 */

export const PROVIDER_ID = "duckduckgo"
export const PROVIDER_NAME = "DuckDuckGo"
export const DDG_URL = "https://html.duckduckgo.com/html/"
export const MAX_RESPONSE_BYTES = 256 * 1024
export const MAX_RESULTS = 8
export const REGION = "wt-wt"
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

const HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.9",
}

export const buildUrl = (query: string, region: string = REGION): string => {
  const url = new URL(DDG_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("kl", region)
  return url.toString()
}

/** Map parsed DDG hits onto the v2 result shape (`content` carries the snippet). */
export const toResults = (html: string, limit: number = MAX_RESULTS): WebSearch.Result[] =>
  parse(html)
    .slice(0, limit)
    .map((result) => ({
      url: result.url,
      title: result.title,
      content: result.snippet,
      time: {},
    }))

const request = (query: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(buildUrl(query), { signal, headers: HEADERS }),
      catch: (cause) => cause,
    })
    if (!response.ok) return yield* Effect.fail(new Error(`DuckDuckGo returned HTTP ${response.status}`))
    const body = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) => cause,
    })
    if (body.byteLength > MAX_RESPONSE_BYTES)
      return yield* Effect.fail(new Error(`DuckDuckGo response exceeded ${MAX_RESPONSE_BYTES} bytes`))
    return toResults(new TextDecoder().decode(body))
  }).pipe(Effect.timeout(Duration.seconds(25)))

export const definition: WebSearchDefinition = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  execute: (input) => request(input.query),
}
