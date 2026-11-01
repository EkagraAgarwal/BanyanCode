import type { BuildState } from "../rpc"
import { dim, Style } from "../ui"

/**
 * v1 `formatState` (`packages/opencode/src/cli/cmd/codegraph.ts`), byte for
 * byte: same 20-cell bar, same fields, same colours.
 */
export const formatState = (state: BuildState) => {
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5))
  const file = state.currentFile ? dim("  " + state.currentFile) : ""
  const result = state.result
    ? dim(
        `  (indexed ${state.result.indexed}, skipped ${state.result.skipped}, ${(state.result.duration_ms / 1000).toFixed(1)}s)`,
      )
    : ""
  const err = state.error ? `  ${Style.TEXT_DANGER}error: ${state.error}${Style.TEXT_NORMAL}` : ""
  return `[${bar}] ${state.done}/${state.total}  ${state.status}${file}${result}${err}`
}
