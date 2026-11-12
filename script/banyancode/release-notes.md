Fix ChatGPT model requests and preserve prompt-cache reuse during codegraph updates.

**ChatGPT compatibility.** Both ChatGPT sign-in paths (token sharing on `api.openai.com` and legacy Codex login) no longer send `prompt_cache_options` or `prompt_cache_retention`, which the subscription backend rejects. The existing prompt cache key and session routing headers remain intact. OpenAI API-key requests retain their cache controls.

**Stable prompt caching across providers.** With `banyancode_prompt_cache_stable_prefix` enabled (the default), graph readiness and counts no longer change the system prompt each time the graph rebuilds. Previously, even the trailing graph readout preceded conversation history, so changing it could invalidate reuse of that history on ChatGPT, DeepSeek, OpenCode Go, and other providers. Live graph status remains available through `codegraph op=status`. Disabling the setting retains the live system readout. DeepSeek's automatic caching and OpenCode Go's stable session routing header remain intact.

**Known limits:** Cache hits still depend on the provider, matching tool definitions and conversation history, minimum cacheable length, and cache lifetime. The prewarm setting currently sends no network request. Windows release binaries are unsigned. Close BanyanCode before upgrading so an older background service does not keep serving requests.
