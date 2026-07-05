import { Context } from "effect"

export const WorktreeContext = Context.Reference<string | undefined>("@banyancode/worktree-context", {
  defaultValue: () => undefined,
})