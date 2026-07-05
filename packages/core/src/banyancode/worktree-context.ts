import { Context, Effect } from "effect"

export const WorktreeContext = Context.Reference<() => Effect.Effect<string | undefined>>(
  "@banyancode/worktree-context",
  { defaultValue: () => () => Effect.succeed<string | undefined>(undefined) },
)