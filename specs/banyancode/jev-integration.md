# Jev integration

Jev is a typed decision model, not a replacement for a coding LLM. BanyanCode's first integration uses a bounded Choice decision to select a user-configured alternate generative model for fresh `explore` and `scout` tasks. Explicit per-agent model and variant overrides take precedence. If Jev is unavailable, rejects its response, or is uncertain, the existing model is used.

## Configuration

The initial release supports environment-based credentials. Set `BANYANCODE_JEV_API_KEY` outside source control. A TypeSafe-specific `TYPESAFE_API_KEY` can also be used for the direct backend. For OpenRouter or Vercel, put a key intended for Jev in `BANYANCODE_JEV_API_KEY`; generic gateway environment keys are never reused, even if project config enables Jev.

```json
{
  "banyancode_jev_enabled": true,
  "banyancode_jev_backend": "typesafe",
  "banyancode_jev_subagent_models": {
    "explore": { "model": "your-provider/your-fast-model", "thinking": "low" },
    "scout": { "model": "your-provider/your-fast-model", "thinking": "low" }
  }
}
```

`banyancode_jev_backend` accepts `typesafe`, `openrouter`, or `vercel`; `banyancode_jev_model` overrides the backend's Jev model alias. `banyancode_jev_enabled: false` prevents requests even if a key exists. Without an alternate model configured for an eligible subagent, there is no automatic routing request. The alternate must resolve to a configured provider model.

Jev receives a bounded excerpt of an eligible task's prompt and description. This may contain repository or user data; only enable it if the selected backend's privacy and retention terms are acceptable. Do not put the API key in `banyancode.json` or check it into a repository.

Decisions appear as persistent `Jev` activity beneath the assistant message. The activity part does not replay into model prompts or grant permissions. The explicit `jev_judge` tool, when enabled for an agent, sends the state provided to that tool to the selected backend.

## Status and evaluation

This is an initial vertical slice. API-key connection UX, per-session budgets, caching, repository/memory reranking, and broader goal/verification integration are separate phases; the detailed local plan is `.banyancode/plans/jev-integration.md`. Do not claim product-wide cost savings until matched end-to-end coding workloads show lower **total** model cost without quality regression. Viral per-decision 80-90% savings graphs do not establish that result for BanyanCode.

Automatic subagent routing and `jev_judge` are wired into the default V1/opencode tool runtime. The experimental native V2/core tool registry does not expose these integrations yet; enabling that runtime should not be interpreted as Jev support.

Official contracts: [TypeSafe API](https://docs.typesafe.ai/api), [OpenRouter Jev](https://openrouter.ai/docs/guides/community/jev), [Vercel TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). Reference implementations: [jev-use](https://github.com/shitianfang/jev-use) and [jev-ultrafast](https://github.com/browser-use/jev-ultrafast).
