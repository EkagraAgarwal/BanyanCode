import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { TrunkSurface, type MeshLive, type MeshNode } from "@banyancode/tui/trunk"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

/**
 * The **B · Trunk** rail on fixture mesh data. The rail, its branches, its
 * spinner and its `+N more` row are the production components; only the mesh
 * tree, the pending permission and the child messages come from this file.
 *
 * Nothing is scripted as progress: the states come from the same `childState`
 * rules the real rail uses, and the numbers are the fixture's own.
 */

const SESSION_ID = "ses_story_trunk"
const AGENTS = ["explore", "scout", "coder", "reviewer", "builder", "tester", "scribe"] as const
const NOW = Date.now()

type AgentState = "running" | "idle" | "failed"

function node(input: {
  readonly sessionID: string
  readonly agent: string
  readonly state: AgentState
  readonly createdAt: number
  readonly children?: readonly MeshNode[]
}): MeshNode {
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    state: input.state,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    children: input.children ?? [],
  } as MeshNode
}

function tree(input: { readonly count: number; readonly failed: boolean }): MeshNode {
  const children = Array.from({ length: input.count }, (_, index) =>
    node({
      sessionID: `${SESSION_ID}_${index}`,
      agent: AGENTS[index % AGENTS.length]!,
      state: input.failed && index === 1 ? "failed" : index === 0 ? "running" : "idle",
      // Old enough to have grown, recent enough for the finished ones to stay.
      createdAt: NOW - 3_000 + index * 100,
    }),
  )
  return node({ sessionID: SESSION_ID, agent: "build", state: "running", createdAt: NOW - 60_000, children })
}

/** One tool row and one returned summary, so a branch has a real second line. */
function messages(sessionID: string) {
  if (sessionID.endsWith("_0")) {
    return [
      {
        id: "msg_story_tool",
        type: "assistant",
        time: { created: NOW - 2_000 },
        agent: "build",
        model: { providerID: "provider", id: "model" },
        content: [
          {
            type: "tool",
            id: "tool_story",
            name: "edit",
            state: { status: "running", input: { filePath: "packages/opencode/script/postinstall.mjs" }, output: "" },
            time: { created: NOW - 1_000 },
          },
        ],
      },
    ] as never
  }
  if (sessionID.endsWith("_3")) {
    return [
      {
        id: "msg_story_text",
        type: "assistant",
        time: { created: NOW - 2_000, completed: NOW - 1_000 },
        agent: "build",
        model: { providerID: "provider", id: "model" },
        content: [{ type: "text", text: "no version comparison anywhere" }],
      },
    ] as never
  }
  return []
}

function TrunkStory(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  const [count, setCount] = createSignal(3)
  const [waiting, setWaiting] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [narrow, setNarrow] = createSignal(false)

  const mesh = createMemo<MeshLive>(() => {
    const root = tree({ count: count(), failed: failed() })
    return {
      availability: () => "available",
      error: () => undefined,
      root: (rootSessionID: string) => (rootSessionID === SESSION_ID ? root : undefined),
      ensure: async () => {},
      limits: () => undefined,
      swarmMode: () => false,
      killed: () => new Set(failed() ? [`${SESSION_ID}_1`] : []),
      refreshLimits: async () => {},
      setLimits: async () => ({
        ok: true,
        value: {
          maxSubagents: 20,
          backgroundSubagents: true,
          swarmMode: false,
          maxSubagentsLimit: 20,
          maxSubagentsDefault: 5,
        },
      }),
      steer: async () => ({ ok: true, value: { delivered: 0 } }),
      kill: async () => ({ ok: true, value: { killed: 0 } }),
    }
  })

  // The rail reads the mesh tree, the session status and pending permissions
  // from the host context. The fixture supplies those three answers for its own
  // session id and leaves everything else to the real context.
  const context = createMemo<Plugin.Context>(() => {
    const waitingID = `${SESSION_ID}_2`
    const session = props.context.data.session
    return {
      ...props.context,
      data: {
        ...props.context.data,
        session: {
          ...session,
          root: (id: string) => (id.startsWith(SESSION_ID) ? SESSION_ID : session.root(id)),
          status: (id: string) => (id.startsWith(SESSION_ID) ? "running" : session.status(id)),
          message: { ...session.message, list: (id: string) => (id.startsWith(SESSION_ID) ? messages(id) : session.message.list(id)) },
          permission: {
            ...session.permission,
            list: (id: string) => (waiting() && id === waitingID ? ([{ id: "per_story" }] as never) : []),
          },
        },
      },
    } as Plugin.Context
  })

  const width = () => (narrow() ? 100 : dimensions().width)

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "1", title: "Two agents", group: "Storybook", run: () => setCount(2) },
      { bind: "2", title: "Five agents", group: "Storybook", run: () => setCount(5) },
      { bind: "3", title: "Twelve agents", group: "Storybook", run: () => setCount(12) },
      { bind: "4", title: "Twenty agents", group: "Storybook", run: () => setCount(20) },
      { bind: "w", title: "Waiting agent", group: "Storybook", run: () => setWaiting((value) => !value) },
      { bind: "f", title: "Failed agent", group: "Storybook", run: () => setFailed((value) => !value) },
      { bind: "n", title: "Narrow terminals", group: "Storybook", run: () => setNarrow((value) => !value) },
      {
        bind: "r",
        title: "Reset fixture",
        group: "Storybook",
        run: () => {
          setCount(3)
          setWaiting(false)
          setFailed(false)
          setNarrow(false)
        },
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.base}
    >
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <TrunkSurface
          context={context()}
          sessionID={SESSION_ID}
          mesh={mesh()}
          terminalWidth={width()}
          terminalHeight={Math.max(4, dimensions().height - 4)}
        />
      </box>
      <StoryFooter
        context={props.context}
        title="trunk"
        details={[`${count()} agents${narrow() ? " · narrow" : ""}`, waiting() ? "waiting" : "no attention"]}
        controls={[
          { shortcut: "1-4", label: "agent count" },
          { shortcut: "w", label: "waiting" },
          { shortcut: "f", label: "failed" },
          { shortcut: "n", label: "narrow" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "storybook" },
        ]}
      />
    </box>
  )
}

export const trunkStory: Story = {
  id: "trunk",
  title: "Trunk rail",
  render: (context) => <TrunkStory context={context} />,
}
