# BanyanCode — `websearch_free` (DuckDuckGo)

> See `ARCHITECTURE.md` for the broader design. This file covers the websearch tool.

A new tool that searches DuckDuckGo HTML and returns a normalized result list, ready to be plugged into the researcher agent.

## Why DuckDuckGo

- No API key. No signup. No rate limit beyond the public endpoint's IP throttling.
- HTML endpoint is stable enough for a single-region parse.
- SearXNG would require a self-hosted instance; out of scope for the v1 release.

## Endpoint

- POST `https://html.duckduckgo.com/html/?q=<query>` (URL-encoded form body).
- Headers: `User-Agent: BanyanCode/<version>`, `Accept: text/html`.
- Response: HTML with a list of result blocks. Each block has a title, a URL, and a snippet.

## Constraints (mirrored from `packages/core/src/tool/websearch.ts:17-19`)

- 25 s timeout.
- 256 KB body cap.
- `numResults` ≤ 20.
- `contextMaxCharacters` ≤ 50 000 (applies to `output.text`).

## Tool definition

`packages/core/src/tool/websearch-free.ts`:

```ts
export const WebSearchFreeTool = Tool.make({
  description: "Free web search via DuckDuckGo HTML. No API key required. Use for ad-hoc lookups, library docs, recent events.",
  input: Schema.Struct({
    query: Schema.String,
    numResults: Schema.optional(Schema.Number.check(Schema.isLessThanOrEqualTo(20))),
    region: Schema.optional(Schema.Literals(["wt-wt", "us-en", "uk-en", "in-en"])),
    time: Schema.optional(Schema.Literals(["d", "w", "m", "y"])),
  }),
  output: Schema.Struct({
    provider: Schema.Literal("duckduckgo"),
    text: Schema.String,                   // already-formatted text block for the LLM
    results: Schema.Array(Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String,
    })),
  }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  execute: (input, ctx) => Effect.gen(function* () { /* ... */ }),
})
```

## Parsing

`packages/core/src/tool/websearch-free/parse.ts` uses `htmlparser2` (already in `packages/opencode/package.json`) to walk the result list. The result blocks are inside `<a class="result__a" href="...">title</a>` and `<a class="result__snippet">snippet</a>`. The parser extracts:

- `title` — text content of `result__a`.
- `url` — `href` of `result__a`. Note: DuckDuckGo wraps external URLs in a redirect. We unwrap the `uddg=` query param.
- `snippet` — text content of `result__snippet`.

## Permissions

- The `websearch_free` permission key is added to `packages/core/src/permission/permission.ts`.
- Default: **not** enabled for the `build` primary agent. It is enabled only for the new `researcher` subagent.
- The orchestrator does not have `websearch_free`; it delegates research to the `researcher`.

## Error handling

Following the existing tool rules (`packages/core/src/tool/AGENTS.md`):

- Translate only expected typed errors into `ToolFailure`. DuckDuckGo rate limits and timeouts are expected; transient network errors are unexpected and surface as defects.
- Return `output: { results: [], text: "No results found" }` on a clean 200 with no results. **Do not** throw a `ToolFailure` for empty results.

## Acceptance criteria (from the master plan)

- `bun test --cwd packages/opencode test/banyan/websearch-free.test.ts` passes against a recorded DuckDuckGo HTML fixture.
- Calling the tool against the live DuckDuckGo endpoint returns at least one result for `query="effect-ts README"`. (Manual smoke test; not in CI.)
- 25 s timeout; 256 KB body cap; same shape as `packages/core/src/tool/websearch.ts:17-19`.
- `websearch_free` is **not** enabled for the `build` primary agent by default. It is only enabled for agents that opt in (the new `researcher` agent in Phase 7).

## Open question (deferred)

- Should we add a `searxng` option if a `BANYANCODE_SEARXNG_URL` env is set? **No, the user chose DuckDuckGo only. Re-evaluate after v1.**
- Should the tool cache results per `(query, day)` in `shared_memory`? **Yes, but only for the researcher. Defer to a later phase.**
