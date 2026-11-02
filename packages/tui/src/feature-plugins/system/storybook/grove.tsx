import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createMemo, createSignal } from "solid-js"
import { Grove, type MeshLive } from "@banyancode/tui/grove"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

type FixtureState = "running" | "waiting" | "done" | "failed"

interface FixtureTool {
  readonly name: string
  readonly args: string
  readonly status: "running" | "completed" | "error"
}

interface FixtureAgent {
  readonly id: string
  readonly agent: string
  readonly title: string
  readonly state: FixtureState
  readonly tokens: number
  readonly cost: number
  readonly tools: readonly FixtureTool[]
  readonly output: readonly string[]
  readonly summary?: string
  readonly nested?: readonly string[]
}

const FIXTURE: readonly FixtureAgent[] = [
  {
    id: "fixture-explore",
    agent: "explore",
    title: "Trace how the installer resolves binaries",
    state: "running",
    tokens: 81_000,
    cost: 0.02,
    tools: [
      { name: "code_find", args: "resolvePlatformPackage", status: "completed" },
      { name: "read", args: "postinstall.mjs", status: "completed" },
      { name: "grep", args: "optionalDependencies", status: "running" },
    ],
    output: ["tracing callers through the installer", "two candidates share a package name"],
    nested: ["scout"],
  },
  {
    id: "fixture-scout",
    agent: "scout",
    title: "Check the npm fallback on Windows",
    state: "waiting",
    tokens: 61_000,
    cost: 0.01,
    tools: [{ name: "read", args: "postinstall.mjs", status: "completed" }],
    output: [],
  },
  {
    id: "fixture-coder",
    agent: "coder",
    title: "Add version check and working fallback",
    state: "done",
    tokens: 96_000,
    cost: 0.04,
    tools: [
      { name: "edit", args: "postinstall.mjs", status: "completed" },
      { name: "verify", args: "typecheck", status: "completed" },
    ],
    output: [],
    summary: "patched, 214 tests pass",
  },
  {
    id: "fixture-general",
    agent: "general",
    title: "Try the alternate registry",
    state: "failed",
    tokens: 12_000,
    cost: 0.01,
    tools: [{ name: "bash", args: "npm view", status: "error" }],
    output: [],
  },
]

const EXTRA = Array.from({ length: 16 }, (_, index): FixtureAgent => ({
  id: `fixture-extra-${index}`,
  agent: index % 2 === 0 ? "explore" : "coder",
  title: `Parallel branch ${index + 1}`,
  state: "running",
  tokens: 20_000 + index * 1_000,
  cost: 0.01,
  tools: [{ name: "read", args: `packages/file-${index}.ts`, status: "completed" }],
  output: ["reading the next module", "collecting call sites"],
}))

const tokens = (total: number) => ({ input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function messages(agent: FixtureAgent): SessionMessageInfo[] {
  const body = agent.tools.map((tool, index) => ({
    type: "tool" as const,
    id: `${agent.id}-tool-${index}`,
    name: tool.name,
    state:
      tool.status === "completed"
        ? { status: "completed" as const, input: { filePath: tool.args }, content: [{ type: "text" as const, text: "" }] }
        : tool.status === "running"
          ? { status: "running" as const, input: { filePath: tool.args }, metadata: {} }
          : {
              status: "error" as const,
              input: { filePath: tool.args },
              error: { type: "fixture", message: "failed" },
            },
    time: { created: 1_000 + index, ...(tool.status === "completed" ? { completed: 1_100 + index } : {}) },
  }))
  const text = [...agent.output, ...(agent.summary === undefined ? [] : [agent.summary])]
  if (text.length > 0) body.push({ type: "text" as const, text: text.join("\n") } as never)
  return [
    { id: `${agent.id}-user`, type: "user", time: { created: Date.now() - 40_000 }, text: "fixture prompt" },
    {
      id: `${agent.id}-assistant`,
      type: "assistant",
      time: {
        created: Date.now() - 39_000,
        ...(agent.state === "done" || agent.state === "failed" ? { completed: Date.now() - 5_000 } : {}),
      },
      agent: agent.agent,
      model: { providerID: "fixture", id: "deepseek-v4.1-flash" },
      content: body,
    } as unknown as SessionMessageInfo,
  ]
}

function GroveStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [agents, setAgents] = createSignal<FixtureAgent[]>(FIXTURE.map((agent) => ({ ...agent })))
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set(["fixture-scout"]))
  const [killed, setKilled] = createSignal<ReadonlySet<string>>(new Set())
  const [animations, setAnimations] = createSignal(true)
  const [status, setStatus] = createSignal("mixed states · spawn, finish, wait and kill")

  const sessions = createMemo<SessionInfo[]>(() => [
    {
      id: "fixture-root",
      projectID: "fixture",
      agent: "build",
      title: "orchestrate the installer fix",
      cost: 0,
      tokens: tokens(0),
      time: { created: 900, updated: 2_000 },
      location: { directory: "" },
    } as SessionInfo,
    ...agents().map(
      (agent) =>
        ({
          id: agent.id,
          parentID: "fixture-root",
          projectID: "fixture",
          agent: agent.agent,
          title: agent.title,
          cost: agent.cost,
          tokens: tokens(agent.tokens),
          model: { providerID: "fixture", id: "deepseek-v4.1-flash" },
          time: { created: 1_000, updated: 2_000 },
          location: { directory: "" },
        }) as SessionInfo,
    ),
    ...agents()
      .filter((agent) => agent.nested !== undefined)
      .flatMap((agent) =>
        (agent.nested ?? []).map(
          (name, index) =>
            ({
              id: `${agent.id}-nested-${index}`,
              parentID: agent.id,
              projectID: "fixture",
              agent: name,
              title: "read the manifest",
              cost: 0,
              tokens: tokens(2_000),
              time: { created: 1_100, updated: 2_000 },
              location: { directory: "" },
            }) as SessionInfo,
        ),
      ),
  ])
  const sessionByID = (id: string) => sessions().find((session) => session.id === id)
  const messagesByID = createMemo(() => {
    const map = new Map<string, SessionMessageInfo[]>()
    for (const agent of agents()) map.set(agent.id, messages(agent))
    return map
  })

  const mesh = createMemo<MeshLive>(() => {
    const root = {
      sessionID: "fixture-root",
      agent: "build",
      title: "orchestrate the installer fix",
      state: "running" as const,
      cost: 0,
      tokens: tokens(0),
      createdAt: 900,
      updatedAt: Date.now(),
      children: agents().map((agent) => ({
        sessionID: agent.id,
        agent: agent.agent,
        title: agent.title,
        state:
          agent.state === "running" || agent.state === "waiting"
            ? ("running" as const)
            : agent.state === "failed"
              ? ("failed" as const)
              : ("idle" as const),
        cost: agent.cost,
        tokens: tokens(agent.tokens),
        createdAt: 1_000,
        updatedAt: Date.now(),
        children: (agent.nested ?? []).map((name, index) => ({
          sessionID: `${agent.id}-nested-${index}`,
          agent: name,
          title: "read the manifest",
          state: "running" as const,
          cost: 0,
          tokens: tokens(2_000),
          createdAt: 1_100,
          updatedAt: Date.now(),
          children: [],
        })),
      })),
    }
    return {
      availability: () => "available",
      error: () => undefined,
      root: () => root,
      ensure: async () => {},
      limits: () => ({
        maxSubagents: 20,
        backgroundSubagents: true,
        swarmMode: false,
        maxSubagentsLimit: 20,
        maxSubagentsDefault: 5,
      }),
      swarmMode: () => false,
      killed,
      refreshLimits: async () => {},
      setLimits: async () => ({
        ok: true,
        value: { maxSubagents: 20, backgroundSubagents: true, swarmMode: false, maxSubagentsLimit: 20, maxSubagentsDefault: 5 },
      }),
      steer: async (input) => {
        setStatus(`steer sent to ${input.targetAgent}`)
        return { ok: true, value: { delivered: 1 } }
      },
      kill: async (input) => {
        if (input.targetSessionID) setKilled((current) => new Set([...current, input.targetSessionID!]))
        setStatus(`killed ${input.targetSessionID ?? "agent"}`)
        return { ok: true, value: { killed: 1 } }
      },
    }
  })

  const context = createMemo(
    () =>
      ({
        ...props.context,
        ui: {
          ...props.context.ui,
          animations: () => animations(),
          router: {
            ...props.context.ui.router,
            navigate: (destination: unknown) => {
              setStatus(`open ${JSON.stringify(destination)}`)
            },
          },
        },
        data: {
          ...props.context.data,
          session: {
            ...props.context.data.session,
            list: () => sessions(),
            get: sessionByID,
            root: () => "fixture-root",
            family: () => sessions().map((session) => session.id),
            cost: (id: string) => sessionByID(id)?.cost ?? 0,
            status: (id: string) => (sessionByID(id)?.parentID === undefined ? "running" : "running"),
            message: { ...props.context.data.session.message, list: (id: string) => messagesByID().get(id) ?? [] },
            permission: {
              ...props.context.data.session.permission,
              list: (id: string) => (pending().has(id) ? ([{ id: "fixture-permission" }] as never) : []),
            },
            form: { ...props.context.data.session.form, list: () => [] },
          },
        },
      }) as Plugin.Context,
  )

  const reset = () => {
    batch(() => {
      setAgents(FIXTURE.map((agent) => ({ ...agent })))
      setPending(new Set(["fixture-scout"]))
      setKilled(new Set<string>())
      setAnimations(true)
      setStatus("mixed states · spawn, finish, wait and kill")
    })
  }
  const spawn = () => {
    if (agents().length >= 20) {
      setStatus("20 agents is the cap; finish or reset first")
      return
    }
    const next = EXTRA[agents().length - FIXTURE.length] ?? EXTRA[0]!
    setAgents([...agents(), { ...next, id: `${next.id}-${agents().length}` }])
    setStatus(`spawned ${next.agent}; watch the branch grow`)
  }
  const finish = () => {
    setAgents(agents().map((agent) => (agent.state === "running" || agent.state === "waiting" ? { ...agent, state: "done" } : agent)))
    setStatus("finished every running agent; the return pulses dim the panes")
  }
  const toggleWaiting = () => {
    const target = agents()[1]?.id ?? agents()[0]?.id
    if (target === undefined) return
    setPending((current) => {
      const next = new Set(current)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
    setStatus(`permission on ${target} ${pending().has(target) ? "cleared" : "pending"}; the pane breathes amber`)
  }
  const killFirst = () => {
    const target = agents().find((agent) => agent.state === "running")
    if (target === undefined) {
      setStatus("no running agent to kill")
      return
    }
    setKilled((current) => new Set([...current, target.id]))
    setStatus(`killed ${target.agent}; it must keep the error colour`)
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "n", title: "Spawn an agent", group: "Storybook", run: spawn },
      { bind: "f", title: "Finish running agents", group: "Storybook", run: finish },
      { bind: "w", title: "Toggle a pending permission", group: "Storybook", run: toggleWaiting },
      { bind: "x", title: "Kill a running agent", group: "Storybook", run: killFirst },
      { bind: "m", title: "Toggle animations", group: "Storybook", run: () => setAnimations((value) => !value) },
      { bind: "r", title: "Reset the grove", group: "Storybook", run: reset },
    ],
  }))

  const summary = createMemo(() => {
    const count = (state: FixtureState) => agents().filter((agent) => agent.state === state).length
    return `${agents().length} agents · ${count("running")} running · ${count("waiting")} waiting · ${count("done")} done · ${count("failed")} failed`
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.base}
    >
      <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={0}>
        <Grove context={context()} sessionID="fixture-root" mesh={mesh()} width={dimensions().width - 2} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / grove"
        details={[animations() ? "animated" : "still", `${dimensions().width}×${dimensions().height}`]}
        status={summary()}
        message={status()}
        controls={[
          { shortcut: "n", label: "spawn" },
          { shortcut: "f", label: "finish" },
          { shortcut: "w", label: "waiting" },
          { shortcut: "x", label: "kill" },
          { shortcut: "m", label: "motion" },
          { shortcut: "r", label: "reset" },
          { shortcut: "resize", label: "pane grid" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const groveStory: Story = {
  id: "grove",
  title: "Grove",
  render: (context) => <GroveStory context={context} />,
}
