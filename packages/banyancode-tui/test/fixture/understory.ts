import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createSignal } from "solid-js"
import type { MeshLive } from "../../src/data/live"
import type { MeshNode } from "../../src/data/pending-rpc"
import type { UnderstoryState } from "../../src/data/understory"
import { context, meshLive, meshNode, session } from "../harness"

export interface UnderstoryTool {
  readonly name: string
  readonly args?: string
  readonly status: "running" | "completed" | "error" | "pending"
}

export interface UnderstorySpec {
  readonly id: string
  readonly agent?: string
  readonly title?: string
  readonly state?: UnderstoryState
  readonly tokens?: number
  readonly cost?: number
  readonly created?: number
  readonly model?: string
  readonly parentID?: string
  readonly killed?: boolean
  readonly idle?: number
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly pending?: number
  readonly question?: boolean
  readonly truncated?: boolean
  readonly tools?: readonly UnderstoryTool[]
  readonly output?: readonly string[]
  readonly summary?: string
}

const tokens = (total: number) => ({ input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function meshState(state: UnderstoryState): MeshNode["state"] {
  if (state === "retry") return "retry"
  if (state === "failed" || state === "killed") return "failed"
  if (state === "done" || state === "idle") return "idle"
  return "running"
}

function toolPart(spec: UnderstorySpec, tool: UnderstoryTool, index: number): SessionMessageInfo {
  const input = tool.args === undefined ? {} : { filePath: tool.args, command: tool.args }
  const state =
    tool.status === "completed"
      ? { status: "completed" as const, input, content: [{ type: "text" as const, text: "" }], metadata: {} }
      : tool.status === "running"
        ? { status: "running" as const, input, metadata: {} }
        : tool.status === "error"
          ? {
              status: "error" as const,
              input,
              error: { type: "test", message: "failed" },
              content: [{ type: "text" as const, text: "" }],
            }
          : { status: "streaming" as const, input: tool.args ?? "" }
  return {
    type: "tool",
    id: `${spec.id}_tool_${index}`,
    name: tool.name,
    state,
    time: {
      created: (spec.created ?? 1_000) + index,
      ...(tool.status === "completed" || tool.status === "error" ? { completed: (spec.created ?? 1_000) + index + 20 } : {}),
    },
  } as unknown as SessionMessageInfo
}

function messages(spec: UnderstorySpec): SessionMessageInfo[] {
  const state = spec.state ?? "done"
  const base = spec.created ?? 1_000
  const content: unknown[] = (spec.tools ?? []).map((tool, index) => toolPart(spec, tool, index))
  const text = [...(spec.output ?? []), ...(spec.summary === undefined ? [] : [spec.summary])].join("\n")
  if (text !== "") content.push({ type: "text" as const, text })
  if (state === "blocked" && content.length === 0) {
    content.push({
      type: "tool" as const,
      id: `${spec.id}_spawn`,
      name: "subagent",
      state: { status: "running" as const, input: { agent: "coder" }, metadata: {} },
      time: { created: base + 5 },
    })
  }
  const settled = state === "done" || state === "failed" || state === "killed"
  const heading: SessionMessageInfo[] = spec.truncated === true
    ? [
        {
          id: `${spec.id}_early`,
          type: "assistant",
          time: { created: base - 5, ...(settled ? { completed: base - 4 } : {}) },
          agent: spec.agent ?? "explore",
          model: { providerID: "provider", id: spec.model ?? "deepseek-v4.1-flash" },
          content: [{ type: "text" as const, text: "earlier output" }],
        } as unknown as SessionMessageInfo,
      ]
    : [{ id: `${spec.id}_user`, type: "user", time: { created: base }, text: "do the thing" } as unknown as SessionMessageInfo]
  return [
    ...heading,
    {
      id: `${spec.id}_assistant`,
      type: "assistant",
      time: { created: base + 10, ...(settled ? { completed: 9_000 } : {}) },
      agent: spec.agent ?? "explore",
      model: { providerID: "provider", id: spec.model ?? "deepseek-v4.1-flash" },
      content,
    } as unknown as SessionMessageInfo,
  ]
}

export interface RecordedPermissionReply {
  readonly sessionID: string
  readonly requestID: string
  readonly decision: "once" | "always" | "reject"
}

export interface UnderstoryFixture {
  readonly context: Context
  readonly mesh: MeshLive
  readonly sessions: readonly SessionInfo[]
  readonly messages: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly layers: Array<{ readonly mode?: string; readonly priority?: number; readonly commands?: readonly KeymapCommand[] }>
  readonly navigated: unknown[]
  readonly dispatched: string[]
  readonly replies: RecordedPermissionReply[]
  readonly steers: unknown[]
  readonly kills: unknown[]
  readonly press: (title: string) => boolean
  readonly setMode: (mode: string) => void
  readonly pending: (sessionID: string, count: number) => void
  readonly append: (sessionID: string, message: SessionMessageInfo) => void
}

/**
 * A real-shaped fixture: sessions, messages, mesh nodes and permission/form
 * stores. No renderer here; tests mount the screen themselves.
 */
export function understoryFixture(input: {
  readonly specs?: readonly UnderstorySpec[]
  readonly root?: Partial<UnderstorySpec>
  readonly animations?: boolean
  /** The mesh branch limit, so the roster header can show `n/limit`. */
  readonly limit?: number
  /** False keeps the root session free of messages, for the empty stream state. */
  readonly rootMessages?: boolean
} = {}): UnderstoryFixture {
  const rootSpec: UnderstorySpec = {
    id: "ses_root",
    agent: "build",
    title: "orchestrate the installer fix",
    state: "running",
    created: 900,
    ...input.root,
  }
  const specs = [rootSpec, ...(input.specs ?? [])]
  const sessions: SessionInfo[] = []
  const record: Record<string, readonly SessionMessageInfo[]> = {}
  const nodes = new Map<string, MeshNode>()

  for (const spec of specs) {
    const settled = spec.state === "done" || spec.state === "failed" || spec.state === "killed"
    const parentID = spec.id === "ses_root" ? undefined : (spec.parentID ?? "ses_root")
    sessions.push(
      session({
        id: spec.id,
        ...(parentID === undefined ? {} : { parentID }),
        agent: spec.agent ?? (spec.id === "ses_root" ? "build" : "explore"),
        title: spec.title,
        cost: spec.cost ?? 0,
        tokens: tokens(spec.tokens ?? 0),
        model: { providerID: "provider", id: spec.model ?? "deepseek-v4.1-flash" },
        time: {
          created: spec.created ?? 1_000,
          updated: 9_500,
          ...(spec.id === "ses_root" ? { busy: spec.created ?? 1_000 } : {}),
          ...(spec.idle !== undefined ? { idle: spec.idle } : settled ? { idle: 9_000 } : {}),
        },
        ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
      }),
    )
    record[spec.id] = spec.id === "ses_root" && input.rootMessages === false ? [] : messages(spec)
  }

  const build = (spec: UnderstorySpec): MeshNode =>
    meshNode({
      sessionID: spec.id,
      agent: spec.agent ?? (spec.id === "ses_root" ? "build" : "explore"),
      title: spec.title,
      state: meshState(spec.state ?? "done"),
      cost: spec.cost ?? 0,
      tokens: tokens(spec.tokens ?? 0),
      createdAt: spec.created ?? 1_000,
      children: specs
        .filter((child) => (child.id === "ses_root" ? false : (child.parentID ?? "ses_root") === spec.id))
        .map(build),
    })
  for (const spec of specs) nodes.set(spec.id, build(spec))

  const [pending, setPending] = createSignal<Readonly<Record<string, number>>>(
    Object.fromEntries(specs.flatMap((spec) => (spec.pending === undefined || spec.pending === 0 ? [] : [[spec.id, spec.pending]]))),
  )
  const [messageStore, setMessageStore] = createSignal<Readonly<Record<string, readonly SessionMessageInfo[]>>>(record)
  const questions = new Set(specs.filter((spec) => spec.question === true).map((spec) => spec.id))
  const replies: RecordedPermissionReply[] = []
  const navigated: unknown[] = []
  const dispatched: string[] = []
  const steers: unknown[] = []
  const kills: unknown[] = []
  const layers: UnderstoryFixture["layers"] = []
  let mode = "banyancode.panel"
  const modes: string[] = []

  const base = context({
    sessions,
    messages: record,
    animations: input.animations ?? false,
  })
  const value = {
    ...base,
    client: {
      ...base.client,
      permission: {
        reply: async (replyInput: RecordedPermissionReply) => {
          replies.push(replyInput)
          setPending({ ...pending(), [replyInput.sessionID]: 0 })
        },
      },
    },
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: (sessionID: string) =>
            Array.from({ length: pending()[sessionID] ?? 0 }, (_, index) => ({
              id: `perm_${sessionID}_${index}`,
              sessionID,
              action: "bash",
              resources: ["npm pack --dry-run"],
            })),
        },
        form: {
          ...base.data.session.form,
          list: (sessionID: string) =>
            questions.has(sessionID) ? [{ id: `form_${sessionID}`, title: "Which registry?" }] : [],
        },
        message: {
          ...base.data.session.message,
          list: (sessionID: string) => [...(messageStore()[sessionID] ?? [])],
        },
      },
    },
    keymap: {
      ...base.keymap,
      layer: (factory: () => KeymapLayer) => {
        layers.push(factory())
      },
      dispatch: (id: string) => dispatched.push(id),
      mode: {
        current: () => mode,
        push: (next: string) => {
          modes.push(next)
          mode = next
          return () => {
            modes.pop()
            mode = modes.at(-1) ?? "base"
          }
        },
      },
    },
    ui: {
      ...base.ui,
      router: { ...base.ui.router, navigate: (destination: unknown) => navigated.push(destination) },
      dialog: {
        ...base.ui.dialog,
        prompt: async () => "keep going",
        confirm: async () => true,
      },
    },
  } as unknown as Context

  const mesh: MeshLive = {
    ...meshLive({
      root: nodes.get("ses_root"),
      killed: specs.filter((spec) => spec.killed || spec.state === "killed").map((spec) => spec.id),
      ...(input.limit === undefined ? {} : { maxSubagents: input.limit }),
    }),
    steer: async (steerInput) => {
      steers.push(steerInput)
      return { ok: true as const, value: { delivered: 1 } }
    },
    kill: async (killInput) => {
      kills.push(killInput)
      return { ok: true as const, value: { killed: 1 } }
    },
  }

  const press = (title: string): boolean => {
    const active = [...layers].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    for (const layer of active) {
      if (layer.mode !== undefined && layer.mode !== "global" && layer.mode !== mode) continue
      for (const command of layer.commands ?? []) {
        if (command.title !== title) continue
        if (command.enabled === false) continue
        if (typeof command.enabled === "function" && !command.enabled()) continue
        command.run()
        return true
      }
    }
    return false
  }

  return {
    context: value,
    mesh,
    sessions,
    messages: record,
    layers,
    navigated,
    dispatched,
    replies,
    steers,
    kills,
    press,
    setMode: (next: string) => {
      mode = next
      modes.length = 0
      modes.push(next)
    },
    pending: (sessionID: string, count: number) => setPending({ ...pending(), [sessionID]: count }),
    append: (sessionID: string, message: SessionMessageInfo) =>
      setMessageStore({ ...messageStore(), [sessionID]: [...(messageStore()[sessionID] ?? []), message] }),
  }
}

/** Timers a test can drive, for the kill arm's three seconds and action messages. */
export function fakeTimers(start = 12_000) {
  let clock = start
  let next = 1
  const due = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => clock,
    setTimeout: ((fn: () => void, ms = 0) => {
      const id = next++
      due.set(id, { at: clock + Math.max(0, ms), run: fn })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: unknown) => {
      due.delete(Number(handle))
    }) as unknown as typeof clearTimeout,
    advance(ms: number) {
      clock += ms
      for (const [id, entry] of [...due]) {
        if (entry.at > clock) continue
        due.delete(id)
        entry.run()
      }
    },
    count: () => due.size,
  }
}

/** The shared ticker's clock: one interval, advanced by tests. */
export function tickerClock() {
  const timers = new Map<number, () => void>()
  let next = 1
  let clock = 0
  return {
    now: () => clock,
    options: {
      now: () => clock,
      setInterval: ((fn: () => void) => {
        const id = next++
        timers.set(id, fn)
        return id as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: ((id: unknown) => {
        timers.delete(Number(id))
      }) as unknown as typeof clearInterval,
    },
    tick(ms: number) {
      clock += ms
      for (const fn of [...timers.values()]) fn()
    },
    live: () => timers.size,
  }
}
