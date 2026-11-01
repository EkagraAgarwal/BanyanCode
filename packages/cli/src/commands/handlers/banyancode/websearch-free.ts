/**
 * `banyancode websearch-free` — v1 hit DuckDuckGo directly from the CLI. v2's
 * plugin registers the same free DuckDuckGo search as a *websearch provider*
 * (`duckduckgo`), so the command goes through the host's `websearch.query`
 * route and keeps v1's flags and output.
 *
 * Differences forced by the provider contract: the provider always returns at
 * most 8 results (`MAX_RESULTS`), so `--num` can only narrow that window, and
 * `region` / `time` knobs no longer exist. A disabled search returns silently,
 * exactly like v1.
 */
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, onError } from "./client"
import { dim, println, Style } from "./ui"

const PROVIDER_ID = "duckduckgo"
const MAX_NUM_RESULTS = 20

const handler = Effect.fn("cli.websearchFree")(function* (
  input: Runtime.Input<typeof Commands.commands["websearch-free"]>,
) {
  const query = input.query
  if (process.env.BANYANCODE_DISABLE_WEBSEARCH === "1" || process.env.BANYANCODE_ENABLE === "0") return

  const { client } = yield* connect()
  const location = { directory: process.cwd() }
  const providers = yield* Effect.tryPromise({
    try: () => client.websearch.providers({ location }),
    catch: (cause) => cause,
  })
  // `banyancode_disable_websearch` unregisters the provider; v1 printed nothing then.
  if (!providers.data.some((provider) => provider.id === PROVIDER_ID)) return

  const response = yield* Effect.tryPromise({
    try: () => client.websearch.query({ location, query, providerID: PROVIDER_ID }),
    catch: (cause) => cause,
  })
  const num = input.num
  const results = response.data.results.slice(0, Math.max(1, Math.min(num, MAX_NUM_RESULTS)))
  println(Style.TEXT_HIGHLIGHT + `Websearch: ${query}` + Style.TEXT_NORMAL)
  println(dim(`results: ${results.length}`))
  println("")
  for (const result of results) {
    println(Style.TEXT_INFO_BOLD + (result.title ?? result.url) + Style.TEXT_NORMAL)
    println(dim(result.url))
    if (result.content) println(result.content)
    println("")
  }
})

export default Runtime.handler(Commands.commands["websearch-free"], (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
