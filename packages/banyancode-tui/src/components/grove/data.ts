import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import type { MeshNode } from "../../data/pending-rpc"
import { directChildren, type ChildState, type MeshChild } from "../../data/mesh"
import { currentTool, latestOutput, returnedSummary, toolHistory, type ToolCall } from "../../data/messages"

/** One level of nested subagents, shown indented inside their parent's pane. */
export interface GroveNested {
  readonly sessionID: string
  readonly agent: string
  readonly title?: string | undefined
  readonly state: ChildState
  readonly tokens: number
}

/** Everything one pane shows, built from the mesh and the child's messages. */
export interface GrovePaneView {
  readonly sessionID: string
  readonly session?: SessionInfo | undefined
  readonly agent: string
  readonly title?: string | undefined
  readonly model?: string | undefined
  readonly state: ChildState
  readonly killed: boolean
  readonly pending: number
  readonly cost: number
  readonly tokens: number
  readonly createdAt: number
  readonly tools: readonly ToolCall[]
  readonly current?: ToolCall | undefined
  readonly running: number
  readonly output: readonly string[]
  readonly summary?: string | undefined
  /** When the child's run started, for the footer's elapsed time. */
  readonly runStartedAt?: number | undefined
  /** When it finished; absent while it runs. */
  readonly runEndedAt?: number | undefined
  readonly nested: readonly GroveNested[]
}

/**
 * Direct children of `sessionID`, in the shape a pane renders. Call inside a
 * `createMemo`: `message.list`, permissions and the mesh are all reactive.
 */
export function buildGrovePanes(input: {
  readonly context: Context
  readonly root: MeshNode | undefined
  readonly sessionID: string
  readonly killed: ReadonlySet<string>
}): GrovePaneView[] {
  return directChildren({
    context: input.context,
    sessionID: input.sessionID,
    root: input.root,
    killed: input.killed,
  }).map((child) => paneView({ ...input, child }))
}

function paneView(input: {
  readonly context: Context
  readonly root: MeshNode | undefined
  readonly killed: ReadonlySet<string>
  readonly child: MeshChild
}): GrovePaneView {
  const session = input.context.data.session.get(input.child.sessionID)
  const messages = input.context.data.session.message.list(input.child.sessionID)
  const tools = toolHistory(messages)
  const finished = input.child.state === "running" || input.child.state === "waiting"
  const runStartedAt =
    messages.findLast((message) => message.type === "user")?.time.created ??
    messages.findLast((message) => message.type === "assistant")?.time.created
  const runEndedAt =
    finished
      ? undefined
      : (messages.findLast((message) => message.type === "assistant")?.time.completed ??
        input.child.lastActivityAt ??
        runStartedAt)
  return {
    sessionID: input.child.sessionID,
    session,
    agent: input.child.agent,
    title: input.child.title ?? session?.title,
    model: modelName(session),
    state: input.child.state,
    killed: input.killed.has(input.child.sessionID),
    pending: input.child.pending,
    cost: input.child.cost,
    tokens: input.child.tokens,
    createdAt: input.child.createdAt,
    tools,
    current: currentTool(messages),
    running: tools.filter((tool) => tool.status === "running").length,
    output: finished ? latestOutput(messages, 4) : [],
    summary: finished ? undefined : returnedSummary(messages, 120),
    runStartedAt,
    runEndedAt,
    nested: directChildren({
      context: input.context,
      sessionID: input.child.sessionID,
      root: input.root,
      killed: input.killed,
    }).map((child) => ({
      sessionID: child.sessionID,
      agent: child.agent,
      title: child.title,
      state: child.state,
      tokens: child.tokens,
    })),
  }
}

/** `provider/model` collapses to the model id the frames show. */
function modelName(session: SessionInfo | undefined): string | undefined {
  const id = session?.model?.id
  if (id === undefined || id === "") return undefined
  return id.split("/").at(-1) ?? id
}

/** The one-line state summary under the root agent. */
export function groveSummary(panes: readonly { readonly state: ChildState }[]): string {
  if (panes.length === 0) return "no branches yet"
  const count = (state: ChildState) => panes.filter((pane) => pane.state === state).length
  const running = count("running")
  const waiting = count("waiting")
  const failed = count("failed")
  const parts = [
    running > 0 ? `${running} branch${running === 1 ? "" : "es"} growing` : undefined,
    waiting > 0 ? `${waiting} waiting on you` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
  ].flatMap((part) => (part === undefined ? [] : [part]))
  if (parts.length > 0) return parts.join(" · ")
  return "all branches returned"
}

/** The root agent named above the trunk. */
export function groveRootAgent(session: SessionInfo | undefined): string {
  return session?.agent ?? "orchestrator"
}
