// Narrow port over the generated v2 Promise client. The engine depends on this
// interface only, so unit tests drive a fake port and the production adapter is
// the single place that knows the wire shapes.
//
// Location scoping: v2 resolves a request's location from
// `x-opencode-directory` (or a `location[directory]` query) and falls back to
// the SERVER process cwd. A background service runs in $HOME, so every call
// for a task must carry that task's directory. The adapter learns each
// session's directory from create/get/list and attaches the header per call;
// event subscriptions are opened per discovered directory because the event
// stream is location-filtered too.

import { OpenCode } from "@opencode/client"
import type {
  FileDiffInfo,
  FormInfo,
  OpenCodeClient,
  PermissionRequest,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client"
import { mapEvent, type EngineEvent, type RawEvent } from "./events"

export type { PermissionRequest } from "@opencode/client"

export type SessionSummary = {
  id: string
  parentID?: string
  title?: string
  metadata: Record<string, string>
  agent?: string
  model?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  location?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  created: number
  updated: number
}

export type MessageSummary = {
  id: string
  type: string
  role?: string
  text?: string
  created: number
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  tools?: Array<{ name: string; input: Record<string, unknown> }>
}

export type MessagePage = { items: MessageSummary[]; next?: string }

export type FormSummary = {
  id: string
  sessionID: string
  title: string
  kind?: string
  fields: Array<{ key: string; title?: string; type: string }>
}

export type SessionPort = {
  createSession(input: {
    title?: string
    parentID?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    permissions?: ReadonlyArray<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
    directory?: string
  }): Promise<{ id: string }>
  updateMetadata(input: { sessionID: string; metadata: Record<string, string> }): Promise<void>
  prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }): Promise<void>
  interrupt(input: { sessionID: string }): Promise<void>
  getSession(input: { sessionID: string }): Promise<SessionSummary | undefined>
  activeSessionIDs(): Promise<Set<string>>
  listSessions(input?: { limit?: number }): Promise<SessionSummary[]>
  messagePage(input: { sessionID: string; limit?: number; order?: "asc" | "desc"; cursor?: string }): Promise<MessagePage>
  log(input: { sessionID: string; after?: number }): Promise<RawEvent[]>
  diff(input: { sessionID: string }): Promise<FileDiffInfo[]>
  permissions(input: { sessionID: string }): Promise<PermissionRequest[]>
  replyPermission(input: {
    sessionID: string
    requestID: string
    decision: "once" | "always" | "reject"
    message?: string
  }): Promise<void>
  forms(input: { sessionID: string }): Promise<FormSummary[]>
  formFields(input: { sessionID: string; formID: string }): Promise<{ title: string; fields: FormSummary["fields"] }>
  replyForm(input: {
    sessionID: string
    formID: string
    answer: Record<string, string | number | boolean | string[]>
  }): Promise<void>
  cancelForm(input: { sessionID: string; formID: string; message?: string }): Promise<void>
  projects(): Promise<Array<{ id: string; canonical: string }>>
  createWorktree(input: { projectID: string; name?: string }): Promise<{ directory: string }>
  removeWorktree(input: { projectID: string; directory: string; force: boolean }): Promise<void>
  subscribeEvents(handler: (event: EngineEvent) => void, signal?: AbortSignal): () => void
  /** Closes any open event subscriptions. Optional so fakes stay tiny. */
  dispose?(): void
}

const toStringMetadata = (metadata: unknown): Record<string, string> => {
  const record = metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) if (typeof value === "string") out[key] = value
  return out
}

const toTokens = (tokens: unknown): MessageSummary["tokens"] => {
  const value = tokens !== null && typeof tokens === "object" ? (tokens as Record<string, unknown>) : {}
  const cache = value["cache"] !== null && typeof value["cache"] === "object" ? (value["cache"] as Record<string, unknown>) : {}
  return {
    input: typeof value["input"] === "number" ? value["input"] : 0,
    output: typeof value["output"] === "number" ? value["output"] : 0,
    reasoning: typeof value["reasoning"] === "number" ? value["reasoning"] : 0,
    cacheRead: typeof cache["read"] === "number" ? cache["read"] : 0,
    cacheWrite: typeof cache["write"] === "number" ? cache["write"] : 0,
  }
}

const toSummary = (info: SessionInfo): SessionSummary => {
  const summary: SessionSummary = {
    id: info.id,
    metadata: toStringMetadata(info.metadata),
    cost: typeof info.cost === "number" ? info.cost : 0,
    tokens: {
      input: info.tokens?.input ?? 0,
      output: info.tokens?.output ?? 0,
      reasoning: info.tokens?.reasoning ?? 0,
    },
    created: info.time?.created ?? 0,
    updated: info.time?.updated ?? 0,
  }
  if (info.parentID !== undefined) summary.parentID = info.parentID
  if (info.title !== undefined) summary.title = info.title
  if (info.agent !== undefined) summary.agent = info.agent
  if (info.model !== undefined) summary.model = `${info.model.providerID}/${info.model.id}`
  if (info.location?.directory !== undefined) summary.location = info.location.directory
  if (info.outcome !== undefined) summary.outcome = info.outcome
  return summary
}

const toMessage = (info: SessionMessageInfo): MessageSummary => {
  const message: MessageSummary = {
    id: info.id,
    type: info.type,
    created: info.time?.created ?? 0,
  }
  if (info.type === "user" || info.type === "synthetic" || info.type === "system") {
    message.text = info.text
    message.role = info.type === "user" ? "user" : info.type
    return message
  }
  if (info.type !== "assistant") return message
  message.role = "assistant"
  const tools: Array<{ name: string; input: Record<string, unknown> }> = []
  const texts: string[] = []
  for (const part of info.content) {
    if (part.type === "text") texts.push(part.text)
    if (part.type !== "tool") continue
    const state = part.state as { input?: unknown }
    const input =
      state.input !== null && typeof state.input === "object" && !Array.isArray(state.input)
        ? (state.input as Record<string, unknown>)
        : {}
    tools.push({ name: part.name, input })
  }
  if (texts.length > 0) message.text = texts.join("\n")
  if (tools.length > 0) message.tools = tools
  if (typeof info.cost === "number") message.cost = info.cost
  if (info.tokens !== undefined) message.tokens = toTokens(info.tokens)
  return message
}

const toForm = (info: FormInfo): FormSummary => {
  const summary: FormSummary = {
    id: info.id,
    sessionID: info.sessionID,
    title: info.title,
    fields: info.fields.map((field) => ({
      key: field.key,
      type: field.type,
      ...("title" in field && field.title !== undefined ? { title: field.title } : {}),
    })),
  }
  const metadata = info.metadata
  if (metadata !== null && typeof metadata === "object" && "kind" in metadata) {
    const kind = (metadata as Record<string, unknown>)["kind"]
    if (typeof kind === "string") summary.kind = kind
  }
  return summary
}

export type V2PortOptions = {
  baseUrl: string
  headers?: Record<string, string>
  /** Default directory for sessions whose location is not known yet. */
  root?: string
  clientName?: string
}

export function makeClient(options: V2PortOptions): OpenCodeClient {
  return OpenCode.make({
    baseUrl: options.baseUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  })
}

const directoryHeader = (directory: string): Record<string, string> => ({
  "x-opencode-directory": encodeURIComponent(directory),
})

export type SessionPortOptions = {
  baseUrl: string
  headers?: Record<string, string>
  /** Directory for sessions whose location is not known yet. */
  root?: string
}

export function createSessionPort(options: SessionPortOptions): SessionPort {
  const root = options.root
  // Client per directory: the generated client bakes headers at construction,
  // and every location-scoped route needs this request's directory. The
  // background service's cwd is $HOME, so the root header is not optional.
  const directoryClients = new Map<string, OpenCodeClient>()
  const build = (directory: string | undefined): OpenCodeClient =>
    makeClient({
      baseUrl: options.baseUrl,
      headers: { ...(options.headers ?? {}), ...(directory !== undefined ? directoryHeader(directory) : {}) },
    })
  directoryClients.set(root ?? "", build(root))
  const clientFor = (directory: string | undefined): OpenCodeClient => {
    const key = directory ?? root ?? ""
    const existing = directoryClients.get(key)
    if (existing !== undefined) return existing
    const created = build(key === "" ? undefined : key)
    directoryClients.set(key, created)
    return created
  }
  const directories = new Map<string, string>()
  const learn = (sessionID: string, directory: string | undefined): void => {
    if (directory === undefined || directory === "") return
    directories.set(sessionID, directory)
    // A worktree task lives in its own location; its asks and status only
    // arrive on a stream scoped to that directory.
    queueSubscribe(directory)
  }
  const directoryOf = (sessionID: string): string | undefined => directories.get(sessionID)
  const client_ = (sessionID: string): OpenCodeClient => clientFor(directoryOf(sessionID))

  // One subscription per location. The first uses the provided client (which
  // may already carry the caller's headers); later locations get their own.
  const subscribers = new Set<(event: EngineEvent) => void>()
  const openSubscriptions = new Map<string, () => void>()
  const pendingLocations = new Set<string>()
  const queueSubscribe = (directory: string | undefined): void => {
    const key = directory ?? root ?? ""
    if (openSubscriptions.has(key) || pendingLocations.has(key)) return
    pendingLocations.add(key)
  }
  const subscribeLocation = (directory: string | undefined): void => {
    const key = directory ?? root ?? ""
    if (openSubscriptions.has(key)) return
    const controller = new AbortController()
    const locationClient = clientFor(directory)
    void (async () => {
      try {
        for await (const raw of locationClient.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return
          const mapped = mapEvent(raw as unknown as RawEvent)
          if (mapped === undefined) continue
          for (const handler of subscribers) handler(mapped)
        }
      } catch {
        // A dropped stream is recovered by the engine's sweep.
      }
    })()
    openSubscriptions.set(key, () => controller.abort())
  }
  // The root subscription opens with the first subscriber (the engine), so a
  // `doctor` run or a tool-less server never holds an event stream open.
  queueSubscribe(root)

  return {
    async createSession(input) {
      const response = await clientFor(input.directory ?? root).session.create({
        title: input.title ?? null,
        parentID: input.parentID ?? null,
        metadata: input.metadata,
        agent: input.agent ?? null,
        model: input.model !== undefined ? parseModel(input.model) : null,
        location: input.directory !== undefined ? { directory: input.directory } : null,
        permissions: input.permissions ?? null,
      })
      learn(response.id, input.directory ?? response.location?.directory)
      return { id: response.id }
    },
    async updateMetadata(input) {
      const locationClient = client_(input.sessionID)
      const info = await locationClient.session.get({ sessionID: input.sessionID })
      learn(input.sessionID, info.location?.directory)
      // session.update replaces metadata wholesale: merge first.
      const merged = { ...toStringMetadata(info.metadata), ...input.metadata }
      await locationClient.session.update({ sessionID: input.sessionID, metadata: merged })
    },
    async prompt(input) {
      await client_(input.sessionID).session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        delivery: input.delivery ?? null,
        resume: input.resume ?? null,
      })
    },
    async interrupt(input) {
      await client_(input.sessionID).session.interrupt({ sessionID: input.sessionID, resume: false })
    },
    async getSession(input) {
      try {
        const summary = toSummary(await client_(input.sessionID).session.get({ sessionID: input.sessionID }))
        learn(input.sessionID, summary.location)
        return summary
      } catch {
        return undefined
      }
    },
    async activeSessionIDs() {
      const active = await clientFor(root).session.active()
      return new Set(Object.keys(active))
    },
    async listSessions(input) {
      const response = await clientFor(root).session.list({ limit: input?.limit ?? 200, order: "desc" })
      const summaries = response.data.map(toSummary)
      for (const summary of summaries) learn(summary.id, summary.location)
      return summaries
    },
    async messagePage(input) {
      // Do not default `order` here: the server rejects a cursor combined
      // with an explicit order, and paging hands us a cursor.
      const response = await client_(input.sessionID).message.list({
        sessionID: input.sessionID,
        limit: input.limit ?? 50,
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      })
      const page: MessagePage = { items: response.data.map(toMessage) }
      const next = response.cursor?.next
      if (typeof next === "string" && next !== "") page.next = next
      return page
    },
    async log(input) {
      const events: RawEvent[] = []
      const stream = client_(input.sessionID).experimental.session.log({
        sessionID: input.sessionID,
        ...(input.after !== undefined ? { after: input.after } : {}),
        follow: false,
      })
      for await (const item of stream) events.push(item as unknown as RawEvent)
      return events
    },
    async diff(input) {
      return client_(input.sessionID).session.diff({ sessionID: input.sessionID })
    },
    async permissions(input) {
      return client_(input.sessionID).permission.list({ sessionID: input.sessionID })
    },
    async replyPermission(input) {
      await client_(input.sessionID).permission.reply({
        sessionID: input.sessionID,
        requestID: input.requestID,
        decision: input.decision,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
    },
    async forms(input) {
      const list = await client_(input.sessionID).session.form.list({ sessionID: input.sessionID })
      return list.map(toForm)
    },
    async formFields(input) {
      const detail = await client_(input.sessionID).session.form.get({
        sessionID: input.sessionID,
        formID: input.formID,
      })
      return {
        title: detail.title,
        fields: detail.fields.map((field) => ({
          key: field.key,
          type: field.type,
          ...("title" in field && field.title !== undefined ? { title: field.title } : {}),
        })),
      }
    },
    async replyForm(input) {
      await client_(input.sessionID).session.form.reply({
        sessionID: input.sessionID,
        formID: input.formID,
        answer: input.answer,
      })
    },
    async cancelForm(input) {
      await client_(input.sessionID).session.form.cancel({
        sessionID: input.sessionID,
        formID: input.formID,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
    },
    async projects() {
      const list = await clientFor(root).project.list()
      return list.map((project) => ({ id: project.id, canonical: project.canonical }))
    },
    async createWorktree(input) {
      const created = await clientFor(root).worktree.create({
        projectID: input.projectID,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      return { directory: created.directory }
    },
    async removeWorktree(input) {
      await clientFor(root).worktree.remove({
        projectID: input.projectID,
        directory: input.directory,
        force: input.force,
      })
    },
    subscribeEvents(handler, signal) {
      subscribers.add(handler)
      // Opening after the handler is registered cannot drop the first frames.
      for (const directory of [...pendingLocations]) {
        pendingLocations.delete(directory)
        subscribeLocation(directory === "" ? undefined : directory)
      }
      const onAbort = (): void => {
        subscribers.delete(handler)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted === true) subscribers.delete(handler)
      return () => {
        subscribers.delete(handler)
        signal?.removeEventListener("abort", onAbort)
      }
    },
    dispose() {
      for (const close of openSubscriptions.values()) close()
      openSubscriptions.clear()
      subscribers.clear()
      pendingLocations.clear()
    },
  }
}

// "provider/model" or "provider/model#variant".
export function parseModel(model: string): { providerID: string; id: string; variant?: string } {
  const [head, variant] = model.split("#", 2)
  const slash = (head ?? "").indexOf("/")
  if (slash <= 0 || slash === (head ?? "").length - 1) {
    throw new Error(`model must be "provider/model" (optionally "provider/model#variant"), got "${model}"`)
  }
  return {
    providerID: (head ?? "").slice(0, slash),
    id: (head ?? "").slice(slash + 1),
    ...(variant !== undefined && variant !== "" ? { variant } : {}),
  }
}

export * as SessionClient from "./session-client"
