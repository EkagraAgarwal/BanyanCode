# BanyanCode — Cross-session memory

> Companion to `BANYANCODE_PLAN.md` Phase 4.

A persistent, key-value memory store with optional embeddings, exposed as 5 tools and a skill. Default scope is `global` (cross-session). `scope: "session"` opt-in for isolation.

## Mental model

```
            ┌──────────────────────────────┐
            │       memory_entries         │
            │  ┌─────────────────────────┐  │
            │  │ scope: "global"         │  │  ◀── default, persists forever (until TTL)
            │  │ scope: "session"        │  │  ◀── scoped to one parent session
            │  │ value: JSON             │  │
            │  │ tags: ["user:prefs"]    │  │
            │  │ embedding_id: (FK)      │  │
            │  │ ttl_seconds: 86400      │  │
            │  └─────────────────────────┘  │
            └──────────────────────────────┘
                       ▲
                       │
            ┌──────────┴──────────┐
            │   memory_search     │  ◀── if BANYANCODE_EMBEDDING_MODEL is set
            │   (semantic + tag)  │      else: keyword match + degraded: true
            └─────────────────────┘
```

## Tools

### `memory_store`

```ts
{ input: {
    key: string,
    value: unknown,
    context?: string,        // free-form: "User's preferred test runner"
    tags?: string[],         // for filtering
    scope?: "global" | "session",  // default: "global"
    sessionID?: string,      // required when scope = "session"
    ttlSeconds?: number,     // optional; default: no expiry
  },
  output: { id: string, createdAt: number } }
```

### `memory_recall`

```ts
{ input: { key: string, scope?: "global" | "session", sessionID?: string },
  output: { entry: MemoryEntry | null } }
```

### `memory_list`

```ts
{ input: { prefix?: string, tags?: string[], scope?: "global" | "session", sessionID?: string, limit?: number },
  output: { entries: MemoryEntry[] } }
```

### `memory_forget`

```ts
{ input: { key: string, scope?: "global" | "session", sessionID?: string },
  output: { ok: boolean } }
```

### `memory_search`

```ts
{ input: { query: string, limit?: number, scope?: "global" | "session", sessionID?: string },
  output: { entries: MemoryEntry[], degraded: boolean } }
```

## Embedding provider

`packages/core/src/effect/embedding-provider.ts` reads `BANYANCODE_EMBEDDING_MODEL` and constructs an AI-SDK embedding model on demand. Examples:

- `openai/text-embedding-3-small` → `openai.embedding("text-embedding-3-small")` (requires `OPENAI_API_KEY`)
- `cohere/embed-english-v3.0` → analogous (requires `COHERE_API_KEY`)
- `google/text-embedding-004` → analogous (requires `GOOGLE_GENERATIVE_AI_API_KEY`)

The provider exposes:

```ts
export class EmbeddingProvider extends Context.Service<EmbeddingProvider, {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => string | undefined  // undefined when env not set
}>()("@banyancode/EmbeddingProvider") {}
```

When `model()` returns `undefined`, `memory_search` and `code_search` use keyword match and set `degraded: true`.

## Skill

`packages/opencode/src/skill/memory/SKILL.md`:

```yaml
---
name: memory
description: Persistent, cross-session memory for BanyanCode agents. Use memory_store / memory_recall when the user explicitly asks you to remember something across sessions, or when you want to retain a long-term fact (preferences, environment quirks, prior decisions). Do NOT use memory_* for ephemeral coordination between subagents in the same session — use shared_memory instead.
---
```

## Vacuum

`MemoryRepo.vacuum()` deletes rows where `expires_at < now()`. It runs:

- At the start of every `memory_store` (best-effort, capped at 100 rows per call).
- Via the CLI subcommand `bun cli banyan memory vacuum`.

## Acceptance criteria (from the master plan)

- `memory.test.ts` round-trips 100 entries, exercises `scope: "session"` and `scope: "global"`, asserts `ttlSeconds` expiry via the `vacuum` repo call.
- `memory_search` returns the correct top-1 result when `BANYANCODE_EMBEDDING_MODEL` is set; returns a keyword-match result and `degraded: true` when the env var is unset.
- The `memory` skill is listed in `~/.config/opencode/skills/memory/SKILL.md` after `bun dev` discovers it.

## Open question (deferred)

- Should `memory_store` enforce a per-key schema (e.g. JSON Schema in a `key` field)? Useful for typed reads but adds friction. **No, defer to a later phase.**
- Should `memory_recall` access bump `access_count` and `last_accessed_at`? **Yes, every recall.**
