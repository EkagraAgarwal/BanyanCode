---
name: memory
description: Persistent, cross-session memory for BanyanCode agents. Use memory_store / memory_recall when the user explicitly asks you to remember something across sessions, or when you want to retain a long-term fact (preferences, environment quirks, prior decisions). Do NOT use memory_* for ephemeral coordination between subagents in the same session — use shared_memory instead.
---