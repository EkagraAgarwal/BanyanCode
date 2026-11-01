import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { CodegraphLive } from "../../data/live"
import { CodegraphProgress } from "../status/codegraph-progress"
import { palette } from "../../theme"

export const HOME_STRIP_MIN_WIDTH = 60
export const HOME_STRIP_FULL_WIDTH = 84

interface QuickAction {
  readonly label: string
  readonly command: string
  readonly fullOnly?: boolean
}

/** v1 home tips, trimmed to the surfaces v2 actually ships. */
export const HOME_TIPS: readonly string[] = [
  "Codegraph: Type /codegraph-build to index your code. Swarm: /swarm toggles fan-out waves.",
  "YOLO: /yolo auto-approves tool calls. Toggle it off before risky edits.",
  "Agents: /agent-model sets a model per agent; /thinking sets its reasoning variant.",
  "Subagents: /max-subagents sets the 1-20 concurrent limit; /agent-tree steers or kills one.",
]

const ACTIONS: readonly QuickAction[] = [
  { label: "/codegraph-build", command: "codegraph.build" },
  { label: "/agent-model", command: "agent.model" },
  { label: "/yolo", command: "yolo.toggle" },
  { label: "/swarm", command: "swarm.toggle" },
  { label: "/max-subagents", command: "subagents.max_subagents", fullOnly: true },
]

/**
 * v1 home injected a codegraph tip under the prompt and mounted the progress
 * overlay at the bottom of the logo column. v2 has no home-specific slot for
 * either, so this strip appends below the host home footer: it never changes
 * the host row, and it disappears entirely at narrow widths/heights.
 */
export function HomeStrip(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const visible = createMemo(() => dimensions().width >= HOME_STRIP_MIN_WIDTH && dimensions().height >= 16)
  const full = createMemo(() => dimensions().width >= HOME_STRIP_FULL_WIDTH)
  // v1 rotated a tip per home mount; keep that without a timer so a hidden
  // strip costs nothing.
  const tip = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!

  return (
    <Show when={visible()}>
      <box
        width="100%"
        flexDirection="column"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={dimensions().height < 20 ? 0 : 1}
      >
        <CodegraphProgress context={props.context} codegraph={props.codegraph} idleHint />
        <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
          <text fg={theme().warning}>● Tip</text>
          <text fg={theme().muted}>{tip}</text>
        </box>
        <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
          <For each={ACTIONS.filter((action) => full() || action.fullOnly !== true)}>
            {(action) => (
              <text fg={theme().primary} onMouseUp={() => props.context.keymap.dispatch(action.command)}>
                {action.label}
              </text>
            )}
          </For>
          <Show when={!full()}>
            <text fg={theme().muted}>ctrl+p for all BanyanCode actions</text>
          </Show>
        </box>
      </box>
    </Show>
  )
}
